// src/renderer/platform/contextkey/common/scanner.ts — ported from
// vs/platform/contextkey/common/scanner.ts. Two deliberate additions over that revision:
//  - a `Comma` token so `key in (a, b, 'c d')` lists parse (the old grammar, which the
//    course spec keeps — the reference dropped lists entirely)
//  - doubled-quote escaping in quoted strings (`'it''s'`), which that revision marked TODO

const enum CharCode {
	Null = 0,
	Tab = 9,
	LineFeed = 10,
	CarriageReturn = 13,
	Space = 32,
	NoBreakSpace = 160,
	ExclamationMark = 33,
	DoubleQuote = 34,
	Hash = 35,
	DollarSign = 36,
	Percent = 37,
	Ampersand = 38,
	SingleQuote = 39,
	OpenParen = 40,
	CloseParen = 41,
	Asterisk = 42,
	Plus = 43,
	Comma = 44,
	Minus = 45,
	Period = 46,
	Slash = 47,
	Colon = 58,
	Semicolon = 59,
	LessThan = 60,
	Equals = 61,
	GreaterThan = 62,
	QuestionMark = 63,
	AtSign = 64,
	OpenSquareBracket = 91,
	Backslash = 92,
	CloseSquareBracket = 93,
	Caret = 94,
	Underline = 95,
	Pipe = 124,
	Tilde = 126
}

export const enum TokenType {
	LParen,
	RParen,
	Comma,
	Neg,
	Eq,
	NotEq,
	Lt,
	LtEq,
	Gt,
	GtEq,
	RegexOp,
	RegexStr,
	True,
	False,
	In,
	Not,
	And,
	Or,
	Str,
	QuotedStr,
	Error,
	EOF,
}

export type Token =
	| { type: TokenType.LParen | TokenType.RParen | TokenType.Comma | TokenType.Neg | TokenType.Lt | TokenType.LtEq | TokenType.Gt | TokenType.GtEq | TokenType.RegexOp | TokenType.True | TokenType.False | TokenType.In | TokenType.Not | TokenType.And | TokenType.Or | TokenType.EOF; offset: number }
	| { type: TokenType.Eq | TokenType.NotEq; offset: number; isTripleEq: boolean }
	| { type: TokenType.RegexStr; offset: number; lexeme: string }
	| { type: TokenType.Str | TokenType.QuotedStr | TokenType.Error; offset: number; lexeme: string };

export type LexingError = {
	offset: number;
	lexeme: string;
	additionalInfo?: string;
};

type KeywordTokenType = TokenType.Not | TokenType.In | TokenType.False | TokenType.True;

/**
 * A simple scanner for context key expressions.
 */
export class Scanner {

	static getLexeme(token: Token): string {
		switch (token.type) {
			case TokenType.LParen: return '(';
			case TokenType.RParen: return ')';
			case TokenType.Comma: return ',';
			case TokenType.Neg: return '!';
			case TokenType.Eq: return token.isTripleEq ? '===' : '==';
			case TokenType.NotEq: return token.isTripleEq ? '!==' : '!=';
			case TokenType.Lt: return '<';
			case TokenType.LtEq: return '<=';
			case TokenType.Gt: return '>';
			case TokenType.GtEq: return '>=';
			case TokenType.RegexOp: return '=~';
			case TokenType.RegexStr: return token.lexeme;
			case TokenType.True: return 'true';
			case TokenType.False: return 'false';
			case TokenType.In: return 'in';
			case TokenType.Not: return 'not';
			case TokenType.And: return '&&';
			case TokenType.Or: return '||';
			case TokenType.EOF: return 'EOF';
			default: return token.lexeme;
		}
	}

	private static _regexFlags = new Set(['i', 'g', 's', 'm', 'y', 'u'].map(ch => ch.charCodeAt(0)));

	private static _keywords = new Map<string, KeywordTokenType>([
		['not', TokenType.Not],
		['in', TokenType.In],
		['false', TokenType.False],
		['true', TokenType.True],
	]);

	private _input: string = '';
	private _start: number = 0;
	private _current: number = 0;
	private _tokens: Token[] = [];
	private _errors: LexingError[] = [];

	get errors(): Readonly<LexingError[]> {
		return this._errors;
	}

	reset(value: string): this {
		this._input = value;
		this._start = 0;
		this._current = 0;
		this._tokens = [];
		this._errors = [];
		return this;
	}

