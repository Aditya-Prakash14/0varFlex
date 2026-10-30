// src/renderer/platform/contextkey/common/contextkey.ts — ported (structure, ~60 % of the
// reference classes) from vs/platform/contextkey/common/contextkey.ts.
//
// Ported: Parser, true/false/defined/not/equals/notEquals/regex/notRegex/in/notIn/greater/
// greaterEquals/smaller/smallerEquals/And/Or, serialize()/evaluate()/negate()/keys(),
// ContextKeyExpr statics, RawContextKey, IContextKeyService, implies().
// Skipped upstream: constants substitution, map()/mapper, const-key registry.
// shortcut: And does not DISTRIBUTE Or children (upstream rewrites `a && (b || c)` into a
// disjunction); serialization parenthesizes instead, which keeps round-trips stable.
// shortcut: `in` takes a list of literals here (the old grammar); upstream's `key in valueKey`
// set reference needs ResourceContextKey-style context values — arrives with 10's file context.

import { Emitter, Event } from '../../../../common/base/common/event.js';
import { createDecorator } from '../../../../common/platform/instantiation/common/instantiation.js';
import { LexingError, Scanner, Token, TokenType } from './scanner.js';

export const enum ContextKeyExprType {
	False = 0,
	True = 1,
	Defined = 2,
	Not = 3,
	Equals = 4,
	NotEquals = 5,
	Regex = 6,
	NotRegex = 7,
	In = 8,
	NotIn = 9,
	Greater = 10,
	GreaterEquals = 11,
	Smaller = 12,
	SmallerEquals = 13,
	And = 14,
	Or = 15,
}

export interface IContext {
	getValue<T = unknown>(key: string): T | undefined;
}

export interface IContextKeyExpression {
	cmp(other: ContextKeyExpression): number;
	equals(other: ContextKeyExpression): boolean;
	evaluate(context: IContext): boolean;
	serialize(): string;
	keys(): string[];
	negate(): ContextKeyExpression;
}

export type ContextKeyExpression =
	| ContextKeyFalseExpr | ContextKeyTrueExpr | ContextKeyDefinedExpr | ContextKeyNotExpr
	| ContextKeyEqualsExpr | ContextKeyNotEqualsExpr | ContextKeyRegexExpr | ContextKeyNotRegexExpr
	| ContextKeyInExpr | ContextKeyNotInExpr
	| ContextKeyGreaterExpr | ContextKeyGreaterEqualsExpr | ContextKeySmallerExpr | ContextKeySmallerEqualsExpr
	| ContextKeyAndExpr | ContextKeyOrExpr;

// ---- helpers

function cmp1(a: string, b: string): number {
	if (a < b) { return -1; }
	if (a > b) { return 1; }
	return 0;
}

function cmp(a: ContextKeyExpression, b: ContextKeyExpression): number {
	return a.cmp(b);
}

/** quote a value for serialization; a doubled '' is the escape for an embedded quote */
function quote(value: string): string {
	return `'${value.replace(/'/g, `''`)}'`;
}

export interface ParsingError {
	message: string;
	offset: number;
	lexeme: string;
	additionalInfo?: string;
}

// ---- parser

export class Parser {

	private static _parseError = new Error();

	private readonly _scanner = new Scanner();
	private _tokens: Token[] = [];
	private _current = 0;
	private _parsingErrors: ParsingError[] = [];

	get lexingErrors(): Readonly<LexingError[]> {
		return this._scanner.errors;
	}

	get parsingErrors(): Readonly<ParsingError[]> {
		return this._parsingErrors;
	}

	/**
	 * Parse a context key expression; returns `undefined` on error — read
	 * `lexingErrors`/`parsingErrors` for details.
	 */
	parse(input: string): ContextKeyExpression | undefined {
		if (input === '') {
			this._parsingErrors.push({ message: `Empty expression`, offset: 0, lexeme: '', additionalInfo: `An expression is expected.` });
			return undefined;
		}

		this._tokens = this._scanner.reset(input).scan();
		this._current = 0;
		this._parsingErrors = [];

		try {
			const expr = this._expr();
			if (!this._isAtEnd()) {
				const peek = this._peek();
				this._parsingErrors.push({ message: `Unexpected token.`, offset: peek.offset, lexeme: Scanner.getLexeme(peek) });
				throw Parser._parseError;
			}
			return expr;
		} catch (e) {
			if (!(e === Parser._parseError)) {
				throw e;
			}
			return undefined;
		}
	}

	private _expr(): ContextKeyExpression | undefined {
		return this._or();
	}

	private _or(): ContextKeyExpression | undefined {
		const expr = [this._and()];
		while (this._matchOne(TokenType.Or)) {
			expr.push(this._and());
		}
		return expr.length === 1 ? expr[0] : ContextKeyExpr.or(...expr);
	}

