// src/renderer/base/browser/ui/splitview/splitview.ts — a faithful-but-small port of
// vs/base/browser/ui/splitview/splitview.ts (plus its Sash): proportional distribution,
// min/max clamping on every drag, pointer capture, double-click collapse-with-memory.
// Skipped upstream: layout priorities, snap, alt-key drag, orthogonal sashes, styles objects.

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../common/base/common/lifecycle.js';
import { addDisposableListener, append, $ } from '../../dom.js';

export const enum Orientation {
	/** Views are stacked vertically (top/bottom); the sash is a horizontal line. */
	VERTICAL,
	/** Views sit side by side; the sash is a vertical line. */
	HORIZONTAL
}

export interface IView {
	readonly element: HTMLElement;
	readonly minimumSize: number;
	readonly maximumSize: number;
	readonly onDidChange?: Event<number | undefined>;
	// upstream passes a TLayoutContext here; we pass the orthogonal size — all our views need it
	layout(size: number, offset: number, orthogonalSize: number): void;
}

export interface ISplitViewOptions {
	readonly orientation?: Orientation;
	readonly proportionalLayout?: boolean;
	/** The view index a sash double-click collapses and restores (default: the view before the sash). */
	readonly resetIndex?: number;
}

const SASH_SIZE = 4;

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

interface ISashEvent {
	readonly start: number;
	readonly current: number;
}

class Sash extends Disposable {

	readonly element: HTMLElement;

	private readonly _onDidStart = this._register(new Emitter<ISashEvent>());
	private readonly _onDidChange = this._register(new Emitter<ISashEvent>());
	private readonly _onDidReset = this._register(new Emitter<void>());
	private readonly _onDidEnd = this._register(new Emitter<void>());

	get onDidStart(): Event<ISashEvent> { return this._onDidStart.event; }
	get onDidChange(): Event<ISashEvent> { return this._onDidChange.event; }
	get onDidReset(): Event<void> { return this._onDidReset.event; }
	get onDidEnd(): Event<void> { return this._onDidEnd.event; }

	constructor(container: HTMLElement, private readonly _orientation: Orientation) {
		super();

		this.element = append(container, $('.sash'));
		this.element.classList.add(_orientation === Orientation.VERTICAL ? 'row' : 'col');

		this._register(addDisposableListener(this.element, 'pointerdown', (e: PointerEvent) => this._onPointerDown(e)));
		this._register(addDisposableListener(this.element, 'dblclick', () => this._onDidReset.fire()));
	}

	layout(position: number, orthogonalSize: number): void {
		const half = SASH_SIZE / 2;
		if (this._orientation === Orientation.VERTICAL) {
			this.element.style.top = `${position - half}px`;
			this.element.style.left = '0';
			this.element.style.width = '100%';
			this.element.style.height = `${SASH_SIZE}px`;
		} else {
			this.element.style.left = `${position - half}px`;
			this.element.style.top = '0';
			this.element.style.height = '100%';
			this.element.style.width = `${SASH_SIZE}px`;
		}
	}

	private _onPointerDown(e: PointerEvent): void {
		if (e.button !== 0) {
			return;
		}

		e.preventDefault();
		// without pointer capture the drag drops the moment the pointer leaves the 4px target
		this.element.setPointerCapture(e.pointerId);

		const coordinate = (ev: PointerEvent): number => this._orientation === Orientation.VERTICAL ? ev.clientY : ev.clientX;
		const start = coordinate(e);

		const move = addDisposableListener(this.element, 'pointermove', (ev: PointerEvent) => {
			this._onDidChange.fire({ start, current: coordinate(ev) });
		});
		const up = addDisposableListener(this.element, 'pointerup', (ev: PointerEvent) => {
			move.dispose();
			up.dispose();
			this.element.releasePointerCapture(ev.pointerId);
			this._onDidEnd.fire();
		});

		this._onDidStart.fire({ start, current: start });
	}
}

export class SplitView extends Disposable {

	private readonly _orientation: Orientation;
	private readonly _proportionalLayout: boolean;
	private readonly _resetIndex: number | undefined;
	private readonly _container: HTMLElement;
	private readonly _sashContainer: HTMLElement;

	private _size = 0;
	private _orthogonalSize = 0;
	private _contentSize = 0;

	private readonly _viewItems: { view: IView; size: number }[] = [];
	private readonly _sashItems: { sash: Sash; beforeIndex: number; disposable: IDisposable }[] = [];
	private _proportions: (number | undefined)[] | undefined;
	private readonly _rememberedSizes = new Map<number, number>();
	private _sashDragState: { index: number; start: number; sizes: number[] } | undefined;

