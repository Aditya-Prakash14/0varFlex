// src/common/editor/common/viewModel/lineMapping.ts — the map between MODEL lines (what the text
// buffer has) and VIEW lines (what is laid out on screen).
//
// Ported in purpose from vs/editor/common/viewModel/viewModelLines.ts, which the reference calls
// the lines collection. That class does two jobs: hiding lines (folding) and splitting lines
// (word wrap). This does the first. It is the prerequisite both features share — docs/MASTERPROMPT
// records why they are one piece of work and not two.
//
// Everything is in one place because the alternative — every layer and contrib doing its own
// arithmetic on `(lineNumber - 1) * lineHeight` — is how a folded editor ends up drawing text at
// the wrong height in six subtly different ways.
//
// shortcut: hidden lines only, so one model line is at most one view line. Word wrap needs the
// inverse (one model line becoming several view lines), which widens `modelToView` to return a
// range rather than a number. The interface is shaped for that; the implementation is not there.

/** a closed range of model lines that are not drawn, e.g. the body of a collapsed region */
export interface IHiddenRange {
	/** the first hidden line — NOT the fold header, which stays visible */
	readonly startLineNumber: number;
	readonly endLineNumber: number;
}

/**
 * Merge overlapping or touching ranges and sort them.
 *
 * Nested folds produce overlapping ranges all the time (collapse an inner block, then the outer
 * one), and leaving them overlapping makes every count wrong rather than merely redundant.
 */
export function normalizeHiddenRanges(ranges: readonly IHiddenRange[]): IHiddenRange[] {
	const valid = ranges
		.filter(range => range.endLineNumber >= range.startLineNumber)
		.sort((a, b) => a.startLineNumber - b.startLineNumber);

	const merged: IHiddenRange[] = [];
	for (const range of valid) {
		const last = merged[merged.length - 1];
		// `+ 1` so two ranges that merely abut become one: [2,4] and [5,7] hide lines 2..7
		if (last && range.startLineNumber <= last.endLineNumber + 1) {
			if (range.endLineNumber > last.endLineNumber) {
				merged[merged.length - 1] = { startLineNumber: last.startLineNumber, endLineNumber: range.endLineNumber };
			}
			continue;
		}
		merged.push({ startLineNumber: range.startLineNumber, endLineNumber: range.endLineNumber });
	}
	return merged;
}

/**
 * The model ↔ view line map for a document with some lines hidden.
 *
 * Rebuilt whenever the hidden set or the line count changes, with a prefix-sum of hidden lines so
 * a lookup costs one step per COLLAPSED REGION and never one per line. That distinction is the
 * point: regions number in the dozens, lines in the hundreds of thousands, and a per-line walk
 * inside every layer's render pass would be the whole frame at the 100k-line budget.
 */
export class LineMapping {

	private _ranges: IHiddenRange[] = [];
	/** hidden lines strictly before each range, so a lookup is one binary search */
	private _hiddenBefore: number[] = [];
	private _hiddenTotal = 0;

	constructor(private _modelLineCount: number, hiddenRanges: readonly IHiddenRange[] = []) {
		this.setHiddenRanges(hiddenRanges);
	}

	setModelLineCount(modelLineCount: number): void {
		this._modelLineCount = Math.max(1, modelLineCount);
		// an edit can leave a range pointing past the end of the document
		this.setHiddenRanges(this._ranges);
	}

	setHiddenRanges(hiddenRanges: readonly IHiddenRange[]): void {
		const clamped = normalizeHiddenRanges(hiddenRanges)
			.map(range => ({
				startLineNumber: Math.max(1, range.startLineNumber),
				endLineNumber: Math.min(this._modelLineCount, range.endLineNumber)
			}))
			.filter(range => range.endLineNumber >= range.startLineNumber);

		this._ranges = clamped;
		this._hiddenBefore = [];
		let running = 0;
		for (const range of clamped) {
			this._hiddenBefore.push(running);
			running += range.endLineNumber - range.startLineNumber + 1;
		}
		this._hiddenTotal = running;
	}

	getHiddenRanges(): readonly IHiddenRange[] {
		return this._ranges;
	}

	hasHiddenLines(): boolean {
		return this._hiddenTotal > 0;
	}

	get modelLineCount(): number {
		return this._modelLineCount;
	}

	/** how many lines are actually drawn */
	get viewLineCount(): number {
		// never zero: a document whose every line is folded away would have no height at all and
		// nothing to click on
		return Math.max(1, this._modelLineCount - this._hiddenTotal);
	}

	/** the index of the range containing `modelLineNumber`, or -1 */
	private _rangeIndexAt(modelLineNumber: number): number {
		let low = 0;
		let high = this._ranges.length - 1;
		while (low <= high) {
			const middle = (low + high) >>> 1;
			const range = this._ranges[middle];
			if (modelLineNumber < range.startLineNumber) {
				high = middle - 1;
			} else if (modelLineNumber > range.endLineNumber) {
				low = middle + 1;
			} else {
				return middle;
			}
		}
		return -1;
	}

	isHidden(modelLineNumber: number): boolean {
		return this._rangeIndexAt(modelLineNumber) !== -1;
	}

	/** hidden lines strictly before `modelLineNumber` */
	private _hiddenCountBefore(modelLineNumber: number): number {
		let count = 0;
		for (let i = 0; i < this._ranges.length; i++) {
			const range = this._ranges[i];
			if (range.startLineNumber >= modelLineNumber) {
				break;
			}
			count += Math.min(range.endLineNumber, modelLineNumber - 1) - range.startLineNumber + 1;
		}
		return count;
	}

	/**
	 * The view line a model line is drawn at.
	 *
	 * A HIDDEN line maps to the last visible line above it — the fold header it is collapsed into.
	 * That is what makes "reveal this position" work while its region is folded: the caller gets a
	 * real place on screen instead of a line that is not drawn.
	 */
	modelToView(modelLineNumber: number): number {
		const clamped = Math.max(1, Math.min(modelLineNumber, this._modelLineCount));
		const rangeIndex = this._rangeIndexAt(clamped);
		if (rangeIndex !== -1) {
			const range = this._ranges[rangeIndex];
			// the line above the range is visible by construction: a fold never hides its header
			return Math.max(1, range.startLineNumber - 1 - this._hiddenBefore[rangeIndex]);
		}
		return clamped - this._hiddenCountBefore(clamped);
	}

	/** the model line drawn at a view line */
	viewToModel(viewLineNumber: number): number {
		const clamped = Math.max(1, Math.min(viewLineNumber, this.viewLineCount));
		let modelLineNumber = clamped;
		// walk the ranges in order, pushing the answer past each one that starts at or before it
		for (const range of this._ranges) {
			if (range.startLineNumber <= modelLineNumber) {
				modelLineNumber += range.endLineNumber - range.startLineNumber + 1;
			} else {
				break;
			}
		}
		return Math.min(modelLineNumber, this._modelLineCount);
	}

	/**
	 * The model lines to draw for a view-line range, hidden ones left out.
	 *
	 * Returned as an explicit list rather than a range because that is what the layers need: they
	 * loop it directly and so cannot forget to skip a folded line.
	 */
	modelLinesForViewRange(startViewLine: number, endViewLine: number): number[] {
		const lines: number[] = [];
		const first = Math.max(1, startViewLine);
		const last = Math.min(this.viewLineCount, endViewLine);
		for (let viewLine = first; viewLine <= last; viewLine++) {
			lines.push(this.viewToModel(viewLine));
		}
		return lines;
	}
}
