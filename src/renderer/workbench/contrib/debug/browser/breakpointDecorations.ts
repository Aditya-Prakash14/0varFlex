// src/renderer/workbench/contrib/debug/browser/breakpointDecorations.ts — the gutter
// breakpoints, ported in shape from
// vs/workbench/contrib/debug/browser/breakpointEditorContribution.ts:
//
//   - a margin VIEW LAYER paints the red dots, reusing exactly the mechanism 12's marker dots
//     use (view.addMarginLayer + pooled nodes, viewport-space tops);
//   - clicking the margin toggles the breakpoint on that line, and the current stop line gets
//     a highlight so you can see where execution is.
//
// delta: no breakpoint hover widget, no conditional-breakpoint input, no "unverified" state
// (the real one renders a hollow dot until the adapter confirms the line).

import { Disposable } from '../../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../../common/base/common/uri.js';
import { addDisposableListener, $ } from '../../../../base/browser/dom.js';
import type { EditorWidget } from '../../../../editor/browser/editorWidget.js';
import type { IRenderContext, IViewLayer } from '../../../../editor/browser/view.js';
import type { IViewport } from '../../../../editor/browser/viewModel.js';
import type { DebugService } from '../../../services/debug/browser/debugService.js';

interface IDotRect {
	readonly top: number;
	readonly current: boolean;
}

class BreakpointDotLayer implements IViewLayer {

	readonly element: HTMLElement;
	private readonly _pool: HTMLElement[] = [];

	constructor(private readonly _getRects: (viewport: IViewport, context: IRenderContext) => IDotRect[]) {
		this.element = $('.editor-breakpoint-dots');
	}

	render(viewport: IViewport, context: IRenderContext): void {
		const rects = this._getRects(viewport, context);
		for (let i = 0; i < Math.max(rects.length, this._pool.length); i++) {
			let node = this._pool[i];
			if (!node) {
				node = $('.breakpoint-dot');
				this._pool[i] = node;
				this.element.appendChild(node);
			}
			if (i >= rects.length) {
				node.style.display = 'none';
				continue;
			}
			node.style.display = '';
			node.className = `breakpoint-dot${rects[i].current ? ' current' : ''}`;
			node.style.top = `${rects[i].top}px`;
		}
	}
}

export class BreakpointDecorations extends Disposable {

	private _currentLine: number | undefined;

	constructor(
		private readonly _editor: EditorWidget,
		private readonly _debugService: DebugService,
		private readonly _getResource: () => URI | undefined
	) {
		super();

		const layer = new BreakpointDotLayer((viewport, context) => this._dotRects(viewport, context));
		this._editor.view.addMarginLayer(layer);

		this._register(this._debugService.onDidChangeBreakpoints(() => this._editor.view.scheduleRender()));
		// the stop line highlight: only for the resource this pane actually shows
		this._register(this._debugService.onDidStopAtFrame(frame => {
			const resource = this._getResource();
			this._currentLine = frame.path && resource && frame.path === resource.fsPath ? frame.line : undefined;
			this._editor.view.scheduleRender();
		}));

		this._register(this._debugService.onDidChangeState(() => {
			// leaving the stopped state clears the execution highlight
			if (this._debugService.state !== 'stopped') {
				this._currentLine = undefined;
			}
			this._editor.view.scheduleRender();
		}));

		// clicking the gutter toggles a breakpoint — the margin element is the hit area
		this._register(addDisposableListener(this._editor.view.marginElement, 'mousedown', (event: MouseEvent) => {
			const resource = this._getResource();
			if (!resource) {
				return;
			}
			const line = this._lineAt(event.clientY);
			if (line !== undefined) {
				event.preventDefault();
				event.stopPropagation();
				void this._debugService.toggleBreakpoint(resource, line);
			}
		}));
	}

	/** the workbench tells us where execution stopped, so the line can be highlighted */
	setCurrentLine(line: number | undefined): void {
		this._currentLine = line;
		this._editor.view.scheduleRender();
	}

	private _lineAt(clientY: number): number | undefined {
		const bounds = this._editor.view.marginElement.getBoundingClientRect();
		const offset = clientY - bounds.top + this._editor.view.getScrollTop();
		const viewModel = this._editor.getViewModel();
		const lineHeight = viewModel.getLineHeight();
		if (lineHeight <= 0) {
			return undefined;
		}
		const line = Math.floor(offset / lineHeight) + 1;
		const lineCount = viewModel.getLineCount();
		return line >= 1 && line <= lineCount ? line : undefined;
	}

	private _dotRects(viewport: IViewport, context: IRenderContext): IDotRect[] {
		const resource = this._getResource();
		if (!resource) {
			return [];
		}
		const lines = new Set(this._debugService.breakpointsFor(resource).map(breakpoint => breakpoint.line));
		if (this._currentLine !== undefined) {
			lines.add(this._currentLine);
		}

		const rects: IDotRect[] = [];
		for (let lineNumber = viewport.startLineNumber; lineNumber <= viewport.endLineNumber; lineNumber++) {
			if (!lines.has(lineNumber)) {
				continue;
			}
			rects.push({
				// margin layers are viewport-space: subtract the scroll (as the marker dots do)
				top: context.viewModel.getLineTop(lineNumber) - context.scrollTop + context.viewModel.getLineHeight() / 2 - 4,
				current: lineNumber === this._currentLine
			});
		}
		return rects;
	}
}
