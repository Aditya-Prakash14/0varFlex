// src/renderer/workbench/common/editor/textEditorInput.ts — the text file input: reads a file
// through the FileIO channel, holds its model via the code editor service, tracks dirty
// transitions and saves back through the same channel.
//
// delta vs the real text file stack (workbench/services/textfile + workingCopy): no working
// copies, no autoSave, no encoding/BOM detection, no hot-exit backups. Save is one write.

import { IDisposable } from '../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../common/base/common/uri.js';
import type { IFileService } from '../../../../common/platform/files/common/files.js';
import { TextModel } from '../../../../common/editor/common/model/textModel.js';
import { CodeEditorService } from '../../services/editor/browser/codeEditorService.js';
import { EditorInput } from './editorInput.js';
import type { EditorPane } from './editorPane.js';

export const TEXT_EDITOR_TYPE_ID = 'workbench.editors.textEditorInput';

/** basename with trailing-slash safety — ported in spirit from base/common/labels.ts */
export function basename(path: string): string {
	if (!path) {
		return '';
	}
	const withoutTrailing = path.replace(/[\\/]+$/, '');
	if (!withoutTrailing) {
		return '/';
	}
	const index = Math.max(withoutTrailing.lastIndexOf('/'), withoutTrailing.lastIndexOf('\\'));
	return index >= 0 ? withoutTrailing.substring(index + 1) : withoutTrailing;
}

/** the group supplies this; it creates the pane for a group asking for the input */
export type TextEditorPaneFactory = (input: TextEditorInput, model: TextModel) => EditorPane;

export class TextEditorInput extends EditorInput {

	/** mutable for 10's rename remap; everything else treats it as identity */
	resource: URI;

	private _model: TextModel | null = null;
	private _modelListener: IDisposable | null = null;
	private _lastDirty = false;

	constructor(
		resource: URI,
		private readonly _fileService: IFileService,
		private readonly _codeEditorService: CodeEditorService,
		private readonly _paneFactory: TextEditorPaneFactory
	) {
		super();
		this.resource = resource;
		this._register({ dispose: () => this._modelListener?.dispose() });
	}

	/** 10: renames re-point the input at the new resource (the model object is kept) */
	updateResource(resource: URI): void {
		this.resource = resource;
	}

	getTypeId(): string {
		return TEXT_EDITOR_TYPE_ID;
	}

	getName(): string {
		return basename(this.resource.fsPath);
	}

	getResource(): URI {
		return this.resource;
	}

	/** the model once loaded (before resolve this may be undefined) */
	getModel(): TextModel | undefined {
		return this._model ?? undefined;
	}

	override isDirty(): boolean {
		return this._model?.isModified() ?? false;
	}

	/** load the model (once) and hand out a pane for the asking group */
	override async resolve(): Promise<EditorPane> {
		const model = await this._ensureModel();
		return this._paneFactory(this, model);
	}

	private async _ensureModel(): Promise<TextModel> {
		if (this._model) {
			return this._model;
		}
		// a model may already exist (a sibling input opened it, or a dev-created one)
		const existing = this._codeEditorService.findModel(this.resource);
		if (existing) {
			this._model = existing;
		} else {
			let text: string;
			try {
				text = await this._fileService.readFile(this.resource);
			} catch (error) {
				throw new Error(`Unable to open ${this.resource.fsPath}: ${(error as Error).message}`);
			}
			this._model = this._codeEditorService.createModel(this.resource, text);
		}
		this._lastDirty = this.isDirty();
		this._modelListener = this._model.onDidChangeContent(() => this._refreshDirty());
		return this._model;
	}

	/** dirty transitions only — the tab dots depend on the event being transition-shaped */
	private _refreshDirty(): void {
		const dirty = this.isDirty();
		if (dirty !== this._lastDirty) {
			this._lastDirty = dirty;
			this.fireDirtyChanged();
		}
	}

	override async save(): Promise<boolean> {
		const model = await this._ensureModel();
		// the current typing run must become closable BEFORE the save anchors it, or undoing one
		// keystroke after save would leave the model dirty (07's edit stack contract)
		model.pushStackElement();
		const text = model.getValue();
		// atomic: write a temp sibling, fsync, rename over the target (10's disk provider)
		await this._fileService.writeFile(this.resource, text, { atomic: true });
		model.setSavedVersionId();
		this._refreshDirty();
		return true;
	}

	/**
	 * "Don't Save" / reload: the model is reset to the disk content and its history cleared
	 * (real revert releases the working copy and providers — the simple value reset is the
	 * course's accepted delta).
	 */
	override async revert(): Promise<void> {
		let text: string;
		try {
			text = await this._fileService.readFile(this.resource);
		} catch {
			return; // deleted on disk: nothing to revert to (10 keeps the buffer + strikethrough)
		}
		const model = await this._ensureModel();
		model.revertTo(text);
		this._refreshDirty();
	}
}
