// src/common/editor/common/model/snippetParser.ts — snippet template -> literal text plus the
// tab stops to walk, as pure data.
//
// Ported in behaviour from the subset of vs/editor/contrib/snippet/browser/snippetParser.ts that
// needs no language provider: ordered tab stops, placeholders with default text, and $0.
// The reference builds a marker tree (Text/Placeholder/Variable/Choice/Transform); we only need
// the flattened result, so there is no tree here.
//
// shortcut: variables ($TM_FILENAME, ${TM_SELECTED_TEXT:x}), choices (${1|a,b|}) and transforms
// (${1/re/fmt/g}) are not understood and survive as literal text; upgrade when a variable
// resolver or choice UI exists. Dropping them would silently corrupt the user's file, so an
// unsupported construct is always copied through verbatim.

import { IPosition, Position } from '../core/position.js';
import { Range } from '../core/range.js';

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

type Part =
	| { readonly kind: 'text'; readonly value: string }
	| { readonly kind: 'stop'; readonly index: number; readonly value: string | undefined };

/** the reference's Placeholder.compareByIndex: the final tab stop sorts after every other one */
function compareByIndex(a: number, b: number): number {
	if (a === b) {
		return 0;
	}
	if (a === 0) {
		return 1;
	}
	if (b === 0) {
		return -1;
	}
	return a - b;
}

/** `\$`, `\\`, `\}` are literal; any other backslash is itself. Same set as the reference. */
function readEscape(template: string, pos: number): { value: string; end: number } {
	const next = template[pos + 1];
	if (next === '$' || next === '}' || next === '\\') {
		return { value: next, end: pos + 2 };
	}
	return { value: '\\', end: pos + 1 };
}

/** at `$`: a tab stop, or undefined for anything this parser does not support */
function readTabStop(template: string, start: number): { index: number; value: string | undefined; end: number } | undefined {
	let pos = start + 1;
	const braced = template[pos] === '{';
	if (braced) {
		pos++;
	}
	const digits = pos;
	while (pos < template.length && template[pos] >= '0' && template[pos] <= '9') {
		pos++;
	}
	if (pos === digits) {
		return undefined; // $TM_FILENAME, ${TM_FILENAME}, a bare $
	}
	const index = Number(template.slice(digits, pos));
	if (!braced) {
		return { index, value: undefined, end: pos };
	}
	if (template[pos] === '}') {
		return { index, value: undefined, end: pos + 1 };
	}
	if (template[pos] !== ':') {
		return undefined; // ${1|a,b|} choice or ${1/re/fmt/} transform
	}
	pos++;
	let value = '';
	while (pos < template.length) {
		const ch = template[pos];
		if (ch === '\\') {
			const escaped = readEscape(template, pos);
			value += escaped.value;
			pos = escaped.end;
			continue;
		}
		if (ch === '}') {
			return { index, value, end: pos + 1 };
		}
		if (ch === '$') {
			return undefined; // a nested placeholder or variable in the default text
		}
		value += ch;
		pos++;
	}
	return undefined; // unterminated
}

/**
 * The end of a `${...}` construct this parser does not support, so the whole of it can be copied
 * through as literal text; the end of the template if it is never closed.
 */
/** `start` is the `{` of the construct. */
function endOfUnsupported(template: string, start: number): number {
	let depth = 0;
	for (let pos = start; pos < template.length; pos++) {
		const ch = template[pos];
		if (ch === '\\') {
			pos++; // an escaped brace does not nest
		} else if (ch === '{') {
			depth++;
		} else if (ch === '}' && --depth === 0) {
			return pos + 1;
		}
	}
	return template.length;
}

export function parseSnippet(template: string): ISnippetParseResult {
	const parts: Part[] = [];
	let literal = '';
	for (let pos = 0; pos < template.length;) {
		const ch = template[pos];
		if (ch === '\\') {
			const escaped = readEscape(template, pos);
			literal += escaped.value;
			pos = escaped.end;
			continue;
		}
		if (ch === '$') {
			const stop = readTabStop(template, pos);
			if (stop) {
				if (literal) {
					parts.push({ kind: 'text', value: literal });
					literal = '';
				}
				parts.push({ kind: 'stop', index: stop.index, value: stop.value });
				pos = stop.end;
				continue;
			}
			if (template[pos + 1] === '{') {
				// a variable, choice or transform: the whole construct stays as it was written
				const end = endOfUnsupported(template, pos + 1);
				literal += template.slice(pos, end);
				pos = end;
				continue;
			}
		}
		literal += ch;
		pos++;
	}
	if (literal) {
		parts.push({ kind: 'text', value: literal });
	}

	// the reference: the first occurrence of an index that has a value defines it for all of them
	const values = new Map<number, string>();
	for (const part of parts) {
		if (part.kind === 'stop' && part.value !== undefined && !values.has(part.index)) {
			values.set(part.index, part.value);
		}
	}

	let text = '';
	const occurrences = new Map<number, ISnippetOffsetRange[]>();
	for (const part of parts) {
		if (part.kind === 'text') {
			text += part.value;
			continue;
		}
		const value = values.get(part.index) ?? '';
		let list = occurrences.get(part.index);
		if (!list) {
			occurrences.set(part.index, list = []);
		}
		list.push({ offset: text.length, length: value.length });
		text += value;
	}

	const tabStops = [...occurrences.keys()]
		.sort(compareByIndex)
		.map(index => ({ index, occurrences: occurrences.get(index)! }));
	return { text, tabStops };
}

/** false means the caller can insert the text and skip the whole tab stop session */
export function hasTabStops(result: ISnippetParseResult): boolean {
	return result.tabStops.length > 0;
}

/**
 * The position an offset into `result.text` lands on once the text is inserted at `start`.
 * shortcut: a \r in the template counts as a character, so the caller normalises EOL first.
 */
export function offsetToPosition(text: string, offset: number, start: IPosition): Position {
	let lineNumber = start.lineNumber;
	let lastBreak = -1;
	for (let i = 0; i < offset; i++) {
		if (text.charCodeAt(i) === 10 /* \n */) {
			lineNumber++;
			lastBreak = i;
		}
	}
	return new Position(lineNumber, lastBreak === -1 ? start.column + offset : offset - lastBreak);
}

/** model ranges per tab stop, parallel to `result.tabStops`, for an insert at `start` */
export function tabStopRanges(result: ISnippetParseResult, start: IPosition): Range[][] {
	return result.tabStops.map(stop => stop.occurrences.map(({ offset, length }) => Range.fromPositions(
		offsetToPosition(result.text, offset, start),
		offsetToPosition(result.text, offset + length, start)
	)));
}

/** the next tab stop after `ordinal` (an index into `result.tabStops`); undefined ends the session */
export function nextTabStop(result: ISnippetParseResult, ordinal: number): number | undefined {
	return ordinal + 1 < result.tabStops.length ? ordinal + 1 : undefined;
}

/** the previous tab stop; undefined means the caller stays where it is */
export function previousTabStop(result: ISnippetParseResult, ordinal: number): number | undefined {
	return ordinal > 0 ? ordinal - 1 : undefined;
}
