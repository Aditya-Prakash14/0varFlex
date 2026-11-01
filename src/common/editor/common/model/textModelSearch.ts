// src/common/editor/common/model/textModelSearch.ts — in-model search, ported in subset from
// vs/editor/common/model/textModelSearch.ts.
//
// textModel.ts recorded "no in-model search/word helpers" as a deliberate omission. This is that
// omission paid back: it is what the find widget, Find All and a future rename all read from.
//
// Pure, and decoupled from TextModel by a two-method accessor, so the matching rules can be
// hammered in tests without building an editor.
//
// `wordSeparators` is a PARAMETER rather than an import, matching the reference's
// `findMatches(..., wordSeparators, ...)` signature — the constant lives in the renderer's word
// helper and this file is in the model layer, which may not import from there.
//
// shortcut: single-line matching. The reference supports multiline patterns by searching the
// buffer's text rather than line by line; a pattern containing \n finds nothing here. Upgrade
// when a consumer needs it — the Range shape already allows it.

import { Range } from '../core/range.js';

export interface IFindMatch {
	readonly range: Range;
	/** capture groups, when the caller asked for them; null otherwise */
	readonly matches: string[] | null;
}

export interface ISearchParams {
	readonly searchString: string;
	readonly isRegExp: boolean;
	readonly matchCase: boolean;
	readonly wholeWord: boolean;
	/** the characters that end a word; required when `wholeWord` is set */
	readonly wordSeparators?: string;
}

/** the slice of a model this search needs */
export interface ISearchableModel {
	getLineCount(): number;
	getLineContent(lineNumber: number): string;
}

