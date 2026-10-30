// src/renderer/workbench/common/editor/textEditorInput.ts — the text file input: reads a file
// through the FileIO channel, holds its model via the code editor service, tracks dirty
// transitions and saves back through the same channel.
//
// delta vs the real text file stack (workbench/services/textfile + workingCopy): no working
// copies, no autoSave, no encoding/BOM detection, no hot-exit backups. Save is one write.

import { IDisposable } from '../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../common/base/common/uri.js';
import type { IFileIOChannel } from '../../../../common/platform/fileIO/common/fileIO.js';
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

	private _model: TextModel | null = null;
	private _modelListener: IDisposable | null = null;
	private _lastDirty = false;

	constructor(
		readonly resource: URI,
		private readonly _fileIO: IFileIOChannel,
		private readonly _codeEditorService: CodeEditorService,
		private readonly _paneFactory: TextEditorPaneFactory
	) {
		super();
		this._register({ dispose: () => this._modelListener?.dispose() });
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
			const text = await this._fileIO.readTextFile(this.resource.fsPath);
			if (text === null) {
				throw new Error(`Unable to open ${this.resource.fsPath}: file not found`);
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
		await this._fileIO.writeTextFile(this.resource.fsPath, text);
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
		const text = await this._fileIO.readTextFile(this.resource.fsPath);
		if (text === null) {
			return;
		}
		const model = await this._ensureModel();
		model.revertTo(text);
		this._refreshDirty();
	}
}
