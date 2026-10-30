// src/common/editor/common/model/editStack.ts — undo/redo with the classic VS Code grouping
// rules (vs/editor/common/model/editStack.ts, pre-UndoRedoService architecture):
//
//   1. explicit boundaries via pushStackElement()
//   2. automatic: consecutive edits merge while they keep coming within CONTINUATION_TIME
//      (a pause starts a new undo unit)
//   3. an edit that crosses a line break closes the unit — typing across a newline starts
//      a new element
//
// Each element stores the text changes (for inverse application), the cursor state before and
// after (opaque here — selections arrive in 08) and when its last edit happened.

import { TextChange } from '../core/textChange.js';

/** fast consecutive typing merges into one undo unit inside this window (ms) */
export const CONTINUATION_TIME = 600;

export type CursorState = unknown;

export interface IEditStackElement {
	storedAt: number;
	readonly beforeCursorState: CursorState | null;
	changes: TextChange[];
	afterCursorState: CursorState | null;
	/**
	 * how many separate pushes merged into this element. The alternative version steps by this
	 * count on undo/redo — one step per push, so undoing a merged run lands EXACTLY on the
	 * version the run started from (isModified turns clean again).
	 */
	pushes: number;
}

export class EditStack {

	private readonly _undoStack: IEditStackElement[] = [];
	private readonly _redoStack: IEditStackElement[] = [];
	/** an explicit boundary (or an EOL edit) closed the top element: the next edit starts fresh */
	private _closed = true;

	constructor(private readonly _now: () => number = () => Date.now()) { }

	pushStackElement(): void {
		this._closed = true;
	}

	pushChange(changes: TextChange[], beforeCursorState: CursorState | null, afterCursorState: CursorState | null, isEol: boolean): void {
		// any new edit kills the redo branch
		this._redoStack.length = 0;

		// the EOL rule: an edit crossing a line break starts a new element (it does not merge
		// into the previous typing run)
		if (isEol) {
			this._closed = true;
		}

		const now = this._now();
		let element = this._undoStack[this._undoStack.length - 1];

		const canMerge = !!element && !this._closed && (now - element.storedAt) < CONTINUATION_TIME;
		if (!canMerge) {
			element = { changes: [], beforeCursorState, afterCursorState: null, storedAt: now, pushes: 0 };
			this._undoStack.push(element);
		}

		element.changes.push(...changes);
		element.afterCursorState = afterCursorState;
		element.storedAt = now;
		element.pushes += 1;

		// subsequent edits may merge into this element
		this._closed = false;
	}

	undo(): IEditStackElement | undefined {
		const element = this._undoStack.pop();
		if (!element) {
			return undefined;
		}
		this._redoStack.push(element);
		this._closed = true;
		return element;
	}

	redo(): IEditStackElement | undefined {
		const element = this._redoStack.pop();
		if (!element) {
			return undefined;
		}
		this._undoStack.push(element);
		this._closed = true;
		return element;
	}

	canUndo(): boolean {
		return this._undoStack.length > 0;
	}

	canRedo(): boolean {
		return this._redoStack.length > 0;
	}

	clear(): void {
		this._undoStack.length = 0;
		this._redoStack.length = 0;
		this._closed = true;
	}
}