	private readonly _onDidSashChange = this._register(new Emitter<number[]>());
	readonly onDidSashChange = this._onDidSashChange.event;
	private readonly _onDidSashReset = this._register(new Emitter<number>());
	readonly onDidSashReset = this._onDidSashReset.event;

	constructor(container: HTMLElement, options: ISplitViewOptions = {}) {
		super();

		this._orientation = options.orientation ?? Orientation.VERTICAL;
		this._proportionalLayout = options.proportionalLayout ?? true;
		this._resetIndex = options.resetIndex;
		this._container = container;
		this._container.classList.add('split-view', this._orientation === Orientation.VERTICAL ? 'vertical' : 'horizontal');

		this._sashContainer = append(this._container, $('.sash-container'));
	}

	get orientation(): Orientation { return this._orientation; }
	get size(): number { return this._size; }
	get contentSize(): number { return this._contentSize; }
	get length(): number { return this._viewItems.length; }

	// shortcut: append-only — inserting or removing views in the middle would need the sashes
	// re-indexed; the fixed workbench arrangement never does
	addView(view: IView, size: number): void {
		this._viewItems.push({ view, size });

		if (this._viewItems.length > 1) {
			const sash = new Sash(this._sashContainer, this._orientation);
			const beforeIndex = this._sashItems.length;
			const disposable = new DisposableStore();
			disposable.add(sash);

			disposable.add(sash.onDidStart(({ start }) => {
				this._sashDragState = { index: beforeIndex, start, sizes: this._viewItems.map(item => item.size) };
			}));
			disposable.add(sash.onDidChange(({ start, current }) => {
				const state = this._sashDragState;
				if (!state) {
					return;
				}
				this._resize(state.index, current - start, state.sizes);
				this._distributeEmptySpace();
				this._layoutViews(false);
			}));
			disposable.add(sash.onDidEnd(() => {
				this._sashDragState = undefined;
				this._saveProportions();
				this._onDidSashChange.fire(this._viewItems.map(item => item.size));
			}));
			disposable.add(sash.onDidReset(() => this._resetSash(beforeIndex)));

			this._sashItems.push({ sash, beforeIndex, disposable });
			this._register(disposable);
		}

		this._container.appendChild(view.element);
	}

	layout(size: number, orthogonalSize: number): void {
		const previousSize = Math.max(this._size, this._contentSize);
		this._size = size;
		this._orthogonalSize = orthogonalSize;

		this._container.style.width = this._orientation === Orientation.VERTICAL ? `${orthogonalSize}px` : `${size}px`;
		this._container.style.height = this._orientation === Orientation.VERTICAL ? `${size}px` : `${orthogonalSize}px`;

		if (!this._proportions) {
			this._resize(this._viewItems.length - 1, size - previousSize, this._viewItems.map(item => item.size));
		} else {
			let total = 0;
			let remaining = size;

			for (let i = 0; i < this._viewItems.length; i++) {
				const item = this._viewItems[i];
				const proportion = this._proportions[i];
				if (typeof proportion === 'number') {
					total += proportion;
				} else {
					remaining -= item.size;
				}
			}

			for (let i = 0; i < this._viewItems.length; i++) {
				const item = this._viewItems[i];
				const proportion = this._proportions[i];
				if (typeof proportion === 'number' && total > 0) {
					item.size = clamp(Math.round(proportion * remaining / total), item.view.minimumSize, item.view.maximumSize);
				}
			}
		}

		this._distributeEmptySpace();
		this._layoutViews();
		this._saveProportions();
	}

	getViewSize(index: number): number {
		return this._viewItems[index]?.size ?? 0;
	}

	setViewSize(index: number, size: number): void {
		this._resizeViewTo(index, size);
		this._saveProportions();
		this._onDidSashChange.fire(this._viewItems.map(i => i.size));
	}

	/**
	 * Resize one view to an absolute size, moving the space across its adjacent sash so the
	 * total stays conserved (growing the last view takes from before it, not from nowhere).
	 */
	private _resizeViewTo(targetIndex: number, size: number): void {
		const item = this._viewItems[targetIndex];
		if (!item) {
			return;
		}
		const clamped = clamp(size, item.view.minimumSize, item.view.maximumSize);
		const delta = clamped - item.size;
		const sizes = this._viewItems.map(i => i.size);

		if (targetIndex === this._viewItems.length - 1 && targetIndex > 0) {
			this._resize(targetIndex - 1, -delta, sizes);
		} else {
			this._resize(targetIndex, delta, sizes);
		}

		this._distributeEmptySpace();
		this._layoutViews();
	}