	private _and(): ContextKeyExpression | undefined {
		const expr = [this._term()];
		while (this._matchOne(TokenType.And)) {
			expr.push(this._term());
		}
		return expr.length === 1 ? expr[0] : ContextKeyExpr.and(...expr);
	}

	private _term(): ContextKeyExpression | undefined {
		if (this._matchOne(TokenType.Neg)) {
			const peek = this._peek();
			switch (peek.type) {
				case TokenType.True:
					this._advance();
					return ContextKeyFalseExpr.INSTANCE;
				case TokenType.False:
					this._advance();
					return ContextKeyTrueExpr.INSTANCE;
				case TokenType.LParen: {
					this._advance();
					const expr = this._expr();
					this._consume(TokenType.RParen, `Expected: ')'`);
					return expr?.negate();
				}
				case TokenType.Str: {
					const key = peek.lexeme;
					this._advance();
					// `!key =~ /regex/` — a negated regex, produced by negate()'s algebra
					if (this._matchOne(TokenType.RegexOp)) {
						const regexToken = this._peek();
						this._advance();
						if (regexToken.type !== TokenType.RegexStr) {
							throw this._errExpectedButGot(`REGEX`, regexToken);
						}
						return ContextKeyRegexExpr.create(key, this._regexFromLexeme(regexToken)).negate();
					}
					return ContextKeyNotExpr.create(key);
				}
				default:
					throw this._errExpectedButGot(`KEY | true | false | '(' expression ')'`, peek);
			}
		}
		return this._primary();
	}

	private _primary(): ContextKeyExpression | undefined {
		const peek = this._peek();
		switch (peek.type) {
			case TokenType.True:
				this._advance();
				return ContextKeyExpr.true();

			case TokenType.False:
				this._advance();
				return ContextKeyExpr.false();

			case TokenType.LParen: {
				this._advance();
				const expr = this._expr();
				this._consume(TokenType.RParen, `Expected: ')'`);
				return expr;
			}

			case TokenType.Str: {
				const key = peek.lexeme;
				this._advance();

				// =~ regex
				if (this._matchOne(TokenType.RegexOp)) {
					const expr = this._peek();
					this._advance();
					if (expr.type !== TokenType.RegexStr) {
						throw this._errExpectedButGot(`REGEX`, expr);
					}
					return ContextKeyRegexExpr.create(key, this._regexFromLexeme(expr));
				}

				// [ 'not' 'in' value-or-list ]
				if (this._matchOne(TokenType.Not)) {
					this._consume(TokenType.In, `Expected: 'in' after 'not'`);
					return ContextKeyExpr.notIn(key, this._valueOrList());
				}

				const maybeOp = this._peek().type;
				switch (maybeOp) {
					case TokenType.Eq: {
						this._advance();
						const right = this._value();
						if (this._previous().type === TokenType.QuotedStr) { // 'foo == 'true'' stays an equals
							return ContextKeyExpr.equals(key, right);
						}
						switch (right) {
							case 'true': return ContextKeyExpr.has(key);
							case 'false': return ContextKeyExpr.not(key);
							default: return ContextKeyExpr.equals(key, right);
						}
					}

					case TokenType.NotEq: {
						this._advance();
						const right = this._value();
						if (this._previous().type === TokenType.QuotedStr) {
							return ContextKeyExpr.notEquals(key, right);
						}
						switch (right) {
							case 'true': return ContextKeyExpr.not(key);
							case 'false': return ContextKeyExpr.has(key);
							default: return ContextKeyExpr.notEquals(key, right);
						}
					}

					case TokenType.Lt:
						this._advance();
						return ContextKeySmallerExpr.create(key, this._value());
					case TokenType.LtEq:
						this._advance();
						return ContextKeySmallerEqualsExpr.create(key, this._value());
					case TokenType.Gt:
						this._advance();
						return ContextKeyGreaterExpr.create(key, this._value());
					case TokenType.GtEq:
						this._advance();
						return ContextKeyGreaterEqualsExpr.create(key, this._value());
					case TokenType.In:
						this._advance();
						return ContextKeyExpr.in(key, this._valueOrList());

					default:
						return ContextKeyExpr.has(key);
				}
			}

			case TokenType.EOF:
				this._parsingErrors.push({ message: `Unexpected end of expression.`, offset: peek.offset, lexeme: '' });
				throw Parser._parseError;

			default:
				throw this._errExpectedButGot(`true | false | KEY`, this._peek());
		}
	}

	private _value(): string {
		const token = this._peek();
		switch (token.type) {
			case TokenType.Str:
			case TokenType.QuotedStr:
				this._advance();
				return token.lexeme;
			case TokenType.True:
				this._advance();
				return 'true';
			case TokenType.False:
				this._advance();
				return 'false';
			case TokenType.In:
				this._advance();
				return 'in';
			default:
				return '';
		}
	}

