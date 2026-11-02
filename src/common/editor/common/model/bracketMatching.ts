// src/common/editor/common/model/bracketMatching.ts — finding a bracket's partner, and deciding
// what typing a bracket or quote should actually insert.
//
// Ported in behaviour from vs/editor/common/model/textModelBracketPairs.ts (matching) and
// vs/editor/common/cursor/cursorTypeOperations.ts (auto-closing and the Enter rule). Both live
// here rather than in a contrib because the type handler is in the editor core, as in the
// reference, and because the scanning is the part worth testing without a DOM.
//
// shortcut: text-only scanning. There is no tokenizer in this build, so a bracket inside a string
// or a comment counts as a bracket — `"("` will match a real `)` later in the file. The reference
// asks the tokenizer to skip string and comment tokens. Upgrade when tokenization lands (B5's
// semantic tokens), which is also what would let auto-closing use the real `notIn` rules.

import { Position } from '../core/position.js';
import { Range } from '../core/range.js';
import { IAutoClosingPair, IBracketPair } from '../languages/languageConfiguration.js';

/** the model surface these functions read */
export interface IBracketSource {
	getLineCount(): number;
	getLineContent(lineNumber: number): string;
}

export interface IMatchedBracket {
	/** the bracket the cursor was on */
	readonly bracket: Range;
	/** its partner */
	readonly partner: Range;
}

function characterAt(source: IBracketSource, lineNumber: number, column: number): string {
	if (lineNumber < 1 || lineNumber > source.getLineCount()) {
		return '';
	}
	const line = source.getLineContent(lineNumber);
	return column >= 1 && column <= line.length ? line[column - 1] : '';
}

function rangeOfCharacter(lineNumber: number, column: number): Range {
	return new Range(lineNumber, column, lineNumber, column + 1);
}

/**
 * Scan for the partner of the bracket at (lineNumber, column), counting nesting.
 *
 * Only the SAME pair's characters are counted, so `([)]` matches the way a text scan can rather
 * than the way a parser would. For well-formed code the two agree.
 */
function scanForPartner(
	source: IBracketSource,
	pair: IBracketPair,
	lineNumber: number,
	column: number,
	direction: 'forward' | 'backward'
): Range | null {
	const self = direction === 'forward' ? pair.open : pair.close;
	const other = direction === 'forward' ? pair.close : pair.open;
	const step = direction === 'forward' ? 1 : -1;
	const lineCount = source.getLineCount();

	let depth = 0;
	let line = lineNumber;
	let index = column;

	while (line >= 1 && line <= lineCount) {
		const text = source.getLineContent(line);
		while (index >= 1 && index <= text.length) {
			const character = text[index - 1];
			if (character === self) {
				depth++;
			} else if (character === other) {
				depth--;
				if (depth === 0) {
					return rangeOfCharacter(line, index);
				}
			}
			index += step;
		}
		line += step;
		if (line < 1 || line > lineCount) {
			break;
		}
		// entering the next line from the end the scan is travelling towards; a blank line gives
		// an index the inner loop rejects immediately, which is the behaviour we want
		index = direction === 'forward' ? 1 : source.getLineContent(line).length;
	}
	return null;
}

/**
 * The bracket at or beside `position`, together with its partner.
 *
 * Looks at the character to the RIGHT of the cursor first and then to the LEFT, which is the
 * reference's order and what makes Ctrl+Shift+\ work with the cursor on either side of a bracket.
 * Returns null when there is no bracket beside the cursor, or when it has no partner.
 */
export function findMatchingBracket(
	source: IBracketSource,
	position: Position,
	brackets: readonly IBracketPair[]
): IMatchedBracket | null {
	const candidates: number[] = [position.column, position.column - 1];

	for (const column of candidates) {
		const character = characterAt(source, position.lineNumber, column);
		if (!character) {
			continue;
		}
		for (const pair of brackets) {
			if (character === pair.open) {
				const partner = scanForPartner(source, pair, position.lineNumber, column, 'forward');
				if (partner) {
					return { bracket: rangeOfCharacter(position.lineNumber, column), partner };
				}
			} else if (character === pair.close) {
				const partner = scanForPartner(source, pair, position.lineNumber, column, 'backward');
				if (partner) {
					return { bracket: rangeOfCharacter(position.lineNumber, column), partner };
				}
			}
		}
	}
	return null;
}

