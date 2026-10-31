// src/renderer/workbench/contrib/files/browser/explorerService.ts — the Explorer's model: the
// open folder, lazy directory loading, watcher-driven refresh and the file operations the
// commands/inline inputs run. Ported in shape from explorerService.ts + explorerModel.ts.
//
// Refresh strategy (the acceptance asks to name it): our own operations refresh through
// FileService.onDidRunOperation — immediate and deterministic — while EXTERNAL changes come
// through the coalesced watcher. Both funnel into _refreshDirectory, which compares the new
// child list and skips the re-render when nothing changed (so one `echo >>` stays one refresh
// even though the operation event and the watcher both fire for our own writes).

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { Disposable } from '../../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../../common/base/common/uri.js';
import type { ILogService } from '../../../../../common/platform/log/common/log.js';
import type { ICommandService } from '../../../../platform/commands/common/commands.js';
import { FileChangeType, FileChangesEvent, FileOperation, normalizeFileResource, IFileService } from '../../../../../common/platform/files/common/files.js';
import { EditorService } from '../../../services/editor/browser/editorService.js';
import { NEW_FILE_ID, NEW_FOLDER_ID } from './fileCommands.js';
import { ExplorerTree, IExplorerNode, IExplorerRowAction, newExplorerNode } from './tree/explorerTree.js';

/** the parent directory as a URI (path-only helper: our URIs are file://) */
export function dirnameUri(uri: URI): URI {
	const fsPath = uri.fsPath;
	const index = fsPath.lastIndexOf('/');
	return URI.file(index <= 0 ? '/' : fsPath.substring(0, index));
}

export interface IExplorerServiceServices {
	readonly fileService: IFileService;
	readonly editorService: EditorService;
	readonly logService: ILogService;
	readonly commandService: ICommandService;
}

export class ExplorerService extends Disposable {

	readonly tree: ExplorerTree;

	private readonly _onDidChangeFolder = this._register(new Emitter<URI | undefined>());
	readonly onDidChangeFolder: Event<URI | undefined> = this._onDidChangeFolder.event;
	private readonly _onDidChangeSelection = this._register(new Emitter<IExplorerNode | undefined>());
	readonly onDidChangeSelection: Event<IExplorerNode | undefined> = this._onDidChangeSelection.event;

	private _folder: URI | undefined;
	private _root: IExplorerNode | null = null;
	private readonly _watchIds: number[] = [];
	/** log line counter the acceptance reads: one refresh per batch, not per event */
	refreshCount = 0;

	constructor(container: HTMLElement, private readonly _services: IExplorerServiceServices) {
		super();
		this.tree = this._register(new ExplorerTree(container, {
			getChildren: node => this._loadChildren(node),
			openFile: node => void this.openNode(node),
			getActions: node => this._actionsFor(node)
		}));
		this._register(this.tree.onDidChangeSelection(node => this._onDidChangeSelection.fire(node)));

		// our own operations: refresh the touched directory right away
		this._register(this._services.fileService.onDidRunOperation(event => {
			if (event.operation === FileOperation.WRITE || event.operation === FileOperation.CREATE) {
				void this._refreshDirectory(dirnameUri(event.resource));
			} else if (event.operation === FileOperation.DELETE || event.operation === FileOperation.MOVE) {
				void this._refreshDirectory(dirnameUri(event.resource));
				if (event.target) {
					void this._refreshDirectory(dirnameUri(event.target));
				}
			}
		}));
	}

	// ---- folder

	get folder(): URI | undefined {
		return this._folder;
	}

	get root(): IExplorerNode | null {
		return this._root;
	}

	async setFolder(uri: URI | undefined): Promise<void> {
		for (const watchId of this._watchIds) {
			void this._services.fileService.unwatch(watchId);
		}
		this._watchIds.length = 0;

		// one canonical spelling for every path under the folder (see normalizeFileResource)
		this._folder = uri ? normalizeFileResource(uri) : undefined;
		this._root = null;
		uri = this._folder;

		if (!uri) {
			this.tree.setRoot(null);
			this._onDidChangeFolder.fire(undefined);
			return;
		}

		const stat = await this._services.fileService.resolve(uri).then(stat => stat, error => {
			this._services.logService.warn(`cannot open folder ${uri.fsPath}: ${(error as Error).message}`);
			return null;
		});
		if (!stat) {
			this.tree.setRoot(null);
			this._onDidChangeFolder.fire(undefined);
			return;
		}

		const root = newExplorerNode(uri, stat.name, true);
		root.expanded = true;
		root.children = (await this._loadChildren(root)) ?? [];
		this._root = root;
		this.tree.setRoot(root);

		try {
			this._watchIds.push(await this._services.fileService.watch(uri, { recursive: true }));
		} catch (error) {
			this._services.logService.warn(`cannot watch folder ${uri.fsPath}: ${(error as Error).message}`);
		}
		this._onDidChangeFolder.fire(uri);
	}

	// ---- tree data