	/** `key in (a, b, 'c d')` or `key in value` (single literal, treated as a one-element list) */
	private _valueOrList(): string[] {
		if (!this._check(TokenType.LParen)) {
			return [this._value()];
		}
		this._advance(); // '('
		const values: string[] = [this._value()];
		while (this._matchOne(TokenType.Comma)) {
			values.push(this._value());
		}
		this._consume(TokenType.RParen, `Expected: ')'`);
		return values;
	}

	private _flagsGYRe = /g|y/g;
	private _removeFlagsGY(flags: string): string {
		return flags.replaceAll(this._flagsGYRe, '');
	}

	private _regexFromLexeme(token: Token & { lexeme: string }): RegExp {
		const regexLexeme = token.lexeme;
		const closingSlashIndex = regexLexeme.lastIndexOf('/');
		const flags = closingSlashIndex === regexLexeme.length - 1 ? undefined : this._removeFlagsGY(regexLexeme.substring(closingSlashIndex + 1));
		try {
			return new RegExp(regexLexeme.substring(1, closingSlashIndex), flags);
		} catch {
			throw this._errExpectedButGot(`REGEX`, token);
		}
	}

	private _previous(): Token {
		return this._tokens[this._current - 1];
	}

	private _matchOne(token: TokenType): boolean {
		if (this._check(token)) {
			this._advance();
			return true;
		}
		return false;
	}

	private _advance(): Token {
		if (!this._isAtEnd()) {
			this._current++;
		}
		return this._previous();
	}

	private _consume(type: TokenType, message: string): Token {
		if (this._check(type)) {
			return this._advance();
		}
		throw this._errExpectedButGot(message, this._peek());
	}

	private _errExpectedButGot(expected: string, got: Token): Error {
		const lexeme = Scanner.getLexeme(got);
		this._parsingErrors.push({ message: `Expected: ${expected}\nReceived: '${lexeme}'.`, offset: got.offset, lexeme });
		return Parser._parseError;
	}

	private _check(type: TokenType): boolean {
		return this._peek().type === type;
	}

	private _peek(): Token {
		return this._tokens[this._current];
	}

	private _isAtEnd(): boolean {
		return this._peek().type === TokenType.EOF;
	}
}

// ---- expression factories & algebra

export abstract class ContextKeyExpr {

	public static false(): ContextKeyExpression {
		return ContextKeyFalseExpr.INSTANCE;
	}
	public static true(): ContextKeyExpression {
		return ContextKeyTrueExpr.INSTANCE;
	}
	public static has(key: string): ContextKeyExpression {
		return ContextKeyDefinedExpr.create(key);
	}
	public static equals(key: string, value: unknown): ContextKeyExpression {
		return ContextKeyEqualsExpr.create(key, value);
	}
	public static notEquals(key: string, value: unknown): ContextKeyExpression {
		return ContextKeyNotEqualsExpr.create(key, value);
	}
	public static regex(key: string, value: RegExp): ContextKeyExpression {
		return ContextKeyRegexExpr.create(key, value);
	}
	public static in(key: string, value: string | string[]): ContextKeyExpression {
		return ContextKeyInExpr.create(key, value);
	}
	public static notIn(key: string, value: string | string[]): ContextKeyExpression {
		return ContextKeyNotInExpr.create(key, value);
	}
	public static not(key: string): ContextKeyExpression {
		return ContextKeyNotExpr.create(key);
	}
	public static and(...expr: Array<ContextKeyExpression | undefined | null>): ContextKeyExpression | undefined {
		return ContextKeyAndExpr.create(expr);
	}
	public static or(...expr: Array<ContextKeyExpression | undefined | null>): ContextKeyExpression | undefined {
		return ContextKeyOrExpr.create(expr);
	}
	public static greater(key: string, value: number): ContextKeyExpression {
		return ContextKeyGreaterExpr.create(key, value);
	}
	public static greaterEquals(key: string, value: number): ContextKeyExpression {
		return ContextKeyGreaterEqualsExpr.create(key, value);
	}
	public static smaller(key: string, value: number): ContextKeyExpression {
		return ContextKeySmallerExpr.create(key, value);
	}
	public static smallerEquals(key: string, value: number): ContextKeyExpression {
		return ContextKeySmallerEqualsExpr.create(key, value);
	}

	private static _parser = new Parser();
	public static deserialize(serialized: string | null | undefined): ContextKeyExpression | undefined {
		if (serialized === undefined || serialized === null) {
			return undefined;
		}
		return this._parser.parse(serialized);
	}
}

export class ContextKeyFalseExpr implements IContextKeyExpression {

	public static INSTANCE = new ContextKeyFalseExpr();
	public readonly type = ContextKeyExprType.False;

	protected constructor() { }

	public cmp(other: ContextKeyExpression): number { return this.type - other.type; }
	public equals(other: ContextKeyExpression): boolean { return other.type === this.type; }
	public evaluate(_context: IContext): boolean { return false; }
	public serialize(): string { return 'false'; }
	public keys(): string[] { return []; }
	public negate(): ContextKeyExpression { return ContextKeyTrueExpr.INSTANCE; }
}