	scan(): Token[] {
		while (!this._isAtEnd()) {
			this._start = this._current;
			const ch = this._advance();
			switch (ch) {
				case CharCode.OpenParen: this._addToken(TokenType.LParen); break;
				case CharCode.CloseParen: this._addToken(TokenType.RParen); break;
				case CharCode.Comma: this._addToken(TokenType.Comma); break;

				case CharCode.ExclamationMark:
					if (this._match(CharCode.Equals)) {
						const isTripleEq = this._match(CharCode.Equals);
						this._tokens.push({ type: TokenType.NotEq, offset: this._start, isTripleEq });
					} else {
						this._addToken(TokenType.Neg);
					}
					break;

				case CharCode.SingleQuote: this._quotedString(); break;
				case CharCode.Slash: this._regex(); break;

				case CharCode.Equals:
					if (this._match(CharCode.Equals)) {
						const isTripleEq = this._match(CharCode.Equals);
						this._tokens.push({ type: TokenType.Eq, offset: this._start, isTripleEq });
					} else if (this._match(CharCode.Tilde)) {
						this._addToken(TokenType.RegexOp);
					} else {
						this._error(`Did you mean '==' or '=~'?`);
					}
					break;

				case CharCode.LessThan: this._addToken(this._match(CharCode.Equals) ? TokenType.LtEq : TokenType.Lt); break;
				case CharCode.GreaterThan: this._addToken(this._match(CharCode.Equals) ? TokenType.GtEq : TokenType.Gt); break;

				case CharCode.Ampersand:
					if (this._match(CharCode.Ampersand)) {
						this._addToken(TokenType.And);
					} else {
						this._error(`Did you mean '&&'?`);
					}
					break;

				case CharCode.Pipe:
					if (this._match(CharCode.Pipe)) {
						this._addToken(TokenType.Or);
					} else {
						this._error(`Did you mean '||'?`);
					}
					break;

				case CharCode.Space:
				case CharCode.CarriageReturn:
				case CharCode.Tab:
				case CharCode.LineFeed:
				case CharCode.NoBreakSpace:
					break;

				default:
					this._string();
			}
		}

		this._start = this._current;
		this._addToken(TokenType.EOF);
		return Array.from(this._tokens);
	}

	private _match(expected: number): boolean {
		if (this._isAtEnd()) {
			return false;
		}
		if (this._input.charCodeAt(this._current) !== expected) {
			return false;
		}
		this._current++;
		return true;
	}

	private _advance(): number {
		return this._input.charCodeAt(this._current++);
	}

	private _peek(): number {
		return this._isAtEnd() ? CharCode.Null : this._input.charCodeAt(this._current);
	}

	private _addToken(type: TokenType): void {
		this._tokens.push({ type, offset: this._start } as Token);
	}

	private _error(additional?: string): void {
		const offset = this._start;
		const lexeme = this._input.substring(this._start, this._current);
		this._errors.push({ offset, lexeme, additionalInfo: additional });
		this._tokens.push({ type: TokenType.Error, offset, lexeme });
	}

	// comma is NOT part of a bare string here: it separates `in (a, b, 'c d')` list values, so
	// values containing commas must be quoted
	private stringRe = /[a-zA-Z0-9_<>\-\./\\:\*\?\+\[\]\^#@;"%\$\p{L}-]+/uy;

	private _string(): void {
		this.stringRe.lastIndex = this._start;
		const match = this.stringRe.exec(this._input);
		if (match) {
			this._current = this._start + match[0].length;
			const lexeme = this._input.substring(this._start, this._current);
			const keyword = Scanner._keywords.get(lexeme);
			if (keyword) {
				this._addToken(keyword);
			} else {
				this._tokens.push({ type: TokenType.Str, lexeme, offset: this._start });
			}
		}
	}

	// captures the lexeme without the leading and trailing '; a doubled '' is an escaped quote
	private _quotedString(): void {
		const chars: string[] = [];
		while (true) {
			if (this._isAtEnd()) {
				this._error(`Did you forget to open or close the quote?`);
				return;
			}
			const ch = this._advance();
			if (ch === CharCode.SingleQuote) {
				if (this._match(CharCode.SingleQuote)) {
					chars.push(`'`); // escaped quote
					continue;
				}
				break; // closing quote
			}
			chars.push(this._input[this._current - 1]);
		}
		this._tokens.push({ type: TokenType.QuotedStr, lexeme: chars.join(''), offset: this._start + 1 });
	}

	/*
	 * Lexing a regex expression: /.../[igsmyu]*
	 * Slashes within a regex must be escaped, e.g. /file:\/\//
	 */
	private _regex(): void {
		let p = this._current;

		let inEscape = false;
		let inCharacterClass = false;
		while (true) {
			if (p >= this._input.length) {
				this._current = p;
				this._error(`Did you forget to escape the '/' so it becomes a regex end marker? Put two backslashes before it to escape.`);
				return;
			}

			const ch = this._input.charCodeAt(p);

			if (inEscape) {
				inEscape = false;
			} else if (ch === CharCode.Slash && !inCharacterClass) {
				p++;
				break;
			} else if (ch === CharCode.OpenSquareBracket) {
				inCharacterClass = true;
			} else if (ch === CharCode.Backslash) {
				inEscape = true;
			} else if (ch === CharCode.CloseSquareBracket) {
				inCharacterClass = false;
			}
			p++;
		}

		while (p < this._input.length && Scanner._regexFlags.has(this._input.charCodeAt(p))) {
			p++;
		}

		this._current = p;
		const lexeme = this._input.substring(this._start, this._current);
		this._tokens.push({ type: TokenType.RegexStr, lexeme, offset: this._start });
	}

	private _isAtEnd(): boolean {
		return this._current >= this._input.length;
	}
}
