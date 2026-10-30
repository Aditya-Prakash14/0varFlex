// src/renderer/workbench/browser/part.ts — ported from vs/workbench/browser/part.ts.
// A much smaller copy: container element, title/content template methods, visibility,
// the min/max accessors the split views read, and toJSON for state.

import { Emitter, Event } from '../../../common/base/common/event.js';
import { Disposable } from '../../../common/base/common/lifecycle.js';
import { Dimension, position, size } from '../../base/browser/dom.js';

export interface IPartOptions {
	readonly hasTitle?: boolean;
}

/**
 * Parts are laid out in the workbench and have their own layout that
 * arranges an optional title and mandatory content area to show content.
 */
export abstract class Part extends Disposable {

	private _dimension: Dimension | undefined;
	get dimension(): Dimension | undefined { return this._dimension; }

	protected _onDidVisibilityChange = this._register(new Emitter<boolean>());
	readonly onDidVisibilityChange = this._onDidVisibilityChange.event;

	protected readonly _onDidChange = this._register(new Emitter<number | undefined>());
	get onDidChange(): Event<number | undefined> { return this._onDidChange.event; }

	private _parent: HTMLElement | undefined;
	protected titleArea: HTMLElement | undefined;
	protected contentArea: HTMLElement | undefined;

	private _visible = true;
	get visible(): boolean { return this._visible; }

	constructor(readonly id: string, protected readonly options: IPartOptions = {}) {
		super();
	}

	/**
	 * Note: clients should not call this method, the workbench calls this method.
	 * Called to create title and content area of the part.
	 */
	create(parent: HTMLElement): void {
		this._parent = parent;
		parent.classList.add('part', this.id);

		this.titleArea = this.createTitleArea(parent);
		this.contentArea = this.createContentArea(parent);
	}

	getContainer(): HTMLElement | undefined {
		return this._parent;
	}

	protected createTitleArea(parent: HTMLElement): HTMLElement | undefined {
		return undefined;
	}

	protected createContentArea(parent: HTMLElement): HTMLElement | undefined {
		return undefined;
	}

	abstract get minimumWidth(): number;
	abstract get maximumWidth(): number;
	abstract get minimumHeight(): number;
	abstract get maximumHeight(): number;

	layout(width: number, height: number, top = 0, left = 0): void {
		if (!this._parent) {
			return;
		}
		this._dimension = new Dimension(width, height);
		size(this._parent, width, height);
		position(this._parent, top, left);
	}

	setVisible(visible: boolean): void {
		if (this._visible === visible) {
			return;
		}
		this._visible = visible;
		this._parent?.classList.toggle('hidden', !visible);
		this._onDidVisibilityChange.fire(visible);
	}

	toJSON(): object {
		return this._visible ? {} : { visible: false };
	}
}