export class ContextKeyTrueExpr implements IContextKeyExpression {

	public static INSTANCE = new ContextKeyTrueExpr();
	public readonly type = ContextKeyExprType.True;

	protected constructor() { }

	public cmp(other: ContextKeyExpression): number { return this.type - other.type; }
	public equals(other: ContextKeyExpression): boolean { return other.type === this.type; }
	public evaluate(_context: IContext): boolean { return true; }
	public serialize(): string { return 'true'; }
	public keys(): string[] { return []; }
	public negate(): ContextKeyExpression { return ContextKeyFalseExpr.INSTANCE; }
}

export class ContextKeyDefinedExpr implements IContextKeyExpression {

	public static create(key: string): ContextKeyExpression {
		return new ContextKeyDefinedExpr(key);
	}

	public readonly type = ContextKeyExprType.Defined;

	protected constructor(readonly key: string) { }

	public cmp(other: ContextKeyExpression): number {
		if (other.type !== this.type) { return this.type - other.type; }
		return cmp1(this.key, (other as ContextKeyDefinedExpr).key);
	}

	public equals(other: ContextKeyExpression): boolean {
		return other.type === this.type && this.key === (other as ContextKeyDefinedExpr).key;
	}

	public evaluate(context: IContext): boolean {
		return !!context.getValue(this.key);
	}

	public serialize(): string {
		return this.key;
	}

	public keys(): string[] {
		return [this.key];
	}

	public negate(): ContextKeyExpression {
		return ContextKeyNotExpr.create(this.key);
	}
}

export class ContextKeyNotExpr implements IContextKeyExpression {

	public static create(key: string): ContextKeyExpression {
		return new ContextKeyNotExpr(key);
	}

	public readonly type = ContextKeyExprType.Not;

	protected constructor(readonly key: string) { }

	public cmp(other: ContextKeyExpression): number {
		if (other.type !== this.type) { return this.type - other.type; }
		return cmp1(this.key, (other as ContextKeyNotExpr).key);
	}

	public equals(other: ContextKeyExpression): boolean {
		return other.type === this.type && this.key === (other as ContextKeyNotExpr).key;
	}

	public evaluate(context: IContext): boolean {
		return !context.getValue(this.key);
	}

	public serialize(): string {
		return `!${this.key}`;
	}

	public keys(): string[] {
		return [this.key];
	}

	public negate(): ContextKeyExpression {
		return ContextKeyDefinedExpr.create(this.key);
	}
}

export class ContextKeyEqualsExpr implements IContextKeyExpression {

	public static create(key: string, value: unknown): ContextKeyExpression {
		return new ContextKeyEqualsExpr(key, value);
	}

	public readonly type = ContextKeyExprType.Equals;

	private constructor(readonly key: string, readonly value: unknown) { }

	public cmp(other: ContextKeyExpression): number {
		if (other.type !== this.type) { return this.type - other.type; }
		const o = other as ContextKeyEqualsExpr;
		const keyCmp = cmp1(this.key, o.key);
		return keyCmp !== 0 ? keyCmp : cmp1(String(this.value), String(o.value));
	}

	public equals(other: ContextKeyExpression): boolean {
		return other.type === this.type && this.key === (other as ContextKeyEqualsExpr).key && this.value === (other as ContextKeyEqualsExpr).value;
	}

	public evaluate(context: IContext): boolean {
		return this.value === context.getValue(this.key);
	}

	// always quoted: `foo == true` parses as `has(foo)`, `foo == 'true'` stays an equals —
	// quoting keeps parse(serialize(x)) === x
	public serialize(): string {
		return `${this.key} == ${quote(String(this.value))}`;
	}

	public keys(): string[] {
		return [this.key];
	}

	public negate(): ContextKeyExpression {
		return ContextKeyNotEqualsExpr.create(this.key, this.value);
	}
}

export class ContextKeyNotEqualsExpr implements IContextKeyExpression {

	public static create(key: string, value: unknown): ContextKeyExpression {
		return new ContextKeyNotEqualsExpr(key, value);
	}

	public readonly type = ContextKeyExprType.NotEquals;

	private constructor(readonly key: string, readonly value: unknown) { }

	public cmp(other: ContextKeyExpression): number {
		if (other.type !== this.type) { return this.type - other.type; }
		const o = other as ContextKeyNotEqualsExpr;
		const keyCmp = cmp1(this.key, o.key);
		return keyCmp !== 0 ? keyCmp : cmp1(String(this.value), String(o.value));
	}

	public equals(other: ContextKeyExpression): boolean {
		return other.type === this.type && this.key === (other as ContextKeyNotEqualsExpr).key && this.value === (other as ContextKeyNotEqualsExpr).value;
	}

