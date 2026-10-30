// src/renderer/editor/browser/layers/currentLineHighlight.ts — the current-line band, per
// viewParts/currentLineHighlight/currentLineHighlight.ts: its own layer/element, hidden when
// editor.renderLineHighlight is 'none' (real default 'line').

import { $ } from '../../../base/browser/dom.js';
import { IViewport } from '../viewModel.js';
import { IRenderContext, IViewLayer } from '../view.js';

export class CurrentLineHighlightLayer implements IViewLayer {

	readonly element: HTMLElement;

	constructor() {
		this.element = $('.current-line');
	}

	render(viewport: IViewport, context: IRenderContext): void {
		if (context.options.renderLineHighlight === 'none') {
			this.element.style.display = 'none';
			return;
		}
		const position = context.selection.getPosition();
		const viewModel = context.viewModel;
		this.element.style.display = '';
		this.element.style.top = `${viewModel.getLineTop(position.lineNumber)}px`;
		this.element.style.height = `${viewModel.getLineHeight()}px`;
	}
}
