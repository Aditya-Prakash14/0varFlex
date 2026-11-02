// src/common/editor/common/model/formattingEdits.ts — turning the text edits a formatting
// provider hands back into a list that is safe to push onto the model.
//
// Ported in behaviour from vs/editor/contrib/format/browser/format.ts, which sorts provider
// edits, treats intersecting edits as a provider bug, and bails out before touching the model
// when the edit list is empty. The reference reaches the "nothing to do" case through the worker's
// computeMoreMinimalEdits; with no worker here the trimming happens in this file instead.
//
// shortcut: whole-edit no-op detection only. The reference's computeMoreMinimalEdits diffs each
// edit against the model and shrinks it to the characters that really differ, so a whole-document
// edit that changes one line becomes one small edit; here it stays whole, which widens the undo
// step and moves markers inside it. Upgrade when there is a diff algorithm and a worker to run it.
//
// The model is taken as a small interface so all of this is testable without a widget, the way
// bracketMatching.ts does.

import { IRange, Range } from '../core/range.js';

/** the model surface these functions read */
export interface IFormattingSource {
	getValueInRange(range: IRange): string;
}

/** what a provider returns: replace `range` with `text` */
export interface ITextEdit {
	readonly range: IRange;
	readonly text: string;
}

export interface IPreparedFormattingEdits {
	/** in document order, no no-ops, touching edits merged; safe to push as one undo step */
	readonly edits: readonly ITextEdit[];
	/** false when applying `edits` would leave the document byte-identical, so the caller can skip */
	readonly hasChanges: boolean;
	/**
	 * Set when the provider returned two edits that overlap, which is a provider bug: the pair of
	 * ranges, in document order. `edits` is then empty and nothing may be applied.
	 */
	readonly overlap?: readonly [IRange, IRange];
}

function comparePositions(aLine: number, aColumn: number, bLine: number, bColumn: number): number {
	return aLine !== bLine ? aLine - bLine : aColumn - bColumn;
}

/** document order by start, then by end, so a zero-width insert sorts before a replace at the same spot */
export function compareEditsUsingStarts(a: ITextEdit, b: ITextEdit): number {
	const byStart = comparePositions(a.range.startLineNumber, a.range.startColumn, b.range.startLineNumber, b.range.startColumn);
	return byStart !== 0
		? byStart
		: comparePositions(a.range.endLineNumber, a.range.endColumn, b.range.endLineNumber, b.range.endColumn);
}

/** provider edits in document order; the input is left alone */
export function sortFormattingEdits(edits: readonly ITextEdit[]): ITextEdit[] {
	return edits.slice().sort(compareEditsUsingStarts);
}

/**
 * The first pair of sorted edits that overlap, or undefined.
 *
 * Touching is not overlapping: two edits that meet at one position describe disjoint stretches of
 * text and apply cleanly, which is why mergeTouchingEdits below can join them.
 */
function findOverlap(sorted: readonly ITextEdit[]): readonly [IRange, IRange] | undefined {
	for (let i = 1; i < sorted.length; i++) {
		const previous = sorted[i - 1].range;
		const current = sorted[i].range;
		if (comparePositions(current.startLineNumber, current.startColumn, previous.endLineNumber, previous.endColumn) < 0) {
			return [previous, current];
		}
	}
	return undefined;
}

/**
 * Drop edits whose replacement is already the text in the model.
 *
 * This is what makes an empty format a true no-op: a provider that returns the whole document
 * unchanged must not dirty the file or push an undo step.
 */
function dropNoOps(source: IFormattingSource, sorted: readonly ITextEdit[]): ITextEdit[] {
	return sorted.filter(edit => edit.text !== source.getValueInRange(edit.range));
}

/**
 * Join edits that meet exactly, so a formatter's run of per-token edits becomes fewer operations.
 *
 * Only exactly touching edits are merged. Merging across a gap is NOT safe: the text between them
 * would have to be carried into the replacement, which rewrites characters the formatter never
 * asked to change and so moves any cursor or marker sitting inside that gap.
 */
function mergeTouchingEdits(edits: readonly ITextEdit[]): ITextEdit[] {
	const result: ITextEdit[] = [];
	for (const edit of edits) {
		const previous = result[result.length - 1];
		if (previous && comparePositions(
			previous.range.endLineNumber, previous.range.endColumn,
			edit.range.startLineNumber, edit.range.startColumn
		) === 0) {
			result[result.length - 1] = {
				range: new Range(
					previous.range.startLineNumber, previous.range.startColumn,
					edit.range.endLineNumber, edit.range.endColumn
				),
				text: previous.text + edit.text
			};
		} else {
			result.push(edit);
		}
	}
	return result;
}

/**
 * Sort, validate and trim provider edits.
 *
 * `hasChanges` lets a caller make "format with no provider" and "format that changes nothing"
 * behave the same, which is the point: neither should dirty the file.
 */
export function prepareFormattingEdits(source: IFormattingSource, edits: readonly ITextEdit[]): IPreparedFormattingEdits {
	const sorted = sortFormattingEdits(edits);
	const overlap = findOverlap(sorted);
	if (overlap) {
		return { edits: [], hasChanges: false, overlap };
	}
	const effective = mergeTouchingEdits(dropNoOps(source, sorted));
	return { edits: effective, hasChanges: effective.length > 0 };
}