	public evaluate(context: IContext): boolean {
		return this.value !== context.getValue(this.key);
	}

	public serialize(): string {
		return `${this.key} != ${quote(String(this.value))}`;
	}

	public keys(): string[] {
		return [this.key];
	}

	public negate(): ContextKeyExpression {
		return ContextKeyEqualsExpr.create(this.key, this.value);
	}
}

export class ContextKeyRegexExpr implements IContextKeyExpression {

	public static create(key: string, regexp: RegExp): ContextKeyExpression {
		return new ContextKeyRegexExpr(key, regexp);
	}

	public readonly type = ContextKeyExprType.Regex;

	private constructor(readonly key: string, readonly regexp: RegExp) { }

	public cmp(other: ContextKeyExpression): number {
		if (other.type !== this.type) { return this.type - other.type; }
		return cmp1(this.key, (other as ContextKeyRegexExpr).key);
	}

	public equals(other: ContextKeyExpression): boolean {
		return other.type === this.type && this.key === (other as ContextKeyRegexExpr).key && String(this.regexp) === String((other as ContextKeyRegexExpr).regexp);
	}

	public evaluate(context: IContext): boolean {
		const value = context.getValue(this.key);
		return value !== undefined && value !== null && this.regexp.test(String(value));
	}

	public serialize(): string {
		return `${this.key} =~ ${this.regexp.toString()}`;
	}

	public keys(): string[] {
		return [this.key];
	}

	public negate(): ContextKeyExpression {
		return ContextKeyNotRegexExpr.create(this.key, this.regexp);
	}
}

export class ContextKeyNotRegexExpr implements IContextKeyExpression {

	public static create(key: string, regexp: RegExp): ContextKeyExpression {
		return new ContextKeyNotRegexExpr(key, regexp);
	}

	public readonly type = ContextKeyExprType.NotRegex;

	private constructor(readonly key: string, readonly regexp: RegExp) { }

	public cmp(other: ContextKeyExpression): number {
		if (other.type !== this.type) { return this.type - other.type; }
		return cmp1(this.key, (other as ContextKeyNotRegexExpr).key);
	}

	public equals(other: ContextKeyExpression): boolean {
		return other.type === this.type && this.key === (other as ContextKeyNotRegexExpr).key && String(this.regexp) === String((other as ContextKeyNotRegexExpr).regexp);
	}

	public evaluate(context: IContext): boolean {
		return !(ContextKeyRegexExpr.create(this.key, this.regexp) as ContextKeyRegexExpr).evaluate(context);
	}

	public serialize(): string {
		return `!${this.key} =~ ${this.regexp.toString()}`;
	}

	public keys(): string[] {
		return [this.key];
	}

	public negate(): ContextKeyExpression {
		return ContextKeyRegexExpr.create(this.key, this.regexp);
	}
}

export class ContextKeyInExpr implements IContextKeyExpression {

	public static create(key: string, value: string | string[]): ContextKeyExpression {
		return new ContextKeyInExpr(key, Array.isArray(value) ? value : [value]);
	}

	public readonly type = ContextKeyExprType.In;

	protected constructor(readonly key: string, readonly values: string[]) { }

	public cmp(other: ContextKeyExpression): number {
		if (other.type !== this.type) { return this.type - other.type; }
		const o = other as ContextKeyInExpr;
		const keyCmp = cmp1(this.key, o.key);
		return keyCmp !== 0 ? keyCmp : cmp1(this.values.join(','), o.values.join(','));
	}

	public equals(other: ContextKeyExpression): boolean {
		return other.type === this.type && this.key === (other as ContextKeyInExpr).key && this.values.join(',') === (other as ContextKeyInExpr).values.join(',');
	}

	public evaluate(context: IContext): boolean {
		const value = context.getValue(this.key);
		if (value === undefined || value === null) {
			return false;
		}
		return this.values.some(v => v === value || v === String(value));
	}

	public serialize(): string {
		return `${this.key} in (${this.values.map(quote).join(', ')})`;
	}

	public keys(): string[] {
		return [this.key];
	}

	public negate(): ContextKeyExpression {
		return ContextKeyNotInExpr.create(this.key, this.values);
	}
}

export class ContextKeyNotInExpr implements IContextKeyExpression {

	public static create(key: string, value: string | string[]): ContextKeyExpression {
		return new ContextKeyNotInExpr(key, Array.isArray(value) ? value : [value]);
	}

	public readonly type = ContextKeyExprType.NotIn;

	private readonly _inner: ContextKeyInExpr;

	private constructor(key: string, values: string[]) {
		this._inner = ContextKeyInExpr.create(key, values) as ContextKeyInExpr;
	}

	public cmp(other: ContextKeyExpression): number {
		if (other.type !== this.type) { return this.type - other.type; }
		return this._inner.cmp((other as ContextKeyNotInExpr)._inner);
	}