	private async _loadChildren(node: IExplorerNode): Promise<IExplorerNode[] | null> {
		const stat = await this._services.fileService.resolve(node.resource, { resolveMetadata: true }).then(stat => stat, error => {
			this._services.logService.warn(`cannot read ${node.resource.fsPath}: ${(error as Error).message}`);
			return null;
		});
		if (!stat?.children) {
			return null;
		}
		const children = stat.children.map(child => newExplorerNode(child.resource, child.name, child.isDirectory));
		// folders first, then case-insensitive name order
		children.sort((a, b) => a.isDirectory === b.isDirectory
			? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
			: (a.isDirectory ? -1 : 1));
		// keep expand state of children that were already loaded
		for (const child of children) {
			const previous = node.children?.find(candidate => candidate.resource.toString() === child.resource.toString());
			if (previous?.expanded) {
				child.expanded = true;
				child.children = previous.children;
			}
		}
		return children;
	}

	async refreshAll(): Promise<void> {
		if (!this._root) {
			return;
		}
		await this._refreshDirectory(this._root.resource);
	}

	// ---- watcher / operation events

	handleFileChanges(event: FileChangesEvent): void {
		const directories = new Set<string>();
		for (const change of event.changes) {
			if (this._folder && change.resource.toString() === this._folder.toString() && change.type === FileChangeType.DELETED) {
				void this.setFolder(undefined);
				continue;
			}
			directories.add(dirnameUri(change.resource).toString());
		}
		for (const directory of directories) {
			void this._refreshDirectory(URI.parse(directory));
		}
	}

	private async _refreshDirectory(directory: URI): Promise<void> {
		const node = this._root ? this.tree.findNode(directory) : null;
		if (!node?.isDirectory || !node.expanded) {
			return;
		}
		// the counter the acceptance reads: one re-read per batch, not per raw event
		this.refreshCount++;
		const children = await this._loadChildren(node);
		if (!children) {
			return;
		}
		const before = (node.children ?? []).map(child => child.name).join('\n');
		const after = children.map(child => child.name).join('\n');
		node.children = children;
		if (before === after) {
			return; // nothing visually changed: no re-render (the operation+watcher dedupe)
		}
		this.tree.render();
	}

	// ---- selection helpers

	get selection(): IExplorerNode | undefined {
		return this.tree.selection;
	}

	/** where new files/folders go: the selected folder, the selected file's parent, else the root */
	getTargetNode(): IExplorerNode | null {
		const selection = this.tree.selection;
		if (!selection) {
			return this._root;
		}
		return selection.isDirectory ? selection : (this._root ? this.tree.findNode(dirnameUri(selection.resource)) : null);
	}

	select(resource: URI): void {
		const node = this.tree.findNode(resource);
		if (node) {
			this.tree.setSelection(node);
		}
	}

	// ---- operations (the commands and inline inputs call these)

	async createFile(parentDirectory: URI, name: string): Promise<void> {
		const resource = URI.joinPath(parentDirectory, name);
		await this._services.fileService.writeFile(resource, '', { overwrite: false, atomic: false });
		this.select(resource);
	}

	async createFolder(parentDirectory: URI, name: string): Promise<void> {
		const resource = URI.joinPath(parentDirectory, name);
		await this._services.fileService.createFolder(resource);
		this.select(resource);
	}

	async rename(node: IExplorerNode, newName: string): Promise<URI> {
		const target = URI.joinPath(dirnameUri(node.resource), newName);
		await this._services.fileService.move(node.resource, target, false);
		return target;
	}

	async delete(node: IExplorerNode, useTrash: boolean): Promise<void> {
		await this._services.fileService.del(node.resource, { useTrash });
	}

	async openNode(node: IExplorerNode): Promise<void> {
		if (node.isDirectory) {
			await this.tree.toggle(node);
			return;
		}
		await this._services.editorService.openEditor({ resource: node.resource });
	}

	private _actionsFor(node: IExplorerNode): readonly IExplorerRowAction[] {
		if (!node.isDirectory) {
			return [];
		}
		// hover actions invoke the real commands with the node as the argument
		return [
			{
				id: 'newFile', label: 'New File',
				icon: '<svg viewBox="0 0 16 16"><path d="M9 1H4.5a1 1 0 00-1 1v12a1 1 0 001 1h7a1 1 0 001-1V4.5L9 1zM8.5 4.5V2l3 3h-3z"/></svg>',
				run: () => void this._services.commandService.executeCommand(NEW_FILE_ID, node)
			},
			{
				id: 'newFolder', label: 'New Folder',
				icon: '<svg viewBox="0 0 16 16"><path d="M1.5 3a1 1 0 011-1h3.6l1.4 1.5h6a1 1 0 011 1V12a1 1 0 01-1 1h-11a1 1 0 01-1-1V3z"/></svg>',
				run: () => void this._services.commandService.executeCommand(NEW_FOLDER_ID, node)
			},
			{
				id: 'refresh', label: 'Refresh',
				icon: '<svg viewBox="0 0 16 16"><path d="M8 3a5 5 0 104.6 7h-1.7A3.4 3.4 0 118 4.6c.9 0 1.7.3 2.3.9L8.8 7H13V2.8l-1.6 1.6A5 5 0 008 3z"/></svg>',
				run: () => void this._refreshDirectory(node.resource)
			}
		];
	}
}
