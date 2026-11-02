// tests/indentRanges.test.ts — the nesting structure read from indentation, and which of those
// scopes sticky scroll pins.
//
// The blank-line case is the one that matters: a gap between two statements is inside the
// function, not after it, and a range computation that disagrees looks right until someone
// leaves a blank line in their code.

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	computeIndentRanges, enclosingRanges, IIndentSource, indentLevelOf, stickyLinesFor
} from '../src/common/editor/common/model/indentRanges.js';

function source(text: string): IIndentSource {
	const lines = text.split('\n');
	return {
		getLineCount: () => lines.length,
		getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? ''
	};
}

/** ranges as [start, end] pairs, which is what the assertions are about */
function ranges(text: string, tabSize = 4): [number, number][] {
	return computeIndentRanges(source(text), tabSize).map(r => [r.startLineNumber, r.endLineNumber]);
}

// ---- indentLevelOf

test('indentLevelOf counts spaces', () => {
	assert.equal(indentLevelOf('abc', 4), 0);
	assert.equal(indentLevelOf('  abc', 4), 2);
	assert.equal(indentLevelOf('    abc', 4), 4);
});

test('indentLevelOf advances a tab to the next stop, not by one', () => {
	assert.equal(indentLevelOf('\tabc', 4), 4);
	assert.equal(indentLevelOf('\t\tabc', 4), 8);
	// two spaces then a tab lands on the stop at 4, not at 6
	assert.equal(indentLevelOf('  \tabc', 4), 4);
});

test('indentLevelOf honours the tab size', () => {
	assert.equal(indentLevelOf('\tabc', 2), 2);
	assert.equal(indentLevelOf('\tabc', 8), 8);
});

test('indentLevelOf reports -1 for a blank or whitespace-only line', () => {
	assert.equal(indentLevelOf('', 4), -1);
	assert.equal(indentLevelOf('    ', 4), -1);
	assert.equal(indentLevelOf('\t\t', 4), -1);
});

// ---- computeIndentRanges

test('a simple block is one range ending at its last child', () => {
	assert.deepEqual(ranges('f() {\n\ta;\n\tb;\n}'), [[1, 3]]);
});

test('nested blocks give nested ranges', () => {
	const text = 'f() {\n\tif {\n\t\tx;\n\t}\n}';
	assert.deepEqual(ranges(text), [[1, 4], [2, 3]]);
});

test('a blank line does not end a block', () => {
	// the classic failure: `a;` and `b;` are both inside f
	assert.deepEqual(ranges('f() {\n\ta;\n\n\tb;\n}'), [[1, 4]]);
});

test('trailing blank lines do not extend a block', () => {
	assert.deepEqual(ranges('f() {\n\ta;\n}\n\n\n'), [[1, 2]]);
});

test('a flat file has no ranges', () => {
	assert.deepEqual(ranges('a;\nb;\nc;'), []);
});

test('a single line has no ranges', () => {
	assert.deepEqual(ranges('a;'), []);
});

test('an empty document has no ranges', () => {
	assert.deepEqual(ranges(''), []);
});

test('two sibling blocks are two ranges', () => {
	const text = 'f() {\n\ta;\n}\ng() {\n\tb;\n}';
	assert.deepEqual(ranges(text), [[1, 2], [4, 5]]);
});

test('an unclosed block runs to the last line with content', () => {
	assert.deepEqual(ranges('f() {\n\ta;\n\tb;'), [[1, 3]]);
});

test('ranges come back sorted by start line', () => {
	const text = 'a:\n\tb:\n\t\tc\n\td\ne:\n\tf';
	const starts = computeIndentRanges(source(text)).map(r => r.startLineNumber);
	assert.deepEqual(starts, [...starts].sort((x, y) => x - y));
});

test('python-style indentation works the same without braces', () => {
	const text = 'def f():\n    if x:\n        return 1\n    return 2';
	assert.deepEqual(ranges(text), [[1, 4], [2, 3]]);
});

test('a block indented by tabs is found with the tab size applied', () => {
	assert.deepEqual(ranges('f:\n\ta\n\tb', 4), [[1, 3]]);
});

test('a deeper jump than one level is still one range', () => {
	// indentation that skips a level must not invent an intermediate scope
	assert.deepEqual(ranges('a:\n\t\t\tb'), [[1, 2]]);
});

// ---- enclosingRanges

test('enclosingRanges returns the scopes around a line, outermost first', () => {
	const computed = computeIndentRanges(source('f() {\n\tif {\n\t\tx;\n\t}\n}'));
	assert.deepEqual(enclosingRanges(computed, 3).map(r => r.startLineNumber), [1, 2]);
});

test('a header is not inside its own block', () => {
	// pinning a header above itself would show the same line twice
	const computed = computeIndentRanges(source('f() {\n\ta;\n}'));
	assert.deepEqual(enclosingRanges(computed, 1).map(r => r.startLineNumber), []);
	assert.deepEqual(enclosingRanges(computed, 2).map(r => r.startLineNumber), [1]);
});

test('a line past every block encloses nothing', () => {
	const computed = computeIndentRanges(source('f() {\n\ta;\n}\nb;'));
	assert.deepEqual(enclosingRanges(computed, 4).map(r => r.startLineNumber), []);
});

// ---- stickyLinesFor

test('stickyLinesFor pins the enclosing headers', () => {
	const computed = computeIndentRanges(source('f() {\n\tif {\n\t\tx;\n\t}\n}'));
	assert.deepEqual(stickyLinesFor(computed, 3, 5).map(r => r.startLineNumber), [1, 2]);
});

test('stickyLinesFor keeps the OUTERMOST scopes when capped', () => {
	// deep nesting would otherwise pin away the whole viewport
	const text = 'a:\n\tb:\n\t\tc:\n\t\t\td:\n\t\t\t\te';
	const computed = computeIndentRanges(source(text));
	assert.deepEqual(stickyLinesFor(computed, 5, 2).map(r => r.startLineNumber), [1, 2]);
});

test('stickyLinesFor pins nothing at the top of a file', () => {
	const computed = computeIndentRanges(source('f() {\n\ta;\n}'));
	assert.deepEqual(stickyLinesFor(computed, 1, 5), []);
});

test('stickyLinesFor pins nothing with a cap of zero', () => {
	const computed = computeIndentRanges(source('f() {\n\ta;\n}'));
	assert.deepEqual(stickyLinesFor(computed, 2, 0), []);
});

test('stickyLinesFor pins nothing in a flat file', () => {
	const computed = computeIndentRanges(source('a;\nb;\nc;'));
	assert.deepEqual(stickyLinesFor(computed, 2, 5), []);
});
