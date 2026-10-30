// src/renderer/workbench/services/editor/browser/codeEditorService.ts — the model registry,
// ported in responsibility split from vs/workbench/services/editor/browser/codeEditorService.ts:
// ONE TextModel per URI, shared by every pane that shows the resource; the widgets own view
// state, the registry owns the model lifetime (refcounted by showing panes).
//
// `createModel` is get-or-create here (the real service creates; the workbench then looks the
// model up) — with one model per URI the difference is only the return of the existing model.

import { Disposable } from '../../../../../common/base/common/lifecycle.js';
import { TextModel } from '../../../../../common/editor/common/model/textModel.js';
import { URI } from '../../../../../common/base/common/uri.js';

interface IModelEntry {
	readonly model: TextModel;
	refs: number;
}

export class CodeEditorService extends Disposable {

	private readonly _models = new Map<string, IModelEntry>();

	/** get-or-create the model for a resource */
	createModel(uri: URI, text: string): TextModel {
		const key = uri.toString();
		const existing = this._models.get(key);
		if (existing) {
			return existing.model;
		}
		const model = new TextModel(text);
		this._models.set(key, { model, refs: 0 });
		return model;
	}

	findModel(uri: URI): TextModel | undefined {
		return this._models.get(uri.toString())?.model;
	}

	/** a pane showed the model */
	acquire(uri: URI): void {
		const entry = this._models.get(uri.toString());
		if (entry) {
			entry.refs++;
		}
	}

	/** a pane stopped showing the model: at zero refs the model is disposed and dropped */
	release(uri: URI): void {
		const key = uri.toString();
		const entry = this._models.get(key);
		if (!entry) {
			return;
		}
		entry.refs = Math.max(0, entry.refs - 1);
		if (entry.refs === 0) {
			entry.model.dispose();
			this._models.delete(key);
		}
	}

	/** test/debug view */
	refCount(uri: URI): number {
		return this._models.get(uri.toString())?.refs ?? 0;
	}

	modelCount(): number {
		return this._models.size;
	}

	override dispose(): void {
		for (const entry of this._models.values()) {
			entry.model.dispose();
		}
		this._models.clear();
		super.dispose();
	}
}
