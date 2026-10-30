// src/renderer/workbench/services/editor/browser/editorService.ts — IEditorService's course
// subset, ported in shape from vs/workbench/services/editor/browser/editorService.ts +
// editorGroupFinder.ts:
//
//   - openEditor normalizes `input` vs `resource` (an input registry keeps one TextEditorInput
//     per resource);
//   - reuse: an input already open is revealed where it is — preferring a group where it is
//     the ACTIVE editor, in most-recently-active group order, else the active group;
//   - closeEditor runs the dirty confirmation (Save / Don't Save / Cancel) and, when the last
//     group drops the input, releases the input instance (the model dies with its refcount, so
//     reopening reads the file again — the "Don't Save reverts on reopen" behavior).

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { Disposable } from '../../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../../common/base/common/uri.js';
import type { ILogService } from '../../../../../common/platform/log/common/log.js';
import type { IFileIOChannel } from '../../../../../common/platform/fileIO/common/fileIO.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { TextEditorInput } from '../../../common/editor/textEditorInput.js';
import { EditorGroupView } from '../../../browser/parts/editor/editorGroupView.js';
import { IPaneServices, TextEditorPane } from '../../../browser/parts/editor/editorPanes.js';
import { EditorPart } from '../../../browser/parts/editor/editorPart.js';
import { confirmSaveDialog } from '../../../browser/parts/editor/dialogs/confirmDialog.js';
import { CodeEditorService } from './codeEditorService.js';

export interface IResourceEditorOpenOptions {
	readonly input?: EditorInput;
	readonly resource?: URI;
	readonly options?: {
		/** applied to the widget after activation (A1's "open at position" seed) */
		readonly selection?: { readonly lineNumber: number; readonly column: number };
		readonly focus?: boolean;
	};
}

export interface IOpenEditorsStateEntry {
	readonly id: number;
	readonly active: boolean;
	readonly editors: readonly { readonly name: string; readonly resource: string | undefined; readonly dirty: boolean }[];
}

export class EditorService extends Disposable {

	private readonly _inputs = new Map<string, TextEditorInput>();
	private readonly _mruGroups: EditorGroupView[] = [];

	private readonly _onDidOpenEditor = this._register(new Emitter<EditorInput>());
	readonly onDidOpenEditor: Event<EditorInput> = this._onDidOpenEditor.event;	constructor(
		private readonly _part: EditorPart,
		private readonly _codeEditorService: CodeEditorService,
		private readonly _fileIO: IFileIOChannel,
		private readonly _logService: ILogService,
		private readonly _paneServices: IPaneServices
	) {
		super();
		this._register(this._part.onDidActiveGroupChange(group => this._moveGroupToFront(group)));
		this._register(this._part.onDidAddGroup(group => this._moveGroupToFront(group)));
	}

	// ---- inputs

	/**
	 * seam: the real editorResolverService picks an editor type per resource (diff editors,
	 * custom editors, notebooks). Every resource is a text file here; A2's readonly diff hangs
	 * off this method.
	 */
	resolveInput(resource: URI): TextEditorInput {
		const key = resource.toString();
		let input = this._inputs.get(key);
		if (!input) {
			input = new TextEditorInput(
				resource,
				this._fileIO,
				this._codeEditorService,
				(editorInput, model) => new TextEditorPane(editorInput, this._paneServices, model)
			);
			this._inputs.set(key, input);
		}
		return input;
	}

	getInput(resource: URI): TextEditorInput | undefined {
		return this._inputs.get(resource.toString());
	}

	// ---- open

	async openEditor(open: IResourceEditorOpenOptions, group?: EditorGroupView): Promise<boolean> {
		const input = open.input ?? (open.resource ? this.resolveInput(open.resource) : undefined);
		if (!input) {
			return false;
		}
		const target = group ?? this._findTargetGroup(input);
		const opened = await target.openEditor(input, { focus: open.options?.focus });
		if (opened && open.options?.selection) {
			const pane = target.activePane;
			if (pane && 'applySelection' in pane) {
				(pane as { applySelection(selection: { lineNumber: number; column: number }): void }).applySelection(open.options.selection);
			}
		}
		if (opened) {
			this._onDidOpenEditor.fire(input);
		}
		return opened;
	}

