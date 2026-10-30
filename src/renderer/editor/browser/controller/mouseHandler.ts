// src/renderer/editor/browser/controller/mouseHandler.ts — mouse → position, ported in spirit
// from vs/editor/browser/controller/mouseHandler.ts + mouseTarget.ts:
//
//   - x→column prefers `document.caretRangeFromPoint` (it matches the RENDERED text, so tabs
//     and the browser's own hit testing are free), falling back to char-width math;
//   - click / drag / double (word) / triple (line), clamping click-past-the-end to the line's
//     max column;
//   - drag-scrolling: dragging past the viewport edge auto-scrolls (dragScrolling.ts).
//
// shortcut: no full mouseTarget.ts hit-test layer, no word-wise drag extension, no right-click
// context menu (it arrives with the editor actions in 09).

import { Disposable, IDisposable } from '../../../../common/base/common/lifecycle.js';
import { Position } from '../../../../common/editor/common/core/position.js';
import type { TextModel } from '../../../../common/editor/common/model/textModel.js';
import { addDisposableListener } from '../../../base/browser/dom.js';
import { getWordOrSeparatorAtColumn } from '../core/cursorColumns.js';
import { View } from '../view.js';
import { ViewModel } from '../viewModel.js';
import type { ViewLinesLayer } from '../layers/viewLines.js';

export interface IMouseHandlerHost {
	getModel(): TextModel | null;
	getViewModel(): ViewModel;
	getLinesLayer(): ViewLinesLayer;
	setSelectionByMouse(anchor: Position, active: Position): void;
	focus(): void;
}

const DRAG_SCROLL_INTERVAL = 50;

export class MouseHandler extends Disposable {

	private _dragAnchor: Position | null = null;
	private _lastClientX = 0;
	private _lastClientY = 0;
	private _dragScrollTimer: number | null = null;
	private _dragMoveListener: IDisposable | null = null;
	private _dragUpListener: IDisposable | null = null;

	constructor(private readonly _view: View, private readonly _host: IMouseHandlerHost) {
		super();
		// mousedown (not pointerdown): MouseEvent.detail is the reliable click count, which
		// drives double-/triple-click selection
		this._register(addDisposableListener(this._view.element, 'mousedown', (e: MouseEvent) => this._onMouseDown(e)));
		// shortcut: right-click is a placeholder — the real context menu comes with 09's actions
		this._register(addDisposableListener(this._view.element, 'contextmenu', (e: MouseEvent) => e.preventDefault()));
	}

	override dispose(): void {
		this._stopDragging();
		super.dispose();
	}

	/** a drag: window-level listeners (the classic mouseHandler pattern) */
	private _onMouseDown(event: MouseEvent): void {
		if (event.button === 2) {
			event.preventDefault();
			return;
		}
		if (event.button !== 0) {
			return;
		}
		event.preventDefault();
		this._host.focus();

		const model = this._host.getModel();
		if (!model) {
			return;
		}
		const position = this._positionAt(event.clientX, event.clientY);
		const lineNumber = position.lineNumber;
		const detail = event.detail || 1;

		if (detail === 2) {
			const word = getWordOrSeparatorAtColumn(model.getLineContent(lineNumber), position.column);
			if (word) {
				this._host.setSelectionByMouse(
					new Position(lineNumber, word.startColumn),
					new Position(lineNumber, word.endColumn)
				);
			}
			this._stopDragging();
			return;
		}

		if (detail >= 3) {
			this._host.setSelectionByMouse(
				new Position(lineNumber, 1),
				new Position(lineNumber, model.getLineMaxColumn(lineNumber))
			);
			this._stopDragging();
			return;
		}

		this._host.setSelectionByMouse(position, position);
		this._dragAnchor = position;
		this._lastClientX = event.clientX;
		this._lastClientY = event.clientY;

		this._dragMoveListener = addDisposableListener(window, 'mousemove', (e: MouseEvent) => this._onMouseMove(e));
		this._dragUpListener = addDisposableListener(window, 'mouseup', () => this._stopDragging());
	}

	private _onMouseMove(event: MouseEvent): void {
		if (!this._dragAnchor) {
			return;
		}
		this._lastClientX = event.clientX;
		this._lastClientY = event.clientY;
		this._updateDragSelection();
		this._updateDragScrolling();
	}

	private _stopDragging(): void {
		this._dragAnchor = null;
		this._stopDragScrolling();
		this._dragMoveListener?.dispose();
		this._dragMoveListener = null;
		this._dragUpListener?.dispose();
		this._dragUpListener = null;
	}

	private _updateDragSelection(): void {
		if (!this._dragAnchor) {
			return;
		}
		const position = this._positionAt(this._lastClientX, this._lastClientY);
		this._host.setSelectionByMouse(this._dragAnchor, position);
	}

	private _updateDragScrolling(): void {
		const rect = this._view.scrollableElement.getBoundingClientRect();
		const outside = this._lastClientY < rect.top + 3 || this._lastClientY > rect.bottom - 3;
		if (!outside) {
			this._stopDragScrolling();
			return;
		}
		if (this._dragScrollTimer !== null) {
			return;
		}
		this._dragScrollTimer = window.setInterval(() => {
			if (!this._dragAnchor) {
				this._stopDragScrolling();
				return;
			}
			const rect = this._view.scrollableElement.getBoundingClientRect();
			const direction = this._lastClientY < rect.top ? -1 : 1;
			this._view.setScrollTop(this._view.getScrollTop() + direction * this._host.getViewModel().getLineHeight());
			this._updateDragSelection();
		}, DRAG_SCROLL_INTERVAL);
	}

	private _stopDragScrolling(): void {
		if (this._dragScrollTimer !== null) {
			window.clearInterval(this._dragScrollTimer);
			this._dragScrollTimer = null;
		}
	}

	private _positionAt(clientX: number, clientY: number): Position {
		const model = this._host.getModel()!;
		const viewModel = this._host.getViewModel();

		// preferred: the browser's own hit testing against the rendered text
		const range = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(clientX, clientY);
		if (range) {
			const found = this._host.getLinesLayer().columnAtDomRange(range.startContainer, range.startOffset, viewModel);
			if (found) {
				return new Position(found.lineNumber, Math.min(found.column, model.getLineMaxColumn(found.lineNumber)));
			}
		}

		// fallback: char-width math (tab-aware through the view model)
		const rect = this._view.scrollableElement.getBoundingClientRect();
		const x = clientX - rect.left + this._view.scrollableElement.scrollLeft;
		const y = clientY - rect.top;
		return viewModel.getViewPositionFromCoordinates(this._view.getScrollTop(), x, y, lineNumber => model.getLineContent(lineNumber));
	}
}
