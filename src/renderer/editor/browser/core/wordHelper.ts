// src/renderer/editor/browser/core/wordHelper.ts — ported from vs/editor/common/core/wordHelper.ts
// (the separator table and the default word regexp verbatim; getWordAtText simplified to a
// straight regex scan, no time budget).

export const USUAL_WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';

export interface IWordAtPosition {
	readonly word: string;
	readonly startColumn: number;
	readonly endColumn: number;
}

function createWordRegExp(allowInWords: string = ''): RegExp {
	let source = '(-?\\d*\\.\\d\\w*)|([^';
	for (const sep of USUAL_WORD_SEPARATORS) {
		if (allowInWords.indexOf(sep) >= 0) {
			continue;
		}
		source += '\\' + sep;
	}
	source += '\\s]+)';
	return new RegExp(source, 'g');
}

// catches numbers (including floating numbers) in the first group, and alphanum in the second
export const DEFAULT_WORD_REGEXP = createWordRegExp();

/** the classifier: separators are non-word characters that still terminate words */
export function isWordSeparator(char: string): boolean {
	return USUAL_WORD_SEPARATORS.includes(char);
}

export function isWordCharacter(char: string): boolean {
	return char !== '' && !isWordSeparator(char) && !/\s/.test(char);
}

// ---- the character classifier, ported from vs/editor/common/core/wordCharacterClassifier.ts:
// Regular = part of a word, Whitespace (space/tab), WordSeparator (the table above).

export const enum WordCharacterClass {
	Regular = 0,
	Whitespace = 1,
	WordSeparator = 2
}

export function classifyChar(char: string, wordSeparators: string = USUAL_WORD_SEPARATORS): WordCharacterClass {
	if (char === ' ' || char === '\t') {
		return WordCharacterClass.Whitespace;
	}
	if (wordSeparators.includes(char)) {
		return WordCharacterClass.WordSeparator;
	}
	return WordCharacterClass.Regular;
}

/** the length of the code point ENDING at `offset` (1-based column boundary), emoji count as 2 */
export function prevCharLength(text: string, offset: number): number {
	if (offset <= 0 || offset > text.length) {
		return 1;
	}
	const code = text.charCodeAt(offset - 1);
	if (code >= 0xdc00 && code <= 0xdfff && offset >= 2) {
		const high = text.charCodeAt(offset - 2);
		if (high >= 0xd800 && high <= 0xdbff) {
			return 2;
		}
	}
	return 1;
}

/** the length of the code point STARTING at `offset` (1-based column boundary) */
export function nextCharLength(text: string, offset: number): number {
	if (offset < 1 || offset > text.length) {
		return 1;
	}
	const code = text.charCodeAt(offset - 1);
	if (code >= 0xd800 && code <= 0xdbff && offset < text.length) {
		const low = text.charCodeAt(offset);
		if (low >= 0xdc00 && low <= 0xdfff) {
			return 2;
		}
	}
	return 1;
}

/** the word enclosing the given 1-based column, or null between words */
export function getWordAtText(column: number, wordDefinition: RegExp, text: string): IWordAtPosition | null {
	wordDefinition.lastIndex = 0;
	const pos = column - 1;

	for (let match = wordDefinition.exec(text); match; match = wordDefinition.exec(text)) {
		const matchIndex = match.index;
		// half-open: a position just AFTER a word belongs to what follows (whitespace/separator)
		if (matchIndex <= pos && pos < matchIndex + match[0].length) {
			return {
				word: match[0],
				startColumn: 1 + matchIndex,
				endColumn: 1 + matchIndex + match[0].length
			};
		}
	}
	return null;
}

export function getWordAtTextDefault(column: number, text: string): IWordAtPosition | null {
	return getWordAtText(column, DEFAULT_WORD_REGEXP, text);
}