	/**
	 * The resize core, ported from the reference: `delta` moves space between the views up to
	 * and including `index` and the views after it, clamping against every min/max on the way.
	 */
	private _resize(index: number, delta: number, sizes: number[]): number {
		if (index < 0 || index >= this._viewItems.length) {
			return 0;
		}

		const upIndexes: number[] = [];
		for (let i = index; i >= 0; i--) {
			upIndexes.push(i);
		}
		const downIndexes: number[] = [];
		for (let i = index + 1; i < this._viewItems.length; i++) {
			downIndexes.push(i);
		}

		const minDeltaUp = upIndexes.reduce((r, i) => r + (this._viewItems[i].view.minimumSize - sizes[i]), 0);
		const maxDeltaUp = upIndexes.reduce((r, i) => r + (this._viewItems[i].view.maximumSize - sizes[i]), 0);
		const maxDeltaDown = downIndexes.length === 0 ? Number.POSITIVE_INFINITY : downIndexes.reduce((r, i) => r + (sizes[i] - this._viewItems[i].view.minimumSize), 0);
		const minDeltaDown = downIndexes.length === 0 ? Number.NEGATIVE_INFINITY : downIndexes.reduce((r, i) => r + (sizes[i] - this._viewItems[i].view.maximumSize), 0);
		const clampedDelta = Math.max(minDeltaUp, minDeltaDown, Math.min(maxDeltaDown, maxDeltaUp, delta));

		let deltaUp = clampedDelta;
		for (const i of upIndexes) {
			const item = this._viewItems[i];
			const newSize = clamp(sizes[i] + deltaUp, item.view.minimumSize, item.view.maximumSize);
			deltaUp -= newSize - sizes[i];
			item.size = newSize;
		}

		let deltaDown = clampedDelta;
		for (const i of downIndexes) {
			const item = this._viewItems[i];
			const newSize = clamp(sizes[i] - deltaDown, item.view.minimumSize, item.view.maximumSize);
			deltaDown += newSize - sizes[i];
			item.size = newSize;
		}

		return clampedDelta;
	}

	private _distributeEmptySpace(): void {
		const contentSize = this._viewItems.reduce((r, item) => r + item.size, 0);
		let emptyDelta = this._size - contentSize;

		// the last view absorbs leftover space first
		for (let i = this._viewItems.length - 1; i >= 0 && emptyDelta !== 0; i--) {
			const item = this._viewItems[i];
			const newSize = clamp(item.size + emptyDelta, item.view.minimumSize, item.view.maximumSize);
			emptyDelta -= newSize - item.size;
			item.size = newSize;
		}
	}

	/** Double-click a sash: collapse the target view to its minimum, again restores the remembered size. */
	private _resetSash(beforeIndex: number): void {
		const targetIndex = this._resetIndex ?? beforeIndex;
		const item = this._viewItems[targetIndex];
		if (!item) {
			return;
		}

		const remembered = this._rememberedSizes.get(targetIndex);

		if (typeof remembered === 'number' && item.size <= item.view.minimumSize) {
			this._rememberedSizes.delete(targetIndex);
			this._resizeViewTo(targetIndex, remembered);
		} else {
			this._rememberedSizes.set(targetIndex, item.size);
			this._resizeViewTo(targetIndex, item.view.minimumSize);
		}

		this._saveProportions();
		this._onDidSashReset.fire(targetIndex);
	}

	private _layoutViews(saveContentSize = true): void {
		if (saveContentSize) {
			this._contentSize = this._viewItems.reduce((r, item) => r + item.size, 0);
		}

		let offset = 0;
		for (const item of this._viewItems) {
			item.view.layout(item.size, offset, this._orthogonalSize);
			offset += item.size;
		}

		for (const { sash, beforeIndex } of this._sashItems) {
			let position = 0;
			for (let i = 0; i <= beforeIndex; i++) {
				position += this._viewItems[i].size;
			}
			sash.layout(position, this._orthogonalSize);
		}
	}

	private _saveProportions(): void {
		if (this._proportionalLayout && this._contentSize > 0) {
			this._proportions = this._viewItems.map(item => item.size / this._contentSize);
		}
	}
}
