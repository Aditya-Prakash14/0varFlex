// src/renderer/workbench/browser/parts/editor/editorActions.ts — the editor commands with real
// IDs and real mac defaults (read from editorActions.ts/fileCommands.ts in the reference):
//
//   save               workbench.action.files.save          cmd+S
//   close              workbench.action.closeActiveEditor   cmd+W
//   split              workbench.action.splitEditor         cmd+\
//   next               workbench.action.nextEditor          cmd+alt+→  (secondary cmd+shift+])
//   previous           workbench.action.previousEditor      cmd+alt+←  (secondary cmd+shift+[)
//
// plus the dev "Open Sample File" seed (task 9's first real open path; the CLI argv seed rides
// the window channel).

import { Disposable, IDisposable, toDisposable } from '../../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../../common/base/common/uri.js';
import type { IFileService } from '../../../../../common/platform/files/common/files.js';
import { CommandMetadata, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { KeyCode, KeyMod } from '../../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { EditorPart } from './editorPart.js';
import { EditorService } from '../../../services/editor/browser/editorService.js';

export const SAVE_FILE_ID = 'workbench.action.files.save';
export const CLOSE_EDITOR_ID = 'workbench.action.closeActiveEditor';
export const SPLIT_EDITOR_ID = 'workbench.action.splitEditor';
export const NEXT_EDITOR_ID = 'workbench.action.nextEditor';
export const PREVIOUS_EDITOR_ID = 'workbench.action.previousEditor';
export const OPEN_SAMPLE_FILE_ID = 'mini.openSampleFile';

const SAMPLE_FILE_TEXT = [
	'// mini-vscode sample — the first real file this editor opens',
	'export function greet(name: string): string {',
	'\tconst message = `hello, ${name}`;',
	'\treturn message; // try editing me',
	'}',
	'',
	'/* Open the same file twice (Cmd+\\ splits) and type here:',
	'   both panes show the same model, each keeps its own cursor. */'
].join('\n');

/** the dev/seed open path: ensure a small file exists in userData, then open it */
function registerSampleFileAction(editorService: EditorService, fileService: IFileService, userDataPath: string): void {
	const samplePath = URI.joinPath(URI.file(userDataPath), 'sample-hello.ts').fsPath;
	CommandsRegistry.registerCommand(OPEN_SAMPLE_FILE_ID, async () => {
		const sampleResource = URI.file(samplePath);
		if (!(await fileService.exists(sampleResource))) {
			await fileService.writeFile(sampleResource, SAMPLE_FILE_TEXT, { atomic: true });
		}
		await editorService.openEditor({ resource: URI.file(samplePath) });
	});
	CommandMetadata.register({
		id: OPEN_SAMPLE_FILE_ID,
		title: 'Open Sample File',
		category: 'Dev'
	});
}

export function registerEditorActions(
	editorService: EditorService,
	editorPart: EditorPart,
	fileService: IFileService,
	userDataPath: string
): IDisposable {
	const disposables: IDisposable[] = [];
	const register = (id: string, title: string, category: string, handler: () => unknown): void => {
		disposables.push(CommandsRegistry.registerCommand(id, () => handler()));
		disposables.push(CommandMetadata.register({ id, title, category }));
	};

	register(SAVE_FILE_ID, 'Save', 'File', () => editorService.saveActive());
	register(CLOSE_EDITOR_ID, 'Close Editor', 'File', async () => {
		const input = editorPart.activeGroup.activeEditor;
		if (input) {
			await editorService.closeEditor(input, editorPart.activeGroup);
		}
	});
	register(SPLIT_EDITOR_ID, 'Split Editor', 'View', () => editorService.splitEditor());
	register(NEXT_EDITOR_ID, 'Open Next Editor', 'View', () => editorPart.activeGroup.activateNext());
	register(PREVIOUS_EDITOR_ID, 'Open Previous Editor', 'View', () => editorPart.activeGroup.activatePrevious());

	registerSampleFileAction(editorService, fileService, userDataPath);

	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: SAVE_FILE_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		primary: KeyMod.CtrlCmd | KeyCode.KeyS
	}));
	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: CLOSE_EDITOR_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		primary: KeyMod.CtrlCmd | KeyCode.KeyW
	}));
	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: SPLIT_EDITOR_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		primary: KeyMod.CtrlCmd | KeyCode.Backslash
	}));
	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: NEXT_EDITOR_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		primary: KeyMod.CtrlCmd | KeyCode.PageDown,
		mac: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.RightArrow,
		secondary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.BracketRight
	}));
	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: PREVIOUS_EDITOR_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		primary: KeyMod.CtrlCmd | KeyCode.PageUp,
		mac: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.LeftArrow,
		secondary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.BracketLeft
	}));

	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
