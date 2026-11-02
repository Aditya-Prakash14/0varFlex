// src/renderer/editor/browser/layers/lineNumbers.ts — the line-number margin, ported from
// vs/editor/browser/viewParts/lineNumbers/lineNumbers.ts + viewParts/margin/margin.ts:
//
//   - numbers are their OWN layer with a fixed width (digits × charWidth + padding);
//   - the margin sits OUTSIDE the horizontal scroller, so numbers stay put on horizontal
//     scroll (the detail people notice);
//   - editor.lineNumbers: 'on' | 'off' | 'relative' | 'interval' (interval falls back to
//     'on' — the interval counter is a delta, noted with the config reader).

import { append, $ } from '../../../base/browser/dom.js';
import { IViewport } from '../viewModel.js';
import { IRenderContext, IViewLayer } from '../view.js';

interface INumberNode {
	element: HTMLElement;
	lineNumber: number;
	text: string;
	current: boolean;
}

export class LineNumbersLayer implements IViewLayer {

	readonly element: HTMLElement;

	private readonly _nodes: INumberNode[] = [];
	private _lastWidth = -1;

	constructor(private readonly _reportMarginWidth: (width: number) => void) {
		this.element = $('.layer-line-numbers');
	}

	render(viewport: IViewport, context: IRenderContext): void {
		const options = context.options;
		const viewModel = context.viewModel;
		const lineHeight = viewModel.getLineHeight();
		const charWidth = viewModel.getCharWidth();
		const lineCount = viewModel.getLineCount();
		const cursorLine = context.selection.getPosition().lineNumber;

		const mode = options.lineNumbers === 'off' ? 'off' : options.lineNumbers;
		if (mode === 'off') {
			this.element.style.display = 'none';
			if (this._lastWidth !== 0) {
				this._lastWidth = 0;
				this._reportMarginWidth(0);
			}
			return;
		}
		this.element.style.display = '';

		const digits = String(lineCount).length;
		const width = digits * charWidth + 20;
		if (width !== this._lastWidth) {
			this._lastWidth = width;
			this._reportMarginWidth(width);
		}

		// numbers are viewport-space: the margin does not scroll with the content
		const scrollTop = context.scrollTop;
		let slot = 0;
		// a folded line has no row, so it has no number either
		for (const lineNumber of context.viewModel.visibleModelLines(viewport)) {
			const index = slot++;
			let node = this._nodes[index];
			if (!node) {
				node = { element: $('.line-number'), lineNumber: -1, text: '', current: false };
				this._nodes[index] = node;
				append(this.element, node.element);
			}

			const current = lineNumber === cursorLine;
			const text = mode === 'relative'
				? (current ? String(lineNumber) : String(Math.abs(lineNumber - cursorLine)))
				: String(lineNumber);

			if (node.text !== text) {
				node.text = text;
				node.element.textContent = text;
			}
			if (node.current !== current) {
				node.current = current;
				node.element.classList.toggle('current-line-number', current);
			}
			node.element.style.top = `${viewModel.getLineTop(lineNumber) - scrollTop}px`;
			node.element.style.height = `${lineHeight}px`;
			node.element.style.lineHeight = `${lineHeight}px`;
			node.element.style.display = '';
		}

		for (let i = slot; i < this._nodes.length; i++) {
			this._nodes[i].element.style.display = 'none';
		}
	}
}