	public equals(other: ContextKeyExpression): boolean {
		return other.type === this.type && this._inner.equals((other as ContextKeyNotInExpr)._inner);
	}

	public evaluate(context: IContext): boolean {
		return !this._inner.evaluate(context);
	}

	public serialize(): string {
		return `${this._inner.key} not in (${this._inner.values.map(quote).join(', ')})`;
	}

	public keys(): string[] {
		return this._inner.keys();
	}

	public negate(): ContextKeyExpression {
		return this._inner;
	}
}

// ---- comparisons

function withComparable(key: string, value: unknown): { key: string; value: number } {
	return { key, value: typeof value === 'number' ? value : parseFloat(String(value)) };
}

export class ContextKeyGreaterExpr implements IContextKeyExpression {

	public static create(key: string, value: unknown): ContextKeyExpression {
		const { value: v } = withComparable(key, value);
		return new ContextKeyGreaterExpr(key, v);
	}

	public readonly type = ContextKeyExprType.Greater;

	protected constructor(readonly key: string, readonly value: number) { }

	public cmp(other: ContextKeyExpression): number {
		if (other.type !== this.type) { return this.type - other.type; }
		const o = other as ContextKeyGreaterExpr;
		const keyCmp = cmp1(this.key, o.key);
		return keyCmp !== 0 ? keyCmp : this.value - o.value;
	}

	public equals(other: ContextKeyExpression): boolean {
		return other.type === this.type && this.key === (other as ContextKeyGreaterExpr).key && this.value === (other as ContextKeyGreaterExpr).value;
	}

	public evaluate(context: IContext): boolean {
		return parseFloat(String(context.getValue(this.key))) > this.value;
	}

	public serialize(): string {
		return `${this.key} > ${this.value}`;
	}

	public keys(): string[] {
		return [this.key];
	}

	public negate(): ContextKeyExpression {
		return ContextKeySmallerEqualsExpr.create(this.key, this.value);
	}
}

export class ContextKeyGreaterEqualsExpr implements IContextKeyExpression {

	public static create(key: string, value: unknown): ContextKeyExpression {
		const { value: v } = withComparable(key, value);
		return new ContextKeyGreaterEqualsExpr(key, v);
	}

	public readonly type = ContextKeyExprType.GreaterEquals;

	protected constructor(readonly key: string, readonly value: number) { }

	public cmp(other: ContextKeyExpression): number {
		if (other.type !== this.type) { return this.type - other.type; }
		const o = other as ContextKeyGreaterEqualsExpr;
		const keyCmp = cmp1(this.key, o.key);
		return keyCmp !== 0 ? keyCmp : this.value - o.value;
	}

	public equals(other: ContextKeyExpression): boolean {
		return other.type === this.type && this.key === (other as ContextKeyGreaterEqualsExpr).key && this.value === (other as ContextKeyGreaterEqualsExpr).value;
	}

	public evaluate(context: IContext): boolean {
		return parseFloat(String(context.getValue(this.key))) >= this.value;
	}

	public serialize(): string {
		return `${this.key} >= ${this.value}`;
	}

	public keys(): string[] {
		return [this.key];
	}

	public negate(): ContextKeyExpression {
		return ContextKeySmallerExpr.create(this.key, this.value);
	}
}

export class ContextKeySmallerExpr implements IContextKeyExpression {

	public static create(key: string, value: unknown): ContextKeyExpression {
		const { value: v } = withComparable(key, value);
		return new ContextKeySmallerExpr(key, v);
	}

	public readonly type = ContextKeyExprType.Smaller;

	protected constructor(readonly key: string, readonly value: number) { }

	public cmp(other: ContextKeyExpression): number {
		if (other.type !== this.type) { return this.type - other.type; }
		const o = other as ContextKeySmallerExpr;
		const keyCmp = cmp1(this.key, o.key);
		return keyCmp !== 0 ? keyCmp : this.value - o.value;
	}

	public equals(other: ContextKeyExpression): boolean {
		return other.type === this.type && this.key === (other as ContextKeySmallerExpr).key && this.value === (other as ContextKeySmallerExpr).value;
	}

	public evaluate(context: IContext): boolean {
		return parseFloat(String(context.getValue(this.key))) < this.value;
	}

	public serialize(): string {
		return `${this.key} < ${this.value}`;
	}

	public keys(): string[] {
		return [this.key];
	}

	public negate(): ContextKeyExpression {
		return ContextKeyGreaterEqualsExpr.create(this.key, this.value);
	}
}

export class ContextKeySmallerEqualsExpr implements IContextKeyExpression {

	public static create(key: string, value: unknown): ContextKeyExpression {
		const { value: v } = withComparable(key, value);
		return new ContextKeySmallerEqualsExpr(key, v);
	}

	public readonly type = ContextKeyExprType.SmallerEquals;

	protected constructor(readonly key: string, readonly value: number) { }

