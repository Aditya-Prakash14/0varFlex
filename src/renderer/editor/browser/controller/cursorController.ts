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
import { normalizeCursors } from '../../../../common/editor/common/model/multiCursor.js';
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
	/** B2: the extra cursors; the primary is kept separate so getSelection() still means one thing */
	private _secondary: Selection[] = [];
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

	/** the PRIMARY selection — what every existing caller means by "the selection" */
	getSelection(): Selection {
		return this._selection;
	}

	/**
	 * B2: every cursor, in document order, primary included.
	 *
	 * The split into one primary plus secondaries is the reference's shape, and the reason
	 * `getSelection()` keeps its meaning at all 52 call sites that already use it.
	 */
	getSelections(): Selection[] {
		return [this._selection, ...this._secondary];
	}

	hasMultipleCursors(): boolean {
		return this._secondary.length > 0;
	}

	setSelection(selection: Selection): void {
		this._selection = this._clampSelection(selection);
		// a plain selection change collapses to one cursor: clicking or moving with extra cursors
		// still active would leave orphans behind that the user cannot see the origin of
		this._secondary = [];
		this._leftoverVisibleColumns = 0;
		this._host.onDidChangeCursor();
	}

	/**
	 * Replace the whole cursor set.
	 *
	 * Normalised on the way in, so cursors that have collided merge rather than doubling every
	 * keystroke at that spot.
	 */
	setSelections(selections: readonly Selection[], primaryIndex: number = 0): void {
		if (selections.length === 0) {
			return;
		}
		const clamped = selections.map(selection => this._clampSelection(selection));
		const normalized = normalizeCursors(clamped, primaryIndex);
		this._selection = normalized.selections[normalized.primaryIndex];
		this._secondary = normalized.selections.filter((_, index) => index !== normalized.primaryIndex);
		this._leftoverVisibleColumns = 0;
		this._host.onDidChangeCursor();
	}

	/** drop the extra cursors, keeping the primary — what Escape does */
	collapseToPrimary(): void {
		if (this._secondary.length === 0) {
			return;
		}
		this._secondary = [];
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
		// moving the primary collapses the set. The reference moves every cursor independently,
		// which needs the whole move computation per cursor; collapsing is the honest smaller
		// behaviour and matches what Escape does.
		// shortcut: arrow keys collapse to one cursor instead of moving all of them. Upgrade by
		// running `moveCursor` per selection once the move helpers take a selection parameter.
		this._secondary = [];
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