// ---- typing

export interface ITypeResult {
	/** the text to insert in place of what the user typed */
	readonly text: string;
	/** how many characters of `text` to leave BEFORE the cursor; the rest sits after it */
	readonly cursorOffset: number;
	/** when set, the range to replace instead of the cursor position (used to step over a closer) */
	readonly overtype?: boolean;
}

export interface ITypeContext {
	readonly source: IBracketSource;
	/** the cursor; only consulted for an empty selection */
	readonly position: Position;
	readonly configuration: {
		readonly autoClosingPairs: readonly IAutoClosingPair[];
		readonly brackets: readonly IBracketPair[];
	};
	readonly indent: { readonly tabSize: number; readonly insertSpaces: boolean };
}

/** the leading whitespace of a line, verbatim — reused rather than rebuilt, so tabs stay tabs */
function indentationOf(line: string): string {
	return /^[ \t]*/.exec(line)![0];
}

/**
 * What typing `typed` should insert, or null to insert it unchanged.
 *
 * Three rules, all from the reference:
 *   - typing an opener inserts the pair and puts the cursor between them, but only when the text
 *     after the cursor would not be swallowed (`autoCloseBefore`);
 *   - typing a closer that is already the next character steps over it instead of inserting a
 *     second one, which is what stops `()` from becoming `())`;
 *   - Enter keeps the current indentation, adds one level after an opener, and when the closer
 *     sits right after the cursor it goes to a line of its own.
 *
 * Only ever called for an empty selection: typing over a selection replaces it, and surrounding a
 * selection with a pair is a separate reference behaviour we do not have.
 */
export function autoClosingTypeResult(typed: string, context: ITypeContext): ITypeResult | null {
	const { source, position, configuration, indent } = context;
	const line = source.getLineContent(position.lineNumber);
	const after = position.column <= line.length ? line[position.column - 1] : '';
	const before = position.column > 1 ? line[position.column - 2] : '';

	if (typed === '\n') {
		return enterTypeResult(line, position, configuration.brackets, indent, after);
	}

	if (typed.length !== 1) {
		return null; // paste, or a composition commit: never auto-close
	}

	// stepping over a closer the editor itself inserted
	const closing = configuration.autoClosingPairs.find(pair => pair.close === typed && pair.open !== pair.close);
	if (closing && after === typed) {
		return { text: typed, cursorOffset: 1, overtype: true };
	}

	const pair = configuration.autoClosingPairs.find(candidate => candidate.open === typed);
	if (!pair) {
		return null;
	}

	// a quote is its own closer: stepping over it beats nesting a second pair
	if (pair.open === pair.close) {
		if (after === typed) {
			return { text: typed, cursorOffset: 1, overtype: true };
		}
		// `it's` must not become `it''s` — a quote directly after a word is an apostrophe
		if (/[A-Za-z0-9_]/.test(before)) {
			return null;
		}
	}

	// only close when what follows would not be swallowed by the new pair
	if (after !== '' && !pair.autoCloseBefore.includes(after)) {
		return null;
	}

	return { text: pair.open + pair.close, cursorOffset: 1 };
}

function enterTypeResult(
	line: string,
	position: Position,
	brackets: readonly IBracketPair[],
	indent: { tabSize: number; insertSpaces: boolean },
	after: string
): ITypeResult | null {
	const indentation = indentationOf(line.substring(0, position.column - 1));
	const beforeCursor = line.substring(0, position.column - 1).trimEnd();
	const lastCharacter = beforeCursor.length > 0 ? beforeCursor[beforeCursor.length - 1] : '';
	const opened = brackets.find(pair => pair.open === lastCharacter);

	if (!opened) {
		if (indentation.length === 0) {
			return null; // nothing to carry over: a plain newline is already right
		}
		return { text: `\n${indentation}`, cursorOffset: 1 + indentation.length };
	}

	const unit = indent.insertSpaces ? ' '.repeat(Math.max(1, indent.tabSize)) : '\t';
	const inner = indentation + unit;

	// `{|}` becomes three lines, with the closer back at the opener's indent
	if (after === opened.close) {
		return { text: `\n${inner}\n${indentation}`, cursorOffset: 1 + inner.length };
	}
	return { text: `\n${inner}`, cursorOffset: 1 + inner.length };
}