	public cmp(other: ContextKeyExpression): number {
		if (other.type !== this.type) { return this.type - other.type; }
		const o = other as ContextKeySmallerEqualsExpr;
		const keyCmp = cmp1(this.key, o.key);
		return keyCmp !== 0 ? keyCmp : this.value - o.value;
	}

	public equals(other: ContextKeyExpression): boolean {
		return other.type === this.type && this.key === (other as ContextKeySmallerEqualsExpr).key && this.value === (other as ContextKeySmallerEqualsExpr).value;
	}

	public evaluate(context: IContext): boolean {
		return parseFloat(String(context.getValue(this.key))) <= this.value;
	}

	public serialize(): string {
		return `${this.key} <= ${this.value}`;
	}

	public keys(): string[] {
		return [this.key];
	}

	public negate(): ContextKeyExpression {
		return ContextKeyGreaterExpr.create(this.key, this.value);
	}
}

// ---- and / or

export class ContextKeyAndExpr implements IContextKeyExpression {

	public static create(expr: ReadonlyArray<ContextKeyExpression | null | undefined>): ContextKeyExpression | undefined {
		const flat: ContextKeyExpression[] = [];
		let hasTrue = false;

		for (const e of expr) {
			if (!e) { continue; }
			if (e.type === ContextKeyExprType.True) { hasTrue = true; continue; }
			if (e.type === ContextKeyExprType.False) { return ContextKeyFalseExpr.INSTANCE; }
			if (e.type === ContextKeyExprType.And) { flat.push(...(e as ContextKeyAndExpr).expr); continue; }
			flat.push(e);
		}

		if (flat.length === 0) { return hasTrue ? ContextKeyTrueExpr.INSTANCE : undefined; }
		if (flat.length === 1) { return flat[0]; }

		flat.sort(cmp);

		// duplicates collapse...
		for (let i = 1; i < flat.length; i++) {
			if (flat[i - 1].equals(flat[i])) { flat.splice(i, 1); i--; }
		}
		// ...and `a && !a` is a contradiction
		for (let i = 1; i < flat.length; i++) {
			if (flat[i - 1].equals(flat[i].negate())) { return ContextKeyFalseExpr.INSTANCE; }
		}

		if (flat.length === 1) { return flat[0]; }
		return new ContextKeyAndExpr(flat);
	}

	public readonly type = ContextKeyExprType.And;

	public constructor(public readonly expr: ContextKeyExpression[]) { }

	public cmp(other: ContextKeyExpression): number {
		if (other.type !== this.type) { return this.type - other.type; }
		const o = other as ContextKeyAndExpr;
		if (this.expr.length !== o.expr.length) { return this.expr.length - o.expr.length; }
		for (let i = 0; i < this.expr.length; i++) {
			const r = cmp(this.expr[i], o.expr[i]);
			if (r !== 0) { return r; }
		}
		return 0;
	}

	public equals(other: ContextKeyExpression): boolean {
		return other.type === this.type && (other as ContextKeyAndExpr).expr.length === this.expr.length
			&& this.expr.every((e, i) => e.equals((other as ContextKeyAndExpr).expr[i]));
	}

	public evaluate(context: IContext): boolean {
		return this.expr.every(e => e.evaluate(context));
	}

	public serialize(): string {
		// parens around Or children: `&&` binds tighter than `||`
		return this.expr.map(e => e.type === ContextKeyExprType.Or ? `(${e.serialize()})` : e.serialize()).join(' && ');
	}

	public keys(): string[] {
		return this.expr.flatMap(e => e.keys());
	}

	public negate(): ContextKeyExpression {
		return ContextKeyOrExpr.create(this.expr.map(e => e.negate()))!;
	}
}

export class ContextKeyOrExpr implements IContextKeyExpression {

	public static create(expr: ReadonlyArray<ContextKeyExpression | null | undefined>): ContextKeyExpression | undefined {
		const flat: ContextKeyExpression[] = [];
		let hasFalse = false;

		for (const e of expr) {
			if (!e) { continue; }
			if (e.type === ContextKeyExprType.False) { hasFalse = true; continue; }
			if (e.type === ContextKeyExprType.True) { return ContextKeyTrueExpr.INSTANCE; }
			if (e.type === ContextKeyExprType.Or) { flat.push(...(e as ContextKeyOrExpr).expr); continue; }
			flat.push(e);
		}

		if (flat.length === 0) { return hasFalse ? ContextKeyFalseExpr.INSTANCE : undefined; }
		if (flat.length === 1) { return flat[0]; }

		flat.sort(cmp);

		for (let i = 1; i < flat.length; i++) {
			if (flat[i - 1].equals(flat[i])) { flat.splice(i, 1); i--; }
		}
		// `a || !a` is a tautology
		for (let i = 1; i < flat.length; i++) {
			if (flat[i - 1].equals(flat[i].negate())) { return ContextKeyTrueExpr.INSTANCE; }
		}

		if (flat.length === 1) { return flat[0]; }
		return new ContextKeyOrExpr(flat);
	}

