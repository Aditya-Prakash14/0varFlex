// tests/bracketMatching.test.ts — the bracket scan and the auto-closing type decision.
//
// Both are pure functions over a line source, so the nesting arithmetic and the
// "should this close?" rules are tested without a widget. The type tests apply the returned
// insertion to a string and mark the cursor with |, so what is asserted is what the user sees.

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { Position } from '../src/common/editor/common/core/position.js';
import {
	autoClosingTypeResult, findMatchingBracket, IBracketSource
} from '../src/common/editor/common/model/bracketMatching.js';
import { languageConfigurationFor } from '../src/common/editor/common/languages/languageConfiguration.js';

function source(text: string): IBracketSource {
	const lines = text.split('\n');
	return {
		getLineCount: () => lines.length,
		getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? ''
	};
}

const TS = languageConfigurationFor('x.ts');
const PY = languageConfigurationFor('x.py');
const HTML = languageConfigurationFor('x.html');

/** 'a(b)c' at column 2 -> the pair of [line, column] positions, or null */
function match(text: string, lineNumber: number, column: number, brackets = TS.brackets): [number, number][] | null {
	const found = findMatchingBracket(source(text), new Position(lineNumber, column), brackets);
	return found && [
		[found.bracket.startLineNumber, found.bracket.startColumn],
		[found.partner.startLineNumber, found.partner.startColumn]
	];
}

// ---- findMatchingBracket

test('matches a pair on one line from the opener', () => {
	//            123456
	assert.deepEqual(match('a(b)c', 1, 2), [[1, 2], [1, 4]]);
});

test('matches from the closer, scanning backwards', () => {
	assert.deepEqual(match('a(b)c', 1, 4), [[1, 4], [1, 2]]);
});

test('looks to the right of the cursor first, then to the left', () => {
	// cursor at column 3 sits between `(` at 2 and `b` at 3: the left bracket is found
	assert.deepEqual(match('a(b)c', 1, 3), [[1, 2], [1, 4]]);
});

test('respects nesting rather than taking the first closer', () => {
	//                      1234567
	assert.deepEqual(match('((a))', 1, 1), [[1, 1], [1, 5]]);
	assert.deepEqual(match('((a))', 1, 2), [[1, 2], [1, 4]]);
});

test('matches across lines', () => {
	const text = 'function f() {\n\treturn 1;\n}';
	assert.deepEqual(match(text, 1, 14), [[1, 14], [3, 1]]);
});

test('matches backwards across lines', () => {
	const text = 'function f() {\n\treturn 1;\n}';
	assert.deepEqual(match(text, 3, 1), [[3, 1], [1, 14]]);
});

test('skips blank lines while scanning', () => {
	const text = '{\n\n\n}';
	assert.deepEqual(match(text, 1, 1), [[1, 1], [4, 1]]);
});

test('returns null for an unbalanced bracket', () => {
	assert.equal(match('a(b', 1, 2), null);
	assert.equal(match('a)b', 1, 2), null);
});

test('returns null when the cursor is not beside a bracket', () => {
	assert.equal(match('abc', 1, 2), null);
});

test('returns null on an empty line', () => {
	assert.equal(match('', 1, 1), null);
});

test('different bracket kinds do not match each other', () => {
	assert.equal(match('(]', 1, 1), null);
});

test('counts only its own kind, so a nested other kind does not confuse it', () => {
	//                      123456789
	assert.deepEqual(match('f([a], b)', 1, 2), [[1, 2], [1, 9]]);
	assert.deepEqual(match('f([a], b)', 1, 3), [[1, 3], [1, 5]]);
});

test('markup matches angle brackets, which C-like does not', () => {
	assert.deepEqual(match('<p>', 1, 1, HTML.brackets), [[1, 1], [1, 3]]);
	assert.equal(match('<p>', 1, 1, TS.brackets), null);
});

// ---- autoClosingTypeResult

