// src/renderer/editor/browser/layers/viewCursors.ts — the cursor overlay, per
// viewParts/viewCursors/viewCursors.ts: a positioned rect, width = editor.cursorWidth.
// Blinking (BLINK_INTERVAL = 500ms) and window-focus hiding are decided by the WIDGET — the
// layer only paints `cursorVisible` declaratively.

import { IViewport } from '../viewModel.js';
import { IRenderContext } from '../view.js';
import { IOverlayRect, OverlayLayer } from './overlayLayer.js';

export class ViewCursorsLayer extends OverlayLayer {

	constructor() {
		super('cursor');
	}

	protected override prepareRender(viewport: IViewport, context: IRenderContext): IOverlayRect[] {
		if (!context.cursorVisible) {
			return [];
		}
		const position = context.selection.getPosition();
		if (position.lineNumber < viewport.startLineNumber - 1 || position.lineNumber > viewport.endLineNumber + 1) {
			return [];
		}
		const lineText = context.model.getLineContent(position.lineNumber);
		const viewModel = context.viewModel;
		return [{
			top: viewModel.getLineTop(position.lineNumber),
			left: viewModel.getXForColumn(lineText, position.column),
			width: context.options.cursorWidth,
			height: viewModel.getLineHeight()
		}];
	}
}