export function escapeRegExpCharacters(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the matcher, or return null when the user's regex does not compile.
 *
 * Returning null rather than throwing matters: the find widget calls this on every keystroke,
 * and a half-typed `(` must show "no results", not break the editor.
 */
export function createSearchRegExp(params: ISearchParams): RegExp | null {
	if (!params.searchString) {
		return null;
	}

	let source = params.isRegExp ? params.searchString : escapeRegExpCharacters(params.searchString);

	// `\b` is wrong here: it uses JavaScript's own word definition, which disagrees with the
	// editor's `wordSeparators` (it treats `$` as a non-word character, so `$foo` would match
	// inside `a$foo`). The boundary is checked against the real separators after matching.
	if (params.wholeWord) {
		source = `(?:${source})`;
	}

	// `g` so lastIndex walks the line; `d` is not needed since we compute columns ourselves
	const flags = params.matchCase ? 'g' : 'gi';
	try {
		return new RegExp(source, flags);
	} catch {
		return null;
	}
}

/** true when the character at `index` is a word character under these separators */
function isWordChar(text: string, index: number, wordSeparators: string): boolean {
	if (index < 0 || index >= text.length) {
		return false; // the start and end of a line are boundaries
	}
	const char = text[index];
	if (char === ' ' || char === '\t') {
		return false;
	}
	return !wordSeparators.includes(char);
}

/**
 * True when [start, end) in `text` stands alone as a word.
 *
 * The match itself must begin and end with a word character — otherwise a search for `.foo`
 * with whole-word on would "match" anywhere, because its own first character is a separator and
 * the test either side would pass trivially.
 */
export function isWholeWordMatch(text: string, start: number, end: number, wordSeparators: string): boolean {
	if (end <= start) {
		return false;
	}
	if (!isWordChar(text, start, wordSeparators) || !isWordChar(text, end - 1, wordSeparators)) {
		return false;
	}
	return !isWordChar(text, start - 1, wordSeparators) && !isWordChar(text, end, wordSeparators);
}

export interface IFindMatchesResult {
	readonly matches: readonly IFindMatch[];
	/** true when `limit` cut the list short, so callers can say "more than N" */
	readonly limitHit: boolean;
}

/**
 * Every match in the model, in document order.
 *
 * `limit` is not optional in spirit: a find on a large file with a pattern like `.` would
 * otherwise build millions of Range objects before the widget could render one.
 */
export function findMatches(
	model: ISearchableModel,
	params: ISearchParams,
	options: { captureMatches?: boolean; limit?: number; searchRange?: Range } = {}
): IFindMatchesResult {
	const regexp = createSearchRegExp(params);
	if (!regexp) {
		return { matches: [], limitHit: false };
	}

	const limit = options.limit ?? 20_000;
	const separators = params.wordSeparators ?? '';
	const result: IFindMatch[] = [];

	const firstLine = options.searchRange ? options.searchRange.startLineNumber : 1;
	const lastLine = options.searchRange ? options.searchRange.endLineNumber : model.getLineCount();

	for (let lineNumber = Math.max(1, firstLine); lineNumber <= Math.min(lastLine, model.getLineCount()); lineNumber++) {
		const lineText = model.getLineContent(lineNumber);

		// a search range can start or end mid-line
		const from = options.searchRange && lineNumber === options.searchRange.startLineNumber
			? options.searchRange.startColumn - 1 : 0;
		const to = options.searchRange && lineNumber === options.searchRange.endLineNumber
			? options.searchRange.endColumn - 1 : lineText.length;

		regexp.lastIndex = from;
		let match: RegExpExecArray | null;
		while ((match = regexp.exec(lineText)) !== null) {
			const start = match.index;
			const end = start + match[0].length;

			if (start >= to) {
				break;
			}
			if (end > to) {
				break; // the match runs past the search range
			}

			// a zero-width match (an empty regex, `^`, `\b`) would spin forever
			if (match[0].length === 0) {
				regexp.lastIndex = start + 1;
				if (regexp.lastIndex > lineText.length) {
					break;
				}
				continue;
			}

			if (!params.wholeWord || isWholeWordMatch(lineText, start, end, separators)) {
				result.push({
					// columns are 1-based
					range: new Range(lineNumber, start + 1, lineNumber, end + 1),
					matches: options.captureMatches ? Array.from(match) : null
				});
				if (result.length >= limit) {
					return { matches: result, limitHit: true };
				}
			}

			regexp.lastIndex = end;
		}
	}

	return { matches: result, limitHit: false };
}

/**
 * The index of the first match at or after `position`, wrapping to 0 when there is none.
 *
 * Returns -1 only for an empty list. `after` false looks backwards instead, which is what
 * Shift+Enter needs.
 */
export function indexOfMatchNear(
	matches: readonly IFindMatch[],
	position: { lineNumber: number; column: number },
	after = true
): number {
	if (matches.length === 0) {
		return -1;
	}

	if (after) {
		for (let i = 0; i < matches.length; i++) {
			const range = matches[i].range;
			if (range.startLineNumber > position.lineNumber
				|| (range.startLineNumber === position.lineNumber && range.startColumn >= position.column)) {
				return i;
			}
		}
		return 0; // wrap to the top
	}

	for (let i = matches.length - 1; i >= 0; i--) {
		const range = matches[i].range;
		if (range.startLineNumber < position.lineNumber
			|| (range.startLineNumber === position.lineNumber && range.startColumn < position.column)) {
			return i;
		}
	}
	return matches.length - 1; // wrap to the bottom
}

/**
 * Expand `$1`-style references in a replacement against one match's capture groups.
 *
 * Only for a regex search — in a literal search `$1` is the text `$1`, which is what a user
 * replacing a price string expects. `$$` is an escaped dollar.
 */
export function expandReplacement(replacement: string, match: IFindMatch, isRegExp: boolean): string {
	if (!isRegExp || !match.matches) {
		return replacement;
	}
	const groups = match.matches;
	return replacement.replace(/\$(\$|&|\d{1,2})/g, (_whole, token: string) => {
		if (token === '$') {
			return '$';
		}
		if (token === '&') {
			return groups[0] ?? '';
		}
		const index = Number(token);
		return groups[index] ?? '';
	});
}