	/** port of editorGroupFinder's reuse branch: active-in-group first, then opened, then active */
	private _findTargetGroup(input: EditorInput): EditorGroupView {
		let opened: EditorGroupView | undefined;
		for (const group of this._mruGroups) {
			if (!group.contains(input)) {
				continue;
			}
			if (group.activeEditor === input) {
				return group;
			}
			opened ??= group;
		}
		return opened ?? this._part.activeGroup;
	}

	private _moveGroupToFront(group: EditorGroupView): void {
		const index = this._mruGroups.indexOf(group);
		if (index >= 0) {
			this._mruGroups.splice(index, 1);
		}
		this._mruGroups.unshift(group);
	}

	// ---- close

	/**
	 * Close with the dirty flow. Returns false when the user cancelled; "Don't Save" leaves the
	 * disk file untouched and lets the model die with the last pane.
	 */
	async closeEditor(input: EditorInput, group?: EditorGroupView): Promise<boolean> {
		const target = group ?? this._part.findGroup(input);
		if (!target) {
			return false;
		}
		if (input.isDirty()) {
			const result = await confirmSaveDialog(input.getName());
			if (result === 'cancel') {
				return false;
			}
			if (result === 'primary') {
				const saved = await input.save();
				if (!saved) {
					return false;
				}
			}
		}
		target.closeEditor(input);
		this._dropInputIfUnused(input);
		return true;
	}

	private _dropInputIfUnused(input: EditorInput): void {
		if (this._part.findGroup(input)) {
			return;
		}
		const resource = input.getResource();
		if (resource) {
			this._inputs.delete(resource.toString());
		}
		input.dispose();
	}

	// ---- queries used by commands and the quit flow

	get activeInput(): EditorInput | null {
		return this._part.activeGroup.activeEditor;
	}

	async saveActive(): Promise<boolean> {
		const input = this.activeInput;
		if (!input || !input.isDirty()) {
			return false;
		}
		return input.save();
	}

	/** dirty editors across all groups (an input open twice counts once) */
	getDirtyInputs(): EditorInput[] {
		const seen = new Set<EditorInput>();
		const dirty: EditorInput[] = [];
		for (const group of this._part.groups) {
			for (const editor of group.editors) {
				if (editor.isDirty() && !seen.has(editor)) {
					seen.add(editor);
					dirty.push(editor);
				}
			}
		}
		return dirty;
	}

	/**
	 * The window-close flow: one dialog per dirty editor (the course skips closeAllEditors'
	 * multi-editor dialog). Returns false when the user cancelled the quit.
	 */
	async confirmCloseAllDirty(): Promise<boolean> {
		for (const input of this.getDirtyInputs()) {
			const result = await confirmSaveDialog(input.getName());
			if (result === 'cancel') {
				return false;
			}
			if (result === 'primary') {
				await input.save();
			}
			// secondary: quit without saving — the in-memory model dies with the window
		}
		return true;
	}

	// ---- split (the SplitEditorAction port)

	async splitEditor(): Promise<EditorGroupView> {
		const source = this._part.activeGroup;
		const activeInput = source.activeEditor;
		const group = this._part.addGroup();
		if (activeInput) {
			await this.openEditor({ input: activeInput, options: { focus: true } }, group);
		}
		return group;
	}

	// ---- debug view for the acceptance hook

	getState(): IOpenEditorsStateEntry[] {
		return this._part.groups.map(group => ({
			id: group.id,
			active: group === this._part.activeGroup,
			editors: group.editors.map(editor => ({
				name: editor.getName(),
				resource: editor.getResource()?.fsPath,
				dirty: editor.isDirty()
			}))
		}));
	}
}