	public readonly type = ContextKeyExprType.Or;

	public constructor(public readonly expr: ContextKeyExpression[]) { }

	public cmp(other: ContextKeyExpression): number {
		if (other.type !== this.type) { return this.type - other.type; }
		const o = other as ContextKeyOrExpr;
		if (this.expr.length !== o.expr.length) { return this.expr.length - o.expr.length; }
		for (let i = 0; i < this.expr.length; i++) {
			const r = cmp(this.expr[i], o.expr[i]);
			if (r !== 0) { return r; }
		}
		return 0;
	}

	public equals(other: ContextKeyExpression): boolean {
		return other.type === this.type && (other as ContextKeyOrExpr).expr.length === this.expr.length
			&& this.expr.every((e, i) => e.equals((other as ContextKeyOrExpr).expr[i]));
	}

	public evaluate(context: IContext): boolean {
		return this.expr.some(e => e.evaluate(context));
	}

	public serialize(): string {
		return this.expr.map(e => e.serialize()).join(' || ');
	}

	public keys(): string[] {
		return this.expr.flatMap(e => e.keys());
	}

	public negate(): ContextKeyExpression {
		return ContextKeyAndExpr.create(this.expr.map(e => e.negate()))!;
	}
}

// ---- implies

/**
 * Returns true if it is provable that `p` implies `q`.
 */
export function implies(p: ContextKeyExpression, q: ContextKeyExpression): boolean {

	if (p.type === ContextKeyExprType.False || q.type === ContextKeyExprType.True) {
		// false implies anything, anything implies true
		return true;
	}

	if (p.type === ContextKeyExprType.Or) {
		if (q.type === ContextKeyExprType.Or) {
			// `a || b || c` can only imply something like `a || b || c || d`
			return allElementsIncluded((p as ContextKeyOrExpr).expr, (q as ContextKeyOrExpr).expr);
		}
		return false;
	}

	if (q.type === ContextKeyExprType.Or) {
		for (const element of (q as ContextKeyOrExpr).expr) {
			if (implies(p, element)) {
				return true;
			}
		}
		return false;
	}

	if (p.type === ContextKeyExprType.And) {
		if (q.type === ContextKeyExprType.And) {
			// `a && b && c` implies `a && c`
			return allElementsIncluded((q as ContextKeyAndExpr).expr, (p as ContextKeyAndExpr).expr);
		}
		for (const element of (p as ContextKeyAndExpr).expr) {
			if (implies(element, q)) {
				return true;
			}
		}
		return false;
	}

	return p.equals(q);
}

/** both arrays are assumed sorted (they are — And/Or sort their terms) */
function allElementsIncluded(p: ContextKeyExpression[], q: ContextKeyExpression[]): boolean {
	let pIndex = 0;
	let qIndex = 0;
	while (pIndex < p.length && qIndex < q.length) {
		const result = p[pIndex].cmp(q[qIndex]);
		if (result === 0) {
			pIndex++;
			qIndex++;
		} else if (result < 0) {
			return false;
		} else {
			qIndex++;
		}
	}
	return pIndex === p.length;
}

// ---- raw context keys + service surface

export type ContextKeyValue = null | undefined | boolean | number | string
	| Array<null | undefined | boolean | number | string>;

export interface IContextKey<T extends ContextKeyValue = ContextKeyValue> {
	set(value: T): void;
	reset(): void;
	get(): T | undefined;
}

export const IContextKeyService = createDecorator<IContextKeyService>('contextKeyService');

export interface IContextKeyChangeEvent {
	affectsSome(keys: ReadonlySet<string>): boolean;
}

export interface IContextKeyService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeContext: Event<IContextKeyChangeEvent>;

	createKey<T extends ContextKeyValue>(key: string, defaultValue: T | undefined): IContextKey<T>;
	contextMatchesRules(rules: ContextKeyExpression | undefined): boolean;
	getContextKeyValue<T>(key: string): T | undefined;

	createScoped(target?: unknown): IContextKeyService;
}

export class RawContextKey<T extends ContextKeyValue> extends ContextKeyDefinedExpr {

	constructor(readonly rawKey: string, private readonly _defaultValue: T | undefined) {
		super(rawKey);
	}

	public bindTo(target: IContextKeyService): IContextKey<T> {
		return target.createKey(this.rawKey, this._defaultValue);
	}

	public getValue(target: IContextKeyService): T | undefined {
		return target.getContextKeyValue<T>(this.rawKey);
	}

	public toNegated(): ContextKeyExpression {
		return this.negate();
	}

	public isEqualTo(value: unknown): ContextKeyExpression {
		return ContextKeyEqualsExpr.create(this.rawKey, value);
	}

	public notEqualsTo(value: unknown): ContextKeyExpression {
		return ContextKeyNotEqualsExpr.create(this.rawKey, value);
	}
}
