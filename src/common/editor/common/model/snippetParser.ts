// src/common/editor/common/model/snippetParser.ts — the snippet contract this project uses,
// implemented on top of VS Code's own parser.
//
// This file used to be a 234-line hand-written parser that supported placeholders and nothing
// else: it carried `shortcut:` comments admitting it had no choices, no variables and no
// transformations. The upstream parser is 1,154 lines, has all of those, is tested by millions of
// users, and its entire transitive import closure is TWO files. Retyping a worse version of it was
// the wrong call; it now lives verbatim under src/vendor/vscode/ and this file is the adapter.
//
// See src/vendor/vscode/README.md for the rule that decides vendor-vs-port: it is the size of a
// file's import closure, not preference. Two files can be taken; three hundred cannot.
//
// The interface below is UNCHANGED from the hand-written version, so the snippet controller and
// its tests did not have to move. What changed is what answers.

import { IPosition, Position } from '../core/position.js';
import { Range } from '../core/range.js';
import { Placeholder, SnippetParser, TextmateSnippet } from '../../../../vendor/vscode/editor/contrib/snippet/browser/snippetParser.js';

/** one occurrence of a tab stop, as character offsets into `ISnippetParseResult.text` */
export interface ISnippetOffsetRange {
	readonly offset: number;
	readonly length: number;
}

export interface ISnippetTabStop {
	/** the number the template wrote: 1, 2, ... or 0 for the final cursor position */
	readonly index: number;
	/** every place this index appears, in document order; the first is where the cursor goes */
	readonly occurrences: readonly ISnippetOffsetRange[];
}

export interface ISnippetParseResult {
	/** the text to insert, with every escape resolved and every placeholder filled in */
	readonly text: string;
	/** tab stops in walking order: 1, 2, ... then 0 last */
	readonly tabStops: readonly ISnippetTabStop[];
}

/**
 * Walking order: 1, 2, 3 … and 0 LAST.
 *
 * `$0` is the final cursor position, not the first stop, so it sorts after every numbered stop
 * however the template ordered them.
 */
function compareTabStopIndex(a: number, b: number): number {
	if (a === 0) {
		return 1;
	}
	if (b === 0) {
		return -1;
	}
	return a - b;
}

/**
 * Parse a snippet template.
 *
 * Delegates to the upstream parser and then projects its marker tree onto the flat
 * offset-and-length shape this project's controller works in. Everything upstream supports —
 * `${1:default}`, `${1|a,b|}` choices, `$TM_FILENAME` variables, `${1/re/fmt/g}` transforms,
 * nesting — is resolved by `TextmateSnippet.toString()` before we ever see it, which is precisely
 * what the hand-written version could not do.
 */
export function parseSnippet(template: string): ISnippetParseResult {
	const snippet: TextmateSnippet = new SnippetParser().parse(template, false, false);
	// shortcut: no variable resolver, so a KNOWN variable syntax with no value renders as empty —
	// `$TM_FILENAME` becomes ''. Upstream supplies a CompositeSnippetVariableResolver here and
	// converts the unknown ones to placeholders. Until that exists, a snippet containing a
	// variable loses that text rather than keeping it literally, which is the one way this is
	// worse than the hand-written parser it replaced. Upgrade by calling
	// `snippet.resolveVariables(resolver)` with a resolver that knows the file name, selection
	// and clipboard.
	const text = snippet.toString();

	// group every placeholder occurrence by its index; the same index can appear several times
	// (`<$1>text</$1>`) and each occurrence is a real position in the text
	const byIndex = new Map<number, ISnippetOffsetRange[]>();
	for (const placeholder of snippet.placeholders) {
		const occurrences = byIndex.get(placeholder.index) ?? [];
		occurrences.push({
			offset: snippet.offset(placeholder),
			length: snippet.fullLen(placeholder)
		});
		byIndex.set(placeholder.index, occurrences);
	}

	const tabStops: ISnippetTabStop[] = [...byIndex.entries()]
		.map(([index, occurrences]) => ({
			index,
			// document order, so the FIRST occurrence is the one the cursor goes to
			occurrences: occurrences.sort((a, b) => a.offset - b.offset)
		}))
		.sort((a, b) => compareTabStopIndex(a.index, b.index));

	return { text, tabStops };
}

export function hasTabStops(result: ISnippetParseResult): boolean {
	return result.tabStops.length > 0;
}

/** an offset into the inserted text → a model position, given where the insert started */
export function offsetToPosition(text: string, offset: number, start: IPosition): Position {
	const clamped = Math.max(0, Math.min(offset, text.length));
	const before = text.substring(0, clamped);
	const newlines = before.split('\n').length - 1;
	if (newlines === 0) {
		return new Position(start.lineNumber, start.column + clamped);
	}
	// on a later line the original column no longer applies: the column is measured from the
	// start of the last inserted line
	const lastLine = before.substring(before.lastIndexOf('\n') + 1);
	return new Position(start.lineNumber + newlines, lastLine.length + 1);
}

/** every tab stop's ranges, in walking order, as model ranges */
export function tabStopRanges(result: ISnippetParseResult, start: IPosition): Range[][] {
	return result.tabStops.map(stop => stop.occurrences.map(occurrence => {
		const from = offsetToPosition(result.text, occurrence.offset, start);
		const to = offsetToPosition(result.text, occurrence.offset + occurrence.length, start);
		return new Range(from.lineNumber, from.column, to.lineNumber, to.column);
	}));
}

export function nextTabStop(result: ISnippetParseResult, ordinal: number): number | undefined {
	return ordinal + 1 < result.tabStops.length ? ordinal + 1 : undefined;
}

export function previousTabStop(result: ISnippetParseResult, ordinal: number): number | undefined {
	return ordinal > 0 ? ordinal - 1 : undefined;
}

/** re-exported so a caller can reach the full marker tree when the flat shape is not enough */
export type { Placeholder, TextmateSnippet };
export { SnippetParser };
