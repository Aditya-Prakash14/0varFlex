// The when-clause table: scanner → parser → evaluator, canonical serialize round-trips,
// implies() semantics, and the context key service's scope/change behavior.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ContextKeyExpression, implies, Parser } from '../src/renderer/platform/contextkey/common/contextkey.js';
import { ContextKeyService } from '../src/renderer/platform/contextkey/common/contextKeyService.js';

const parser = new Parser();

function parse(input: string): ContextKeyExpression {
	const expr = parser.parse(input);
	assert.ok(expr, `expected '${input}' to parse (errors: ${JSON.stringify(parser.parsingErrors)} ${JSON.stringify(parser.lexingErrors)})`);
	return expr!;
}

function evalWith(input: string, context: Record<string, unknown>): boolean {
	return parse(input).evaluate({ getValue: <T,>(key: string) => context[key] as T | undefined });
}

test('when-clause evaluation table', () => {
	const cases: Array<[string, Record<string, unknown>, boolean]> = [
		// defined / not
		['foo', { foo: true }, true],
		['foo', { foo: false }, false],
		['foo', {}, false],
		['!foo', {}, true],
		['!foo', { foo: true }, false],
		// equals / notEquals — quoting preserved
		["foo == 'bar'", { foo: 'bar' }, true],
		["foo == 'bar'", { foo: 'baz' }, false],
		['foo == bar', { foo: 'bar' }, true],
		['foo != bar', { foo: 'baz' }, true],
		["foo != 'true'", { foo: 'true' }, false],
		// `== true` / `== false` optimize to has/not unless quoted
		['foo == true', { foo: true }, true],
		['foo == true', {}, false],
		['foo == false', {}, true],
		["foo == 'true'", { foo: true }, false],
		// and / or / precedence
		['a && b', { a: true, b: true }, true],
		['a && b', { a: true }, false],
		['a || b', { b: true }, true],
		['a || !b && c', { a: false, b: false, c: true }, true],
		['a || !b && c', { a: false, b: true, c: true }, false],
		['( a || b ) && c', { a: true, c: true }, true],
		['( a || b ) && c', { a: true }, false],
		['!a', { a: false }, true],
		['true', {}, true],
		['false', {}, false],
		['!true', {}, false],
		['!( a && b )', { a: true }, true],
		// in / not in lists
		["x in (a, b, 'c d')", { x: 'a' }, true],
		["x in (a, b, 'c d')", { x: 'c d' }, true],
		["x in (a, b, 'c d')", { x: 'z' }, false],
		['k not in (1, 2)', { k: '3' }, true],
		['k not in (1, 2)', { k: 1 }, false],
		// regex (with escaped $ and flags)
		['foo =~ /^a\\$b/', { foo: 'a$b' }, true],
		['foo =~ /^a\\$b/', { foo: 'axb' }, false],
		['foo =~ /bar/i', { foo: 'BARD' }, true],
		// string escaping: doubled quote
		["title == 'it''s here'", { title: "it's here" }, true],
		["title == 'it''s here'", { title: 'other' }, false],
		// comparisons
		['count > 3', { count: 4 }, true],
		['count > 3', { count: 3 }, false],
		['count >= 3', { count: 3 }, true],
		['count < 3', { count: 2 }, true],
		['count <= 3', { count: 3 }, true],
		['count <= 3', { count: '4' }, false],
		['count <= 3', { count: '2' }, true],
	];

	for (const [when, context, expected] of cases) {
		assert.equal(evalWith(when, context), expected, `'${when}' with ${JSON.stringify(context)}`);
	}
});

test('parser round-trips serialize() canonically', () => {
	const inputs = [
		'foo', '!foo', "foo == 'bar'", 'foo != bar', 'foo =~ /^a\\$b/', 'a && b', 'a || !b && c',
		'( a || b ) && c', "x in (a, b, 'c d')", 'k not in (1, 2)', 'a > 3', 'a >= 3', 'a < 3',
		'a <= 3', 'true', 'false', "title == 'it''s here'", 'b && a'
	];

	for (const input of inputs) {
		const expr = parse(input);
		const serialized = expr.serialize();
		const reparsed = parse(serialized);
		assert.equal(reparsed.serialize(), serialized, `round trip for '${input}' (canonical '${serialized}')`);
		assert.ok(expr.equals(reparsed), `equals after round trip for '${input}'`);
	}
});

test('scanner errors: unterminated string and regex are errors, not exceptions', () => {
	assert.equal(parser.parse("foo == 'bar"), undefined);
	assert.equal(parser.parse('foo =~ /bar'), undefined);
	assert.equal(parser.parse('foo =~ /a\\/b'), undefined); // escaped slash but never closed
	assert.equal(parser.parse(''), undefined);
	assert.equal(parser.parse('a &&'), undefined);
	assert.equal(parser.parse('&& a'), undefined);
});

test('implies()', () => {
	assert.equal(implies(parse('a && b'), parse('a')), true);
	assert.equal(implies(parse('a'), parse('a || b')), true);
	assert.equal(implies(parse('a'), parse('!a')), false);
	assert.equal(implies(parse('!a'), parse('b || !b')), true);
	assert.equal(implies(parse('false'), parse('a')), true);
	assert.equal(implies(parse('a'), parse('true')), true);
	assert.equal(implies(parse('a && b'), parse('a && b && c')), false);
	assert.equal(implies(parse('a || b'), parse('a || b || c')), true);
});

test('negation stays symbolic and round-trips', () => {
	for (const input of ['a == b', "a in (x, y)", 'a =~ /foo/', 'a > 3', 'a && b', 'a || b']) {
		const expr = parse(input);
		const negated = expr.negate();
		const reparsed = parse(negated.serialize());
		assert.ok(reparsed.equals(negated), `negation round trip for '${input}' -> '${negated.serialize()}'`);
	}
});

test('ContextKeyService: scopes, change events, same-value short-circuit, expr cache', async () => {
	const service = new ContextKeyService();
	const scoped = service.createScoped();

	const key = scoped.createKey<boolean>('flag', false);
	key.set(true);
	assert.equal(scoped.getContextKeyValue('flag'), true);
	assert.equal(service.getContextKeyValue('flag'), undefined); // scoped values do not leak up

	let fired = 0;
	scoped.onDidChangeContext(event => {
		fired++;
		assert.ok(event.affectsSome(new Set(['flag'])));
	});

	key.set(false);
	assert.equal(fired, 0); // buffered until the microtask
	await Promise.resolve();
	assert.equal(fired, 1);

	key.set(false); // same value: short-circuit, no event
	await Promise.resolve();
	assert.equal(fired, 1);

	// expression cache invalidates only when one of its keys changed
	const expr = parse('flag == false');
	assert.equal(scoped.contextMatchesRules(expr), true);
	key.set(true);
	await Promise.resolve();
	assert.equal(scoped.contextMatchesRules(expr), false);

	// unrelated key changes do not affect it
	key.set(false);
	await Promise.resolve();
	assert.equal(scoped.contextMatchesRules(expr), true);
});