/** type `typed` into `before|after` and render the result with | as the cursor */
function type(typed: string, before: string, after: string, configuration = TS, insertSpaces = false): string {
	const line = before + after;
	const position = new Position(1, before.length + 1);
	const result = autoClosingTypeResult(typed, {
		source: source(line),
		position,
		configuration,
		indent: { tabSize: 4, insertSpaces }
	});
	if (!result) {
		return `${before}${typed}|${after}`; // the caller would insert it unchanged
	}
	if (result.overtype) {
		return `${before}${after.slice(0, 1)}|${after.slice(1)}`;
	}
	const inserted = result.text;
	return `${before}${inserted.slice(0, result.cursorOffset)}|${inserted.slice(result.cursorOffset)}${after}`;
}

test('typing an opener at the end of a line closes it', () => {
	assert.equal(type('(', 'f', ''), 'f(|)');
	assert.equal(type('[', 'x = ', ''), 'x = [|]');
	assert.equal(type('{', 'if ', ''), 'if {|}');
});

test('typing an opener before a word does NOT close it', () => {
	// `(foo` must not become `()foo`
	assert.equal(type('(', '', 'foo'), '(|foo');
});

test('typing an opener before a closer or punctuation does close it', () => {
	assert.equal(type('(', 'f', ')'), 'f(|))');
	assert.equal(type('(', 'f', ';'), 'f(|);');
	assert.equal(type('(', 'f', ' x'), 'f(|) x');
});

test('typing a closer over the auto-inserted one steps over it', () => {
	// this is the rule that stops `()` becoming `())`
	assert.equal(type(')', 'f(', ')'), 'f()|');
});

test('typing a closer where there is none inserts it', () => {
	assert.equal(type(')', 'f(a', ''), 'f(a)|');
});

test('typing a quote closes it', () => {
	assert.equal(type('"', 'x = ', ''), 'x = "|"');
});

test('typing a quote over the matching one steps over it', () => {
	assert.equal(type('"', 'x = "a', '"'), 'x = "a"|');
});

test('a quote straight after a word is an apostrophe, not a pair', () => {
	// `it's` must not become `it''s`
	assert.equal(type("'", 'it', ''), "it'|");
});

test('python has no backtick pair but javascript does', () => {
	assert.equal(type('`', 'x = ', ''), 'x = `|`');
	assert.equal(type('`', 'x = ', '', PY), 'x = `|');
});

test('a multi-character insertion is never auto-closed', () => {
	// a paste or a composition commit goes in verbatim
	assert.equal(autoClosingTypeResult('((', {
		source: source(''),
		position: new Position(1, 1),
		configuration: TS,
		indent: { tabSize: 4, insertSpaces: false }
	}), null);
});

// ---- Enter

test('Enter carries the current indentation over', () => {
	assert.equal(type('\n', '\tfoo();', ''), '\tfoo();\n\t|');
});

test('Enter on an unindented line inserts a plain newline', () => {
	assert.equal(type('\n', 'foo();', ''), 'foo();\n|');
});

test('Enter after an opener adds one level', () => {
	assert.equal(type('\n', 'if (x) {', ''), 'if (x) {\n\t|');
});

test('Enter between a pair puts the closer on its own line', () => {
	assert.equal(type('\n', 'if (x) {', '}'), 'if (x) {\n\t|\n}');
});

test('Enter between a pair keeps the block indented inside an indented block', () => {
	assert.equal(type('\n', '\tif (x) {', '}'), '\tif (x) {\n\t\t|\n\t}');
});

test('Enter after an opener uses spaces when insertSpaces is on', () => {
	assert.equal(type('\n', 'if (x) {', '', TS, true), 'if (x) {\n    |');
});

test('Enter after an opener with trailing whitespace still indents', () => {
	assert.equal(type('\n', 'if (x) {  ', ''), 'if (x) {  \n\t|');
});

test('Enter keeps tabs as tabs rather than normalising the indent', () => {
	assert.equal(type('\n', '\t\tfoo();', '', TS, true), '\t\tfoo();\n\t\t|');
});
