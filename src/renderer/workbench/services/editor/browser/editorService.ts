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
import { FileChangeType, FileChangesEvent, normalizeFileResource, type IFileService } from '../../../../../common/platform/files/common/files.js';
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
	readonly onDidOpenEditor: Event<EditorInput> = this._onDidOpenEditor.event;
	/** 10: a dirty editor's file changed on disk (the workbench shows the status warning) */
	private readonly _onDidInputNeedsAttention = this._register(new Emitter<{ readonly input: EditorInput; readonly reason: 'modified-on-disk' }>());
	readonly onDidInputNeedsAttention: Event<{ readonly input: EditorInput; readonly reason: 'modified-on-disk' }> = this._onDidInputNeedsAttention.event;

	/** inputs whose backing file was deleted on disk (tabs show the strikethrough) */
	private readonly _deletedInputs = new Set<EditorInput>();	constructor(
		private readonly _part: EditorPart,
		private readonly _codeEditorService: CodeEditorService,
		private readonly _fileService: IFileService,
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
		resource = normalizeFileResource(resource);
		const key = resource.toString();
		let input = this._inputs.get(key);
		if (!input) {
			input = new TextEditorInput(
				resource,
				this._fileService,
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
		let opened = false;
		try {
			opened = await target.openEditor(input, { focus: open.options?.focus });
		} catch (error) {
			// 10: the file may be gone (deleted externally) — log instead of crashing the caller
			this._logService.error(`cannot open ${input.getResource()?.fsPath ?? input.getName()}: ${(error as Error).message}`);
			return false;
		}
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

	// ---- 10: external changes (the explorer's watcher consumer calls this per batch)

	handleFileChanges(event: FileChangesEvent): void {
		for (const change of event.changes) {
			const input = this._inputs.get(change.resource.toString());
			if (!input) {
				continue;
			}
			if (change.type === FileChangeType.DELETED) {
				this._setDeleted(input, true);
				continue;
			}
			if (change.type === FileChangeType.UPDATED) {
				void this._reloadFromDisk(input, false);
			}
		}
	}

	private _setDeleted(input: EditorInput, deleted: boolean): void {
		if (deleted === this._deletedInputs.has(input)) {
			return;
		}
		if (deleted) {
			this._deletedInputs.add(input);
		} else {
			this._deletedInputs.delete(input);
		}
		for (const group of this._part.groups) {
			group.setEditorDeleted(input, deleted);
		}
	}

	isDeleted(input: EditorInput): boolean {
		return this._deletedInputs.has(input);
	}

	/**
	 * The clean editor reloads silently; a dirty one gets the status warning (click → reload,
	 * discarding the buffer — the real workbench keeps your version and offers a compare; the
	 * delta is noted in the README).
	 */
	private async _reloadFromDisk(input: TextEditorInput, force: boolean): Promise<void> {
		const model = input.getModel();
		if (!model) {
			return;
		}
		const text = await this._fileService.readFile(input.resource).then(text => text, () => null);
		if (text === null) {
			this._setDeleted(input, true);
			return;
		}
		this._setDeleted(input, false);
		if (text === model.getValue()) {
			return; // identical content (this is also how our own saves stay quiet)
		}
		if (!force && input.isDirty()) {
			this._onDidInputNeedsAttention.fire({ input, reason: 'modified-on-disk' });
			return;
		}
		this._applyReload(input, text);
	}

	/** reload, preserving every pane's cursor and scroll (08's view state) */
	private _applyReload(input: TextEditorInput, text: string): void {
		const model = input.getModel();
		if (!model) {
			return;
		}
		let applied = false;
		for (const group of this._part.groups) {
			if (!group.contains(input)) {
				continue;
			}
			const pane = group.getPane(input);
			const state = pane?.saveViewState() ?? null;
			model.revertTo(text);
			if (pane && state) {
				pane.restoreViewState(state);
			}
			applied = true;
		}
		if (!applied) {
			model.revertTo(text);
		}
	}

	/** the status warning's click: reload even though the buffer is dirty */
	async forceReload(input: TextEditorInput): Promise<void> {
		await this._reloadFromDisk(input, true);
	}

	/** 10: rename remap — the input and its model follow the resource, panes keep working */
	remapResource(oldResource: URI, newResource: URI): void {
		const input = this._inputs.get(oldResource.toString());
		if (!input) {
			return;
		}
		this._inputs.delete(oldResource.toString());
		this._inputs.set(newResource.toString(), input);
		this._codeEditorService.moveModel(oldResource, newResource);
		input.updateResource(newResource);
		for (const group of this._part.groups) {
			if (group.contains(input)) {
				group.updateEditor(input);
			}
		}
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
		const saved = await input.save();
		if (saved) {
			this._setDeleted(input, false); // saving re-created a deleted file
		}
		return saved;
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
