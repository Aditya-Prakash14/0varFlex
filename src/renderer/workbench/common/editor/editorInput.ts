// src/renderer/workbench/common/editor/editorInput.ts — ported in shape from
// vs/workbench/common/editor/editorInput.ts (the base class): `EditorInput` is the extension
// point every editor type implements — an id/type, a name, an optional resource, dirty state
// and a `resolve()` that produces the pane for a group.
//
// delta: no `editorId` instance counter (our inputs are unique per resource) and no
// `getDescription`/`getTitle` split — `getName()` is the tab label.

import { Emitter, Event } from '../../../../common/base/common/event.js';
import { Disposable } from '../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../common/base/common/uri.js';
import type { EditorPane } from './editorPane.js';

export const enum EditorInputCapabilities {
	None = 0,
	/** marks editors that only exist once (real: settings UI, welcome) */
	Singleton = 1 << 0,
	/** asks the group to reveal this editor whenever it is opened again */
	ForceReveal = 1 << 1,
	Readonly = 1 << 2
}

export abstract class EditorInput extends Disposable {

	private readonly _onDidChangeDirty = this._register(new Emitter<void>());
	readonly onDidChangeDirty: Event<void> = this._onDidChangeDirty.event;

	abstract getTypeId(): string;
	abstract getName(): string;
	abstract getResource(): URI | undefined;

	/** load whatever the pane needs, then create the pane (one per group asking) */
	abstract resolve(): Promise<EditorPane>;

	get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.None;
	}

	hasCapability(capability: EditorInputCapabilities): boolean {
		return (this.capabilities & capability) !== 0;
	}

	isDirty(): boolean {
		return false;
	}

	/** persist to disk; the caller (editor service) confirmed dirty state before */
	async save(): Promise<boolean> {
		return false;
	}

	/** throw away in-memory state and go back to what is on disk */
	async revert(): Promise<void> {
		// nothing to do for inputs without backing storage
	}

	/** the same editor? (resource identity here; real adds type overrides and ids) */
	matches(other: EditorInput | undefined | null): boolean {
		if (!other) {
			return false;
		}
		if (this === other) {
			return true;
		}
		const resource = this.getResource();
		const otherResource = other.getResource();
		return !!resource && !!otherResource && resource.toString() === otherResource.toString();
	}

	protected fireDirtyChanged(): void {
		this._onDidChangeDirty.fire();
	}
}
