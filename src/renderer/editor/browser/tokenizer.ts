// src/renderer/editor/browser/tokenizer.ts — the toy tokenizer: one hand-rolled scan per line
// over a fixed keyword set. The only state carried across lines is "inside a block comment".
//
// shortcut: single scanner — the real pipeline (model/textModelTokens.ts + TextMate/Monarch
// tokenizers) is per-language and stateful; upgrade path is contrib/'s Monarch grammars when
// grammar coverage grows.

export const enum TokenType {
	Plain = 0,
	Keyword = 1,
	Number = 2,
	String = 3,
	Comment = 4,
	Operator = 5
}

export interface IToken {
	readonly type: TokenType;
	/** code-unit indices into the line text */
	readonly start: number;
	readonly end: number;
}

export interface ITokenizeResult {
	readonly tokens: IToken[];
	/** the state to feed into the next line */
	readonly inBlockComment: boolean;
}

const KEYWORDS = new Set([
	'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'new',
	'import', 'from', 'export', 'async', 'await', 'true', 'false', 'null', 'undefined', 'typeof'
]);

const OPERATOR_CHARS = '=+-*/%<>!&|?:;,.()[]{}';

function isDigit(ch: string): boolean {
	return ch >= '0' && ch <= '9';
}

function isIdentifierStart(ch: string): boolean {
	return /[A-Za-z_$]/.test(ch);
}

function isIdentifierPart(ch: string): boolean {
	return /[A-Za-z0-9_$]/.test(ch);
}

export function tokenizeLine(text: string, inBlockComment: boolean): ITokenizeResult {
	const tokens: IToken[] = [];
	let i = 0;
	let block = inBlockComment;
	while (i < text.length) {
		const ch = text[i];

		if (block) {
			const end = text.indexOf('*/', i);
			if (end === -1) {
				tokens.push({ type: TokenType.Comment, start: i, end: text.length });
				i = text.length;
			} else {
				tokens.push({ type: TokenType.Comment, start: i, end: end + 2 });
				i = end + 2;
				block = false;
			}
			continue;
		}

		if (ch === '/' && text[i + 1] === '/') {
			tokens.push({ type: TokenType.Comment, start: i, end: text.length });
			i = text.length;
			continue;
		}

		if (ch === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			if (end === -1) {
				tokens.push({ type: TokenType.Comment, start: i, end: text.length });
				i = text.length;
				block = true;
			} else {
				tokens.push({ type: TokenType.Comment, start: i, end: end + 2 });
				i = end + 2;
			}
			continue;
		}

		if (ch === '"' || ch === '\'' || ch === '`') {
			const quote = ch;
			let j = i + 1;
			while (j < text.length) {
				if (text[j] === '\\') {
					j += 2;
					continue;
				}
				if (text[j] === quote) {
					j++;
					break;
				}
				j++;
			}
			tokens.push({ type: TokenType.String, start: i, end: Math.min(j, text.length) });
			i = Math.min(j, text.length);
			continue;
		}

		if (isDigit(ch) || (ch === '-' && isDigit(text[i + 1] ?? ''))) {
			let j = i + (ch === '-' ? 1 : 0);
			while (j < text.length && (isDigit(text[j]) || text[j] === '.')) {
				j++;
			}
			tokens.push({ type: TokenType.Number, start: i, end: j });
			i = j;
			continue;
		}

		if (isIdentifierStart(ch)) {
			let j = i + 1;
			while (j < text.length && isIdentifierPart(text[j])) {
				j++;
			}
			if (KEYWORDS.has(text.substring(i, j))) {
				tokens.push({ type: TokenType.Keyword, start: i, end: j });
			}
			i = j;
			continue;
		}

		if (OPERATOR_CHARS.includes(ch)) {
			// collapse short runs (`==`, `=>`, `);`) — capped at 3 chars, same color anyway
			let j = i + 1;
			while (j < text.length && OPERATOR_CHARS.includes(text[j]) && j - i < 3) {
				j++;
			}
			tokens.push({ type: TokenType.Operator, start: i, end: j });
			i = j;
			continue;
		}

		i++;
	}

	return { tokens, inBlockComment: block };
}

/**
 * Walk a line reporting only the resulting block-comment state — no token allocation. Used by
 * the token cache's back-scan when jumping far into a large file (tokenizing 90k lines just to
 * learn whether a comment is open would cost ~100ms; this stays in the low tens).
 */
export function scanBlockCommentState(text: string, inBlockComment: boolean): boolean {
	let i = 0;
	let block = inBlockComment;
	let quote: string | null = null;

	while (i < text.length) {
		const ch = text[i];

		if (block) {
			const end = text.indexOf('*/', i);
			if (end === -1) {
				return true;
			}
			block = false;
			i = end + 2;
			continue;
		}

		if (quote) {
			if (ch === '\\') {
				i += 2;
				continue;
			}
			if (ch === quote) {
				quote = null;
			}
			i++;
			continue;
		}

		if (ch === '"' || ch === '\'' || ch === '`') {
			quote = ch;
			i++;
			continue;
		}
		if (ch === '/' && text[i + 1] === '/') {
			return false; // line comment: the rest of the line is ignored
		}
		if (ch === '/' && text[i + 1] === '*') {
			block = true;
			i += 2;
			continue;
		}
		i++;
	}
	return block;
}
