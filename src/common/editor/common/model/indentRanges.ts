// src/common/editor/common/model/indentRanges.ts — the nesting structure of a file, read from
// its indentation.
//
// Ported in behaviour from vs/editor/common/model/indentationGuesser.ts and the
// indentation-based range provider in vs/editor/contrib/folding/browser/indentRangeProvider.ts.
// The reference prefers a language-aware provider and falls back to this; we only have this, so
// it is the whole answer rather than the fallback.
//
// Two consumers: sticky scroll (which enclosing lines to pin) and, later, folding. Shared because
// "which lines does this block cover" has one correct answer per file and no reason to be
// computed two different ways.

export interface IIndentSource {
	getLineCount(): number;
	getLineContent(lineNumber: number): string;
}

export interface IIndentRange {
	/** the line holding the header — `function f() {`, `if x:` */
	readonly startLineNumber: number;
	/** the last line belonging to the block */
	readonly endLineNumber: number;
	/** the header's indentation, in columns */
	readonly indent: number;
}

/** the indentation of a line in columns, with tabs counted as `tabSize`; -1 for a blank line */
export function indentLevelOf(line: string, tabSize: number): number {
	let indent = 0;
	for (let i = 0; i < line.length; i++) {
		const character = line[i];
		if (character === '\t') {
			indent += tabSize - (indent % tabSize);
		} else if (character === ' ') {
			indent++;
		} else {
			return indent;
		}
	}
	return -1; // whitespace only: it belongs to whichever block surrounds it
}

/**
 * Every block in the file, as the ranges their headers open.
 *
 * A line opens a block when a later line is indented deeper than it, and the block runs to the
 * last line before the indentation returns to the header's level or shallower. Blank lines do not
 * end a block — a blank line between two statements is inside the function, not after it, and
 * treating it as a terminator is the classic way this computation looks right until someone
 * leaves a gap in their code.
 *
 * Returned sorted by start line, which is the order both consumers walk.
 */
export function computeIndentRanges(source: IIndentSource, tabSize: number = 4): IIndentRange[] {
	const lineCount = source.getLineCount();
	const ranges: IIndentRange[] = [];

	// a stack of open blocks, shallowest first
	const open: { startLineNumber: number; indent: number }[] = [];
	// the last line that had actual content, so blank lines never close a block
	let lastContentLine = 0;

	for (let lineNumber = 1; lineNumber <= lineCount; lineNumber++) {
		const indent = indentLevelOf(source.getLineContent(lineNumber), tabSize);
		if (indent === -1) {
			continue; // blank: no opinion about structure
		}

		// close every block this line has stepped back out of
		while (open.length > 0 && open[open.length - 1].indent >= indent) {
			const block = open.pop()!;
			if (lastContentLine > block.startLineNumber) {
				ranges.push({ startLineNumber: block.startLineNumber, endLineNumber: lastContentLine, indent: block.indent });
			}
		}

		open.push({ startLineNumber: lineNumber, indent });
		lastContentLine = lineNumber;
	}

	// whatever is still open runs to the last line with content
	while (open.length > 0) {
		const block = open.pop()!;
		if (lastContentLine > block.startLineNumber) {
			ranges.push({ startLineNumber: block.startLineNumber, endLineNumber: lastContentLine, indent: block.indent });
		}
	}

	return ranges.sort((a, b) => a.startLineNumber - b.startLineNumber);
}

/**
 * The blocks enclosing `lineNumber`, outermost first.
 *
 * A block encloses a line when the line is strictly inside it: the header itself is not "inside"
 * its own block, because a header pinned above itself is a duplicated line on screen.
 */
export function enclosingRanges(ranges: readonly IIndentRange[], lineNumber: number): IIndentRange[] {
	return ranges
		.filter(range => range.startLineNumber < lineNumber && lineNumber <= range.endLineNumber)
		.sort((a, b) => a.startLineNumber - b.startLineNumber);
}

/**
 * The headers to pin above the viewport when its first visible line is `topLineNumber`.
 *
 * Capped at `maxCount`, keeping the OUTERMOST scopes: deep nesting would otherwise pin away the
 * whole viewport, and the outer scopes are the ones you have lost track of.
 */
export function stickyLinesFor(
	ranges: readonly IIndentRange[],
	topLineNumber: number,
	maxCount: number
): IIndentRange[] {
	// `enclosingRanges` already requires the header to be above `topLineNumber`, so every scope it
	// returns has scrolled out of view and is worth pinning
	return enclosingRanges(ranges, topLineNumber).slice(0, Math.max(0, maxCount));
}
