// src/common/editor/common/model/multiCursor.ts — the bookkeeping behind several cursors.
//
// Ported in behaviour from vs/editor/common/cursor/cursorCollection.ts (normalisation) and
// vs/editor/contrib/multicursor/browser/multicursor.ts (the add-cursor commands).
//
// The editor keeps ONE primary selection plus any number of secondaries, which is the reference's
// shape and the reason `getSelection()` can keep meaning "the primary" everywhere it is already
// called. Everything here is a pure function of a selection list, because the parts that go wrong
// — two cursors drifting onto the same spot, and turning N cursors into N edits that do not
// disturb each other — are arithmetic, not UI.

import { Range } from '../core/range.js';

/** the minimum a selection must expose for this bookkeeping; `Selection` satisfies it */
export interface ICursorSelection {
	readonly startLineNumber: number;
	readonly startColumn: number;
	readonly endLineNumber: number;
	readonly endColumn: number;
	readonly anchorLineNumber: number;
	readonly anchorColumn: number;
	readonly activeLineNumber: number;
	readonly activeColumn: number;
}

function comparePositions(aLine: number, aColumn: number, bLine: number, bColumn: number): number {
	return aLine !== bLine ? aLine - bLine : aColumn - bColumn;
}

/** true when two selections cover the same span — not merely the same cursor position */
function isSameSelection(a: ICursorSelection, b: ICursorSelection): boolean {
	return a.startLineNumber === b.startLineNumber && a.startColumn === b.startColumn
		&& a.endLineNumber === b.endLineNumber && a.endColumn === b.endColumn;
}

/** true when two selections share any character, or when either empty cursor sits in the other */
export function selectionsOverlap(a: ICursorSelection, b: ICursorSelection): boolean {
	const aEmpty = a.startLineNumber === a.endLineNumber && a.startColumn === a.endColumn;
	const bEmpty = b.startLineNumber === b.endLineNumber && b.startColumn === b.endColumn;

	// two empty cursors collide only in the SAME place
	if (aEmpty && bEmpty) {
		return a.startLineNumber === b.startLineNumber && a.startColumn === b.startColumn;
	}

	// an empty cursor must be STRICTLY inside a selection to collide with it: one sitting at
	// either edge of a selected word is a legitimate separate cursor
	if (aEmpty || bEmpty) {
		const empty = aEmpty ? a : b;
		const other = aEmpty ? b : a;
		return comparePositions(empty.startLineNumber, empty.startColumn, other.startLineNumber, other.startColumn) > 0
			&& comparePositions(empty.startLineNumber, empty.startColumn, other.endLineNumber, other.endColumn) < 0;
	}

	// two selections: end columns are EXCLUSIVE, so `[1,5)` and `[5,9)` are adjacent and share no
	// character. Comparing with `> 0` instead of `>= 0` here would merge every pair of
	// back-to-back selections into one.
	const aStartsAtOrAfterBEnd = comparePositions(a.startLineNumber, a.startColumn, b.endLineNumber, b.endColumn) >= 0;
	const bStartsAtOrAfterAEnd = comparePositions(b.startLineNumber, b.startColumn, a.endLineNumber, a.endColumn) >= 0;
	return !aStartsAtOrAfterBEnd && !bStartsAtOrAfterAEnd;
}

/**
 * Sort the cursors into document order and drop the ones that have collided.
 *
 * Cursors merge as soon as they overlap — typing or moving will march them into each other, and
 * two cursors in one place means every keystroke is applied twice there. The reference calls this
 * normalisation and runs it after every cursor change; so do we.
 *
 * `primaryIndex` follows its selection through the sort, so the primary stays the primary. When
 * the primary is the one dropped, the survivor it merged into becomes primary.
 */
