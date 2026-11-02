// src/renderer/editor/contrib/markerDecorations/markerDecorations.ts — markers → editor
// decorations, following vs/editor/contrib/markerDecorations and the decoration adapter idea:
//
//   - squiggles: a 3px repeat-x SVG wave at the bottom of each marker range line, colored per
//     severity (the real decoration renders an inline SVG wave the same way — ours is a shared
//     data URI, one per severity);
//   - margin dots: a severity-colored dot in the gutter for every line that has markers.
//
// Both layers sit in the 08 overlay layers and re-render per pass from the marker service —
// nothing accumulates, and the owner isolation lives in the service (another owner's update
// must never clear these).

import { Disposable } from '../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../common/base/common/uri.js';
import { $ } from '../../../base/browser/dom.js';
import { EditorWidget } from '../../browser/editorWidget.js';
import { IViewport } from '../../browser/viewModel.js';
import { IRenderContext, IViewLayer } from '../../browser/view.js';
import { MarkerService, MarkerSeverity, IMarker } from '../../../workbench/services/markers/browser/markerService.js';

interface IMarkerRect {
	readonly top: number;
	readonly left: number;
	readonly width: number;
	readonly severity: MarkerSeverity;
}

export class MarkerDecorations extends Disposable {

	private readonly _squiggles: MarkerSquiggleLayer;
	private readonly _dots: MarkerDotLayer;

	constructor(
		private readonly _editor: EditorWidget,
		private readonly _markers: MarkerService,
		private readonly _getResource: () => URI | undefined
	) {
		super();
		this._squiggles = new MarkerSquiggleLayer((viewport, context) => this._squiggleRects(viewport, context));
		this._dots = new MarkerDotLayer((viewport, context) => this._dotRects(viewport, context));
		this._editor.view.addContentLayer(this._squiggles);
		this._editor.view.addMarginLayer(this._dots);

		// any ownership change for this resource repaints (the service batches per resource)
		this._register(this._markers.onMarkerChanged(resources => {
			const resource = this._getResource();
			if (!resource) {
				return;
			}
			if (resources.some(changed => changed.toString() === resource.toString())) {
				this._editor.view.scheduleRender();
			}
		}));
	}

	private _markersForLine(lineNumber: number): readonly IMarker[] {
		const resource = this._getResource();
		if (!resource) {
			return [];
		}
		return this._markers.markersByLine(resource).get(lineNumber) ?? [];
	}

	private _squiggleRects(viewport: IViewport, context: IRenderContext): IMarkerRect[] {
		const rects: IMarkerRect[] = [];
		// visibleModelLines, not a range: a marker on a folded line has no row to draw on
		for (const lineNumber of context.viewModel.visibleModelLines(viewport)) {
			for (const marker of this._markersForLine(lineNumber)) {
				const lineText = context.model.getLineContent(lineNumber);
				const startColumn = lineNumber === marker.range.startLineNumber ? marker.range.startColumn : 1;
				const endColumn = lineNumber === marker.range.endLineNumber ? marker.range.endColumn : lineText.length + 1;
				const left = context.viewModel.getXForColumn(lineText, startColumn);
				const width = Math.max(2, context.viewModel.getXForColumn(lineText, endColumn) - left);
				rects.push({
					top: context.viewModel.getLineTop(lineNumber) + context.viewModel.getLineHeight() - 3,
					left,
					width,
					severity: marker.severity
				});
			}
		}
		return rects;
	}

	private _dotRects(viewport: IViewport, context: IRenderContext): IMarkerRect[] {
		const rects: IMarkerRect[] = [];
		// visibleModelLines, not a range: a marker on a folded line has no row to draw on
		for (const lineNumber of context.viewModel.visibleModelLines(viewport)) {
			const markers = this._markersForLine(lineNumber);
			if (markers.length === 0) {
				continue;
			}
			const severity = markers.reduce((highest, marker) => marker.severity > highest ? marker.severity : highest, MarkerSeverity.Hint);
			rects.push({
				// margin layers are viewport-space: subtract the scroll (unlike the content layers)
				top: context.viewModel.getLineTop(lineNumber) - context.scrollTop + context.viewModel.getLineHeight() / 2 - 3,
				left: 0,
				width: 0,
				severity
			});
		}
		return rects;
	}
}

/** pooled divs whose severity class changes per rect (the overlay pattern, per-rect classes) */
class MarkerSquiggleLayer implements IViewLayer {

	readonly element: HTMLElement;
	private readonly _pool: HTMLElement[] = [];

	constructor(private readonly _getRects: (viewport: IViewport, context: IRenderContext) => IMarkerRect[]) {
		this.element = $('.editor-marker-squiggles');
	}

	render(viewport: IViewport, context: IRenderContext): void {
		const rects = this._getRects(viewport, context);
		for (let i = 0; i < Math.max(rects.length, this._pool.length); i++) {
			let node = this._pool[i];
			if (!node) {
				node = $('.marker-squiggle');
				this._pool[i] = node;
				this.element.appendChild(node);
			}
			if (i >= rects.length) {
				node.style.display = 'none';
				continue;
			}
			const rect = rects[i];
			node.style.display = '';
			node.className = `marker-squiggle ${severityClass(rect.severity)}`;
			node.style.top = `${rect.top}px`;
			node.style.left = `${rect.left}px`;
			node.style.width = `${rect.width}px`;
		}
	}
}

class MarkerDotLayer implements IViewLayer {

	readonly element: HTMLElement;
	private readonly _pool: HTMLElement[] = [];

	constructor(private readonly _getRects: (viewport: IViewport, context: IRenderContext) => IMarkerRect[]) {
		this.element = $('.editor-marker-dots');
	}

	render(viewport: IViewport, context: IRenderContext): void {
		const rects = this._getRects(viewport, context);
		for (let i = 0; i < Math.max(rects.length, this._pool.length); i++) {
			let node = this._pool[i];
			if (!node) {
				node = $('.marker-dot');
				this._pool[i] = node;
				this.element.appendChild(node);
			}
			if (i >= rects.length) {
				node.style.display = 'none';
				continue;
			}
			node.style.display = '';
			node.className = `marker-dot ${severityClass(rects[i].severity)}`;
			node.style.top = `${rects[i].top}px`;
		}
	}
}

function severityClass(severity: MarkerSeverity): string {
	switch (severity) {
		case MarkerSeverity.Error: return 'severity-error';
		case MarkerSeverity.Warning: return 'severity-warning';
		case MarkerSeverity.Info: return 'severity-info';
		default: return 'severity-hint';
	}
}
