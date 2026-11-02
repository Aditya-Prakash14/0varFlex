// src/renderer/editor/browser/view.ts — the View, ported in shape from
// vs/editor/browser/view.ts + viewLayer.ts + viewPart.ts, collapsed into one file:
//
//   - DOM nodes are created ONCE and updated, never recreated per frame (viewLayer rule);
//   - parts register as layers; ONE rAF-driven render pass calls every layer;
//   - the render pass gets a computed visible range and never touches lines outside it.
//
// Scroll strategy (delta vs upstream): real VS Code renders its own scrollbars and keeps the
// content fixed, translating layer content by hand; here the line/selection/cursor layers live
// inside a natively-scrolling spacer (`.editor-content`) and the native scrollbar does the
// moving. The line-number margin is a sibling of the scrollable so it stays put on horizontal
// scroll (that is the behavior people actually notice).
// shortcut: native scrollbars — /viewParts/editorScrollbar's smooth scrolling physics and
// alwaysConsumeMouseWheel arrive with the real scrollbar widget if ever needed.

import { Emitter, Event } from '../../../common/base/common/event.js';
import { Disposable, IDisposable } from '../../../common/base/common/lifecycle.js';
import type { TextModel } from '../../../common/editor/common/model/textModel.js';
import { addDisposableListener, append, $, ElementSizeObserver } from '../../base/browser/dom.js';
import { IEditorOptions } from './config.js';
import { Selection } from './core/selection.js';
import { IViewport, ViewModel } from './viewModel.js';

export interface IRenderStats {
	/** line nodes whose DOM was rebuilt this pass (the "did we re-render the world?" counter) */
	renderedLines: number;
}

export interface IRenderContext {
	readonly model: TextModel;
	readonly viewModel: ViewModel;
	readonly options: IEditorOptions;
	readonly selection: Selection;
	/** every cursor, primary first in the list order the controller reports */
	readonly selections: readonly Selection[];
	readonly scrollTop: number;
	readonly cursorVisible: boolean;
	readonly stats: IRenderStats;
}

export interface IViewLayer {
	readonly element: HTMLElement;
	render(viewport: IViewport, context: IRenderContext): void;
}

export interface IRenderInfo {
	readonly durationMs: number;
	readonly renderedLines: number;
	readonly totalLines: number;
}

export class View extends Disposable {

	readonly element: HTMLElement;
	/** the native scrolling host (overflow: auto) */
	readonly scrollableElement: HTMLElement;
	/** positioned at the scroll content origin: content-space layers live here */
	readonly contentElement: HTMLElement;
	/** viewport-space margin on the left of the scrollable (line numbers) */
	readonly marginElement: HTMLElement;

	private readonly _layers: IViewLayer[] = [];
	private readonly _marginLayers: IViewLayer[] = [];
	private readonly _sizeObserver: ElementSizeObserver;
	private _renderHandle: number | null = null;
	private _renderTimer: number | null = null;
	private _contextProvider: (() => IRenderContext | null) | null = null;
	private _scrollBeyondLastLine = true;
	private _lastRenderedScrollWidth = -1;

	private readonly _onDidRender = this._register(new Emitter<IRenderInfo>());
	readonly onDidRender: Event<IRenderInfo> = this._onDidRender.event;

	constructor(container: HTMLElement) {
		super();
		this.element = append(container, $('.editor'));
		this.marginElement = append(this.element, $('.editor-margin'));
		this.scrollableElement = append(this.element, $('.editor-scrollable'));
		this.contentElement = append(this.scrollableElement, $('.editor-content'));

		this._register(addDisposableListener(this.scrollableElement, 'scroll', () => this.scheduleRender()));
		this._sizeObserver = this._register(new ElementSizeObserver(this.scrollableElement, undefined));
		this._register(this._sizeObserver.onDidChange(() => this.scheduleRender()));
		this._sizeObserver.startObserving();
	}

	addContentLayer(layer: IViewLayer): void {
		this._layers.push(layer);
		append(this.contentElement, layer.element);
	}

	addMarginLayer(layer: IViewLayer): void {
		this._marginLayers.push(layer);
		append(this.marginElement, layer.element);
	}

	setContextProvider(provider: () => IRenderContext | null): void {
		this._contextProvider = provider;
	}

	setScrollBeyondLastLine(value: boolean): void {
		this._scrollBeyondLastLine = value;
	}

	getScrollTop(): number {
		return this.scrollableElement.scrollTop;
	}

	setScrollTop(scrollTop: number): void {
		this.scrollableElement.scrollTop = scrollTop;
	}

	getScrollLeft(): number {
		return this.scrollableElement.scrollLeft;
	}

	setMarginWidth(width: number): void {
		this.marginElement.style.width = `${width}px`;
		this.marginElement.style.display = width > 0 ? '' : 'none';
		this.scrollableElement.style.left = `${width}px`;
	}

	/** schedule a render for the next animation frame (several calls coalesce) */
	scheduleRender(): void {
		if (this._renderHandle !== null || this._renderTimer !== null || !this._contextProvider) {
			return;
		}
		const run = () => {
			if (this._renderHandle !== null) {
				cancelAnimationFrame(this._renderHandle);
				this._renderHandle = null;
			}
			if (this._renderTimer !== null) {
				window.clearTimeout(this._renderTimer);
				this._renderTimer = null;
			}
			this.render();
		};
		this._renderHandle = requestAnimationFrame(run);
		// rAF pauses for occluded/background windows (macOS occlusion detection): the short
		// timer guarantees the pass still runs — chosen over "rAF only, hope for visibility"
		this._renderTimer = window.setTimeout(run, 50);
	}

	/** one pass: compute the visible range, size the spacer, ask every layer to render */
	render(): void {
		if (!this._contextProvider) {
			return;
		}
		const context = this._contextProvider();
		if (!context) {
			return; // no model yet: nothing to paint
		}
		const started = performance.now();
		const scrollTop = this.scrollableElement.scrollTop;
		const viewportHeight = this.scrollableElement.clientHeight;
		const viewportWidth = this.scrollableElement.clientWidth;
		const viewport = context.viewModel.getViewport(scrollTop, viewportHeight);

		// the spacer: total height plus room to scroll the last line up (scrollBeyondLastLine)
		const extraBottom = this._scrollBeyondLastLine ? Math.max(0, viewportHeight - context.viewModel.getLineHeight()) : 0;
		this.contentElement.style.height = `${context.viewModel.getTotalHeight() + extraBottom}px`;

		const stats: IRenderStats = context.stats;
		stats.renderedLines = 0;

		for (const layer of this._layers) {
			layer.render(viewport, context);
		}
		for (const layer of this._marginLayers) {
			layer.render(viewport, context);
		}

		// horizontal extent: the widest line rendered plus a scrollbar's worth of headroom
		const contentWidth = Math.max(this._lastRenderedScrollWidth, viewportWidth);
		this.contentElement.style.width = `${contentWidth}px`;

		this._onDidRender.fire({
			durationMs: performance.now() - started,
			renderedLines: stats.renderedLines,
			totalLines: context.viewModel.getLineCount()
		});
	}

	/** layers report the horizontal extent they need (lines layer, mostly) */
	reportContentWidth(width: number): void {
		this._lastRenderedScrollWidth = width;
	}

	override dispose(): void {
		if (this._renderHandle !== null) {
			cancelAnimationFrame(this._renderHandle);
			this._renderHandle = null;
		}
		if (this._renderTimer !== null) {
			window.clearTimeout(this._renderTimer);
			this._renderTimer = null;
		}
		super.dispose();
	}
}
