// src/renderer/editor/browser/layers/selections.ts — selection painting, following the real
// viewParts/selections shape: a multi-line selection is ONE DIV PER LINE (start column on the
// first line, 0 on middle lines, end column on the last), recomputed from anchor/active on
// every render pass — declarative, never accumulated.

import { IViewport } from '../viewModel.js';
import { IRenderContext } from '../view.js';
import { IOverlayRect, OverlayLayer } from './overlayLayer.js';

export class SelectionsLayer extends OverlayLayer {

	constructor() {
		super('selected-text');
	}

	protected override prepareRender(viewport: IViewport, context: IRenderContext): IOverlayRect[] {
		const selection = context.selection;
		if (selection.isEmpty()) {
			return [];
		}

		const model = context.model;
		const viewModel = context.viewModel;
		const lineHeight = viewModel.getLineHeight();
		const start = selection.getSelectionStart();
		const end = selection.getSelectionEnd();

		const rects: IOverlayRect[] = [];
		const firstLine = Math.max(start.lineNumber, viewport.startLineNumber);
		const lastLine = Math.min(end.lineNumber, viewport.endLineNumber);

		for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
			const lineText = model.getLineContent(lineNumber);
			const columnStart = lineNumber === start.lineNumber ? start.column : 1;
			const columnEnd = lineNumber === end.lineNumber ? end.column : lineText.length + 1;
			const left = viewModel.getXForColumn(lineText, columnStart);
			const width = viewModel.getXForColumn(lineText, columnEnd) - left;
			rects.push({
				top: viewModel.getLineTop(lineNumber),
				left,
				width,
				height: lineHeight
			});
		}
		return rects;
	}
}
