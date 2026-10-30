// src/renderer/editor/browser/controller/cursorController.ts — the cursor/selection state
// machine, ported in shape from vs/editor/common/cursor/oneCursor.ts + cursorMoveCommands.ts:
// the controller owns `Selection` (anchor/active) and the desired column, and every movement
// funnels through _applyMove. Movement SEMANTICS live in core/cursorColumns.ts (pure).
//
// The track* methods port the shape of upstream's handlers:
//   - plain move collapses the selection, selecting mode extends from the anchor;
//   - Up/Down with an existing selection and !isSelecting move relative to the selection
//     start/end respectively (CursorMoveCommands.moveUp/moveDown);
//   - PageUp/Down move by host.getPageSize() lines
//     (cursorCommon: max(1, floor(viewportHeight / lineHeight) - 2) — ported exactly).

import { Disposable } from '../../../../common/base/common/lifecycle.js';
import { Position } from '../../../../common/editor/common/core/position.js';
import type { TextModel } from '../../../../common/editor/common/model/textModel.js';
import {
	firstNonWhitespaceColumn,
	moveLeft,
	moveRight,
	moveToBeginningOfLine,
	moveToEndOfLine,
	moveWordLeft,
	moveWordRight,
	verticalMove,
	WordNavigationType
} from '../core/cursorColumns.js';
import { Selection } from '../core/selection.js';
import { ViewModel } from '../viewModel.js';

export const enum MoveType {
	Left,
	Right,
	Up,
	Down,
	WordLeft,
	WordRightEnd,
	/** Home key: the first-non-whitespace ↔ column-1 toggle (port of moveToBeginningOfLine) */
	LineStart,
	/** explicit column 1, no toggle (real cursorLineStart) */
	LineStartHard,
	LineEnd,
	/** first non-whitespace column, no toggle */
	WLineStart,
	WLineEnd,
	PageUp,
	PageDown,
	DocStart,
	DocEnd
}

export interface ICursorControllerHost {
	/** page size in lines — the widget computes it from the viewport (port of cursorCommon.pageSize) */
	getPageSize(): number;
	onDidChangeCursor(): void;
}

export class CursorController extends Disposable {

	private _model: TextModel | null = null;
	private _selection: Selection = new Selection(1, 1, 1, 1);
	/** upstream's leftoverVisibleColumns: the desired column survives short lines through this */
	private _leftoverVisibleColumns = 0;

	constructor(
		private readonly _viewModel: ViewModel,
		private readonly _host: ICursorControllerHost
	) {
		super();
	}

	setModel(model: TextModel): void {
		this._model = model;
		this.setSelection(new Selection(1, 1, 1, 1));
	}

	getSelection(): Selection {
		return this._selection;
	}

	setSelection(selection: Selection): void {
		this._selection = this._clampSelection(selection);
		this._leftoverVisibleColumns = 0;
		this._host.onDidChangeCursor();
	}

	/** the mouse path: keep the anchor, move the active end */
	setSelectionByMouse(anchor: Position, active: Position): void {
		this.setSelection(new Selection(anchor.lineNumber, anchor.column, active.lineNumber, active.column));
	}

	collapseTo(position: Position): void {
		this.setSelection(Selection.fromPositions(position));
	}

	moveCursor(moveType: MoveType, isSelecting: boolean): void {
		const model = this._model;
		if (!model) {
			return;
		}
		const selection = this._selection;
		const active = selection.getPosition();
		let newPosition = active;
		let leftover = 0;

		switch (moveType) {
			case MoveType.Left:
				newPosition = moveLeft(model, active);
				break;
			case MoveType.Right:
				newPosition = moveRight(model, active);
				break;
			case MoveType.WordLeft:
				newPosition = moveWordLeft(model, active, WordNavigationType.WordStartFast);
				break;
			case MoveType.WordRightEnd:
				newPosition = moveWordRight(model, active, WordNavigationType.WordEnd);
				break;
			case MoveType.LineStart: {
				const lineText = model.getLineContent(active.lineNumber);
				newPosition = new Position(active.lineNumber, moveToBeginningOfLine(lineText, active.column));
				break;
			}
			case MoveType.LineStartHard: {
				newPosition = new Position(active.lineNumber, 1);
				break;
			}
			case MoveType.LineEnd: {
				const lineText = model.getLineContent(active.lineNumber);
				newPosition = new Position(active.lineNumber, moveToEndOfLine(lineText));
				break;
			}
			case MoveType.WLineStart: {
				const lineText = model.getLineContent(active.lineNumber);
				newPosition = new Position(active.lineNumber, firstNonWhitespaceColumn(lineText) || 1);
				break;
			}
			case MoveType.WLineEnd: {
				const lineText = model.getLineContent(active.lineNumber);
				newPosition = new Position(active.lineNumber, moveToEndOfLine(lineText));
				break;
			}
			case MoveType.Up: {
				const base = selection.isEmpty() || isSelecting ? active : selection.getSelectionStart();
				const result = verticalMove(model, this._viewModel, base.lineNumber, base.column, this._leftoverVisibleColumns, base.lineNumber - 1, true);
				newPosition = new Position(result.lineNumber, result.column);
				leftover = result.leftoverVisibleColumns;
				break;
			}
			case MoveType.Down: {
				const base = selection.isEmpty() || isSelecting ? active : selection.getSelectionEnd();
				const result = verticalMove(model, this._viewModel, base.lineNumber, base.column, this._leftoverVisibleColumns, base.lineNumber + 1, true);
				newPosition = new Position(result.lineNumber, result.column);
				leftover = result.leftoverVisibleColumns;
				break;
			}
			case MoveType.PageUp:
			case MoveType.PageDown: {
				const base = selection.isEmpty() || isSelecting ? active : selection.getSelectionStart();
				const delta = moveType === MoveType.PageUp ? -this._host.getPageSize() : this._host.getPageSize();
				const result = verticalMove(model, this._viewModel, base.lineNumber, base.column, this._leftoverVisibleColumns, base.lineNumber + delta, true);
				newPosition = new Position(result.lineNumber, result.column);
				leftover = result.leftoverVisibleColumns;
				break;
			}
			case MoveType.DocStart:
				newPosition = new Position(1, 1);
				break;
			case MoveType.DocEnd:
				newPosition = new Position(model.getLineCount(), model.getLineMaxColumn(model.getLineCount()));
				break;
		}

		this._applyMove(newPosition, isSelecting, leftover);
	}

	private _applyMove(position: Position, isSelecting: boolean, leftover: number): void {
		if (isSelecting) {
			this._selection = new Selection(
				this._selection.anchorLineNumber,
				this._selection.anchorColumn,
				position.lineNumber,
				position.column
			);
		} else {
			this._selection = Selection.fromPositions(position);
		}
		this._leftoverVisibleColumns = leftover;
		this._host.onDidChangeCursor();
	}

	private _clampSelection(selection: Selection): Selection {
		const model = this._model;
		if (!model) {
			return selection;
		}
		const clamp = (position: Position) => new Position(
			Math.max(1, Math.min(position.lineNumber, model.getLineCount())),
			Math.max(1, Math.min(position.column, model.getLineMaxColumn(Math.max(1, Math.min(position.lineNumber, model.getLineCount())))))
		);
		const anchor = clamp(selection.anchor);
		const active = clamp(selection.active);
		if (anchor.equals(selection.anchor) && active.equals(selection.active)) {
			return selection;
		}
		return new Selection(anchor.lineNumber, anchor.column, active.lineNumber, active.column);
	}
}
