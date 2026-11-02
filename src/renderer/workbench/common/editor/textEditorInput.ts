// src/renderer/workbench/common/editor/textEditorInput.ts — the text file input: reads a file
// through the FileIO channel, holds its model via the code editor service, tracks dirty
// transitions and saves back through the same channel.
//
// delta vs the real text file stack (workbench/services/textfile + workingCopy): no working
// copies, no autoSave, no encoding/BOM detection, no hot-exit backups. Save is one write.

import { win32 } from '../../../../vendor/vscode/base/common/path.js';
import { IDisposable } from '../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../common/base/common/uri.js';
import type { IFileService } from '../../../../common/platform/files/common/files.js';
import { TextModel } from '../../../../common/editor/common/model/textModel.js';
import { CodeEditorService } from '../../services/editor/browser/codeEditorService.js';
import { EditorInput, EditorInputCapabilities } from './editorInput.js';
import type { EditorPane } from './editorPane.js';

export const TEXT_EDITOR_TYPE_ID = 'workbench.editors.textEditorInput';

/**
 * The display name of a path, accepting EITHER separator whatever host we are on.
 *
 * `win32.basename` and not the platform default, deliberately: a tab label may come from a path
 * produced on another machine, and win32 treats both '/' and '\' as separators while posix treats
 * a backslash as an ordinary filename character. For a real local filesystem path use the
 * platform-default `dirname`/`basename` instead — there, a backslash in a posix filename is data,
 * not a separator, and win32's rules would corrupt it.
 */
export function basename(path: string): string {
	return path ? win32.basename(path) : '';
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
		private readonly _paneFactory: TextEditorPaneFactory,
		/**
		 * A2-1: in-memory, readonly inputs. Given `content`, the input never touches the file
		 * service — it is the backing for provider-supplied text (a `git diff` dump) shown in a
		 * tab that cannot be edited or saved. `EditorInputCapabilities.Readonly` existed but
		 * nothing honoured it; the pane now feeds it to the widget.
		 */
		private readonly _options?: { readonly content?: string; readonly name?: string; readonly readonly?: boolean }
	) {
		super();
		this.resource = resource;
		this._register({ dispose: () => this._modelListener?.dispose() });
	}

	get isReadonlyInput(): boolean {
		return !!this._options?.readonly;
	}

	override get capabilities(): EditorInputCapabilities {
		return this._options?.readonly ? EditorInputCapabilities.Readonly : EditorInputCapabilities.None;
	}

	/** 10: renames re-point the input at the new resource (the model object is kept) */
	updateResource(resource: URI): void {
		this.resource = resource;
	}

	getTypeId(): string {
		return TEXT_EDITOR_TYPE_ID;
	}

	getName(): string {
		return this._options?.name ?? basename(this.resource.fsPath);
	}

	getResource(): URI {
		return this.resource;
	}

	/** the model once loaded (before resolve this may be undefined) */
	getModel(): TextModel | undefined {
		return this._model ?? undefined;
	}

	override isDirty(): boolean {
		if (this._options?.readonly) {
			return false; // a readonly input can never be dirty, so it never prompts on close
		}
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
		} else if (this._options?.content !== undefined) {
			// provider-supplied text: no disk read, and the resource is a non-file scheme so a
			// stray write could not land on a real path even if save were reachable
			this._model = this._codeEditorService.createModel(this.resource, this._options.content);
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
		if (this._options?.readonly) {
			return false; // nothing to persist, and the resource is not a real path
		}
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
		if (this._options?.readonly) {
			return;
		}
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
