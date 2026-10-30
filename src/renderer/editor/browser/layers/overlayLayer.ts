// src/renderer/editor/browser/layers/overlayLayer.ts — the declarative overlay pattern from
// vs/editor/browser/viewParts/viewLines/dynamicViewOverlay.ts + viewOverlay.ts:
//
//   prepareRender(state) reads the current state and returns RECTS; _render() maps them onto a
//   reusable pool of divs (create once, update, hide the leftovers). No mutations accumulate
//   across frames and no DOM is touched while computing — that kills a whole bug class.

import { append, $ } from '../../../base/browser/dom.js';
import { IViewport } from '../viewModel.js';
import { IRenderContext, IViewLayer } from '../view.js';

export interface IOverlayRect {
	readonly top: number;
	readonly left: number;
	readonly width: number;
	readonly height: number;
}

export abstract class OverlayLayer implements IViewLayer {

	readonly element: HTMLElement;

	private readonly _pool: HTMLElement[] = [];
	private readonly _className: string;

	constructor(className: string) {
		this.element = $('.overlay-layer');
		this._className = className;
	}

	protected abstract prepareRender(viewport: IViewport, context: IRenderContext): IOverlayRect[];

	render(viewport: IViewport, context: IRenderContext): void {
		const rects = this.prepareRender(viewport, context);

		for (let i = 0; i < Math.max(rects.length, this._pool.length); i++) {
			let node = this._pool[i];
			if (!node) {
				node = $('.overlay-rect');
				node.classList.add(this._className);
				this._pool[i] = node;
				append(this.element, node);
			}
			if (i >= rects.length) {
				node.style.display = 'none';
				continue;
			}
			const rect = rects[i];
			node.style.display = '';
			node.style.top = `${rect.top}px`;
			node.style.left = `${rect.left}px`;
			node.style.width = `${rect.width}px`;
			node.style.height = `${rect.height}px`;
		}
	}
}
