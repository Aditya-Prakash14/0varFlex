// src/renderer/workbench/contrib/files/browser/fileCommands.ts — the Explorer's commands with
// the REAL ids and bindings (read from fileActions.contribution.ts / fileConstants.ts):
//
//   explorer.newFile            (no default binding — toolbars/palette/hover actions)
//   explorer.newFolder          (no default binding)
//   renameFile                  F2
//   deleteFile                  Delete (mac: cmd+backspace secondary)
//   workbench.files.action.refreshFilesExplorer
//   workbench.action.files.openFolder   (mac: cmd+k cmd+o; the workbench wiring picks+sets)
//   workbench.action.closeFolder
//
// Delete respects `explorer.confirmDelete` (default true) with 09's confirm dialog and the
// ported message shapes; deletions go to the trash (useTrash: true).

import { Disposable, IDisposable, toDisposable } from '../../../../../common/base/common/lifecycle.js';
import { CommandMetadata, CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { KeyChord, KeyCode, KeyMod } from '../../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import type { IConfigurationService } from '../../../../../common/platform/configuration/common/configuration.js';
import type { ILogService } from '../../../../../common/platform/log/common/log.js';
import { confirmDialog } from '../../../browser/parts/editor/dialogs/confirmDialog.js';
import type { EditorService } from '../../../services/editor/browser/editorService.js';
import { dirnameUri, ExplorerService } from './explorerService.js';
import type { IExplorerNode } from './tree/explorerTree.js';
import { validateFileName } from './inlineInput.js';

export const EXPLORER_ID = 'workbench.view.explorer';
export const NEW_FILE_ID = 'explorer.newFile';
export const NEW_FOLDER_ID = 'explorer.newFolder';
export const RENAME_ID = 'renameFile';
export const DELETE_FILE_ID = 'deleteFile';
export const REFRESH_ID = 'workbench.files.action.refreshFilesExplorer';
export const OPEN_FOLDER_ID = 'workbench.action.files.openFolder';
export const CLOSE_FOLDER_ID = 'workbench.action.closeFolder';

/** the tree has keyboard focus (the real workbench scopes these on `explorerViewletFocus`) */
export const ExplorerFocusContext = new RawContextKey<boolean>('explorerFocus', false);

export interface IFileCommandServices {
	readonly explorerService: ExplorerService;
	readonly editorService: EditorService;
	readonly commandService: ICommandService;
	readonly contextKeyService: IContextKeyService;
	readonly configuration: IConfigurationService;
	readonly logService: ILogService;
	/** provided by the workbench wiring: pick a folder and set the whole workspace up */
	readonly openFolder: () => Promise<void>;
	readonly closeFolder: () => Promise<void>;
}

export function registerFileCommands(services: IFileCommandServices): IDisposable {
	const disposables: IDisposable[] = [];
	const when = ExplorerFocusContext;
	const { explorerService } = services;
	const tree = explorerService.tree;

	const register = (id: string, title: string, category: string, handler: (...args: never[]) => unknown): void => {
		disposables.push(CommandsRegistry.registerCommand(id, (_accessor, ...args: unknown[]) => handler(...(args as never[]))));
		disposables.push(CommandMetadata.register({ id, title, category }));
	};

	const targetDirectoryNode = (argNode: unknown): IExplorerNode | null => {
		if (isExplorerNode(argNode)) {
			return argNode;
		}
		return explorerService.getTargetNode();
	};

	const showCreateInput = async (argNode: unknown, kind: 'file' | 'folder'): Promise<void> => {
		const target = targetDirectoryNode(argNode);
		if (!target) {
			return;
		}
		await tree.toggle(target, true);
		tree.showInput({
			rowIndex: tree.visibleIndexOf(target),
			depth: tree.depthOf(target) + 1,
			initialValue: '',
			placeholder: kind === 'file' ? 'Name of the new file' : 'Name of the new folder',
			validate: value => validateFileName(value, { parentChildNames: (target.children ?? []).map(child => child.name) }),
			onAccept: async value => {
				if (kind === 'file') {
					await explorerService.createFile(target.resource, value);
				} else {
					await explorerService.createFolder(target.resource, value);
				}
			},
			onCancel: () => { /* nothing to undo */ }
		});
	};

	register(NEW_FILE_ID, 'New File', 'File', (argNode: unknown) => showCreateInput(argNode, 'file'));
	register(NEW_FOLDER_ID, 'New Folder', 'File', (argNode: unknown) => showCreateInput(argNode, 'folder'));

	register(RENAME_ID, 'Rename', 'File', async (argNode: unknown) => {
		const node = isExplorerNode(argNode) ? argNode : explorerService.selection;
		if (!node || node === explorerService.root) {
			return; // the workspace root itself is not renamable
		}
		const parentNode = tree.findNode(dirnameUri(node.resource));
		tree.showInput({
			rowIndex: tree.visibleIndexOf(node),
			depth: tree.depthOf(node),
			initialValue: node.name,
			placeholder: 'New name',
			validate: value => validateFileName(value, {
				parentChildNames: (parentNode?.children ?? []).map(child => child.name),
				currentName: node.name
			}),
			onAccept: async value => {
				const oldResource = node.resource;
				const target = await explorerService.rename(node, value);
				// 10's remap pass: open editors/tabs follow the resource (real does this through
				// file-operation events on the working copy; the remap pass is the delta-lite)
				services.editorService.remapResource(oldResource, target);
				explorerService.select(target);
			}
		});
	});

	register(DELETE_FILE_ID, 'Delete', 'File', async (argNode: unknown) => {
		const node = isExplorerNode(argNode) ? argNode : explorerService.selection;
		if (!node || node === explorerService.root) {
			return;
		}
		if (services.configuration.getValue<boolean>('explorer.confirmDelete') !== false) {
			const message = node.isDirectory
				? `Are you sure you want to delete '${node.name}' and its contents?`
				: `Are you sure you want to delete '${node.name}'?`;
			const result = await confirmDialog({
				message,
				primaryLabel: 'Delete',
				secondaryLabel: null, // two-button dialog: Delete / Cancel
				cancelLabel: 'Cancel'
			});
			if (result !== 'primary') {
				return;
			}
		}
		try {
			// trash by default; the open editor tab gets its strikethrough from the watcher batch
			await explorerService.delete(node, /* useTrash */ true);
		} catch (error) {
			services.logService.warn(`delete failed: ${(error as Error).message}`);
		}
	});

	register(REFRESH_ID, 'Refresh Explorer', 'File', () => explorerService.refreshAll());
	register(OPEN_FOLDER_ID, 'Open Folder…', 'File', () => services.openFolder());
	register(CLOSE_FOLDER_ID, 'Close Folder', 'File', () => services.closeFolder());

	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: RENAME_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		when,
		primary: KeyCode.F2
	}));
	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: DELETE_FILE_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		when,
		primary: KeyCode.Delete,
		secondary: KeyMod.CtrlCmd | KeyCode.Backspace
	}));
	// the real openFolder binding on mac is the two-key chord cmd+k cmd+o
	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: OPEN_FOLDER_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		mac: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyO)
	}));

	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}

/** the ported explorer command arguments are nodes; a shape check keeps unknown args harmless */
function isExplorerNode(candidate: unknown): candidate is IExplorerNode {
	return !!candidate && typeof candidate === 'object' && typeof (candidate as IExplorerNode).isDirectory === 'boolean' && !!(candidate as IExplorerNode).resource;
}