export function normalizeCursors<T extends ICursorSelection>(
	selections: readonly T[],
	primaryIndex: number
): { selections: T[]; primaryIndex: number } {
	if (selections.length === 0) {
		return { selections: [], primaryIndex: 0 };
	}

	const tagged = selections.map((selection, index) => ({ selection, isPrimary: index === primaryIndex }));
	tagged.sort((a, b) =>
		comparePositions(a.selection.startLineNumber, a.selection.startColumn, b.selection.startLineNumber, b.selection.startColumn)
		|| comparePositions(a.selection.endLineNumber, a.selection.endColumn, b.selection.endLineNumber, b.selection.endColumn));

	const kept: { selection: T; isPrimary: boolean }[] = [];
	for (const candidate of tagged) {
		const collision = kept.find(existing =>
			isSameSelection(existing.selection, candidate.selection)
			|| selectionsOverlap(existing.selection, candidate.selection));
		if (collision) {
			// the survivor inherits primary-ness, so the primary is never lost in a merge
			collision.isPrimary = collision.isPrimary || candidate.isPrimary;
			continue;
		}
		kept.push(candidate);
	}

	const resolved = kept.findIndex(entry => entry.isPrimary);
	return {
		selections: kept.map(entry => entry.selection),
		primaryIndex: resolved === -1 ? kept.length - 1 : resolved
	};
}

/** one cursor's share of a multi-cursor edit */
export interface ICursorEdit {
	readonly range: Range;
	readonly text: string;
}

/**
 * Turn N cursors into N edits.
 *
 * The ranges are the selections themselves, so typing replaces each selection exactly as it does
 * with one cursor. They are returned in document order and are non-overlapping — normalisation
 * guarantees that — which is what lets the model apply them as a single undo element.
 */
export function editsForCursors(selections: readonly ICursorSelection[], text: string): ICursorEdit[] {
	return selections.map(selection => ({
		range: new Range(selection.startLineNumber, selection.startColumn, selection.endLineNumber, selection.endColumn),
		text
	}));
}

/**
 * Where each cursor ends up after every cursor inserted `text`.
 *
 * Each cursor is displaced by every edit BEFORE it, which is the whole difficulty: cursor 3 has
 * had two insertions pushed in above it and its line number has to account for both. Computed
 * from the insertion's own line count rather than by re-measuring the document, so this needs no
 * model and is testable.
 *
 * Only correct for insertions that replace the selection with `text` — the one case the type
 * handler produces.
 */
export function positionsAfterInsert(
	selections: readonly ICursorSelection[],
	text: string
): { lineNumber: number; column: number }[] {
	const addedLines = text.split('\n').length - 1;
	const lastLineLength = addedLines === 0 ? text.length : text.length - text.lastIndexOf('\n') - 1;

	const result: { lineNumber: number; column: number }[] = [];
	// how many lines every earlier edit has added or removed, and the column shift that applies
	// only while we are still on the same line as the previous edit
	let lineDelta = 0;

	for (let i = 0; i < selections.length; i++) {
		const selection = selections[i];
		const startLine = selection.startLineNumber + lineDelta;

		if (addedLines === 0) {
			// a single-line insertion: earlier edits on this same line pushed the column right
			result.push({
				lineNumber: startLine,
				column: selection.startColumn + text.length + accumulatedShiftOnLine(selections, i, text)
			});
		} else {
			// the cursor lands on the last inserted line, whose column comes from the text itself
			result.push({ lineNumber: startLine + addedLines, column: lastLineLength + 1 });
		}

		lineDelta += addedLines - (selection.endLineNumber - selection.startLineNumber);
	}

	return result;
}

/**
 * How far right the edits before index `i` have pushed text on `i`'s start line.
 *
 * Walks back over the contiguous run of earlier selections that end on the same line, since only
 * those move columns on it.
 */
function accumulatedShiftOnLine(
	selections: readonly ICursorSelection[],
	index: number,
	text: string
): number {
	const line = selections[index].startLineNumber;
	let shift = 0;
	for (let j = index - 1; j >= 0; j--) {
		const earlier = selections[j];
		if (earlier.endLineNumber !== line) {
			break;
		}
		shift += text.length - (earlier.endColumn - earlier.startColumn);
	}
	return shift;
}
