// The ported word/character classifier and the movement semantics (home toggle, desired column,
// word moves) — the pure functions behind Option+Arrow, Home and Up/Down.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Position } from '../src/common/editor/common/core/position.js';
import {
	classifyChar,
	nextCharLength,
	prevCharLength,
	USUAL_WORD_SEPARATORS,
	getWordAtTextDefault,
	WordCharacterClass
} from '../src/renderer/editor/browser/core/wordHelper.js';
import {
	firstNonWhitespaceColumn,
	getWordOrSeparatorAtColumn,
	ICursorModel,
	moveToBeginningOfLine,
	moveToEndOfLine,
	moveWordLeft,
	moveWordRight,
	verticalMove,
	WordNavigationType
} from '../src/renderer/editor/browser/core/cursorColumns.js';
import { ViewModel } from '../src/renderer/editor/browser/viewModel.js';

function fakeModel(lines: string[]): ICursorModel {
	return {
		getLineContent: lineNumber => lines[lineNumber - 1],
		getLineMaxColumn: lineNumber => lines[lineNumber - 1].length + 1,
		getLineCount: () => lines.length
	};
}

const viewModel = new ViewModel({ lineHeight: 19, charWidth: 7, tabSize: 4, lineCount: 1 });

test('classifier: separable table verbatim, space/tab are whitespace, everything else regular', () => {
	assert.equal(USUAL_WORD_SEPARATORS, '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?');
	assert.equal(classifyChar(' '), WordCharacterClass.Whitespace);
	assert.equal(classifyChar('\t'), WordCharacterClass.Whitespace);
	for (const separator of USUAL_WORD_SEPARATORS) {
		assert.equal(classifyChar(separator), WordCharacterClass.WordSeparator, `separator ${JSON.stringify(separator)}`);
	}
	assert.equal(classifyChar('a'), WordCharacterClass.Regular);
	assert.equal(classifyChar('0'), WordCharacterClass.Regular);
});

test('surrogate pair lengths: emoji count as 2 code units', () => {
	assert.equal(prevCharLength('a😀', 3), 2);
	assert.equal(prevCharLength('ab', 2), 1);
	assert.equal(nextCharLength('😀b', 1), 2);
	assert.equal(nextCharLength('ab', 1), 1);
});

test('getWordAtTextDefault finds the enclosing word (numbers stay whole)', () => {
	assert.equal(getWordAtTextDefault(16, 'const value = 12.5;')?.word, '12.5');
	assert.equal(getWordAtTextDefault(3, 'const value = 12.5;')?.word, 'const');
	assert.equal(getWordAtTextDefault(1, '  spaced  '), null);
});

test('home toggle: first press → first non-whitespace, second press → column 1 (and back)', () => {
	const text = '    foo';
	assert.equal(firstNonWhitespaceColumn(text), 5);
	assert.equal(moveToBeginningOfLine(text, 8), 5);
	assert.equal(moveToBeginningOfLine(text, 5), 1);
	assert.equal(moveToBeginningOfLine(text, 1), 5);

	// an all-whitespace line: first non-whitespace is 0 → column 1
	assert.equal(firstNonWhitespaceColumn('   '), 0);
	assert.equal(moveToBeginningOfLine('   ', 3), 1);

	// no indentation: no movement
	assert.equal(moveToBeginningOfLine('foo', 3), 1);
	assert.equal(moveToEndOfLine('foo'), 4);
});

test('desired column survives short lines: col 40 → through "abc" → col 40 restored', () => {
	const model = fakeModel(['x'.repeat(40), 'abc', 'y'.repeat(50)]);

	// col 40 on line 1, move down
	let result = verticalMove(model, viewModel, 1, 40, 0, 2, true);
	assert.equal(result.column, 4, 'clamped to the short line');
	assert.equal(result.leftoverVisibleColumns, 36, 'deficit remembered');

	// from the clamped position, move down again → desired column restored
	result = verticalMove(model, viewModel, 2, result.column, result.leftoverVisibleColumns, 3, true);
	assert.equal(result.column, 40);
	assert.equal(result.leftoverVisibleColumns, 0);
});

test('desired column clamps at the last line and resets at the buffer edge', () => {
	const model = fakeModel(['x'.repeat(40), 'ab']);
	const result = verticalMove(model, viewModel, 2, 3, 0, 3, true);
	assert.equal(result.lineNumber, 2, 'clamped to the last line');
	assert.equal(result.column, 3, 'edge line with allowMoveOnEdgeLine uses the max column');
	assert.equal(result.leftoverVisibleColumns, 0);
});

test('tabs feed the desired column: moving from after a tab lands on the tab stop', () => {
	const model = fakeModel(['\tx', 'abcd']);
	const result = verticalMove(model, viewModel, 1, 2, 0, 2, true);
	// visible column 4 on a line with boundaries 0..4 → column 5 (after 'abcd')
	assert.equal(result.column, 5);
});

test('word left/right (mac defaults): WordStartFast and WordEnd', () => {
	const model = fakeModel(['foo.bar']);

	// alt+left from the end → start of "bar" (the separator is a boundary)
	let position = moveWordLeft(model, new Position(1, 8), WordNavigationType.WordStartFast);
	assert.equal(position.toString(), '1:5');

	// again → the fast rule skips the single separator and lands at the start of "foo"
	position = moveWordLeft(model, position, WordNavigationType.WordStartFast);
	assert.equal(position.toString(), '1:1');

	// alt+right from the beginning → END of "foo"
	position = moveWordRight(model, new Position(1, 1), WordNavigationType.WordEnd);
	assert.equal(position.toString(), '1:4');

	// again → END of "bar"
	position = moveWordRight(model, position, WordNavigationType.WordEnd);
	assert.equal(position.toString(), '1:8');
});

test('word moves cross lines', () => {
	const model = fakeModel(['abc', 'def']);

	// from the start of line 2 the port lands at the START of the previous word (line 1, col 1)
	assert.equal(moveWordLeft(model, new Position(2, 1), WordNavigationType.WordStartFast).toString(), '1:1');
	assert.equal(moveWordRight(model, new Position(1, 4), WordNavigationType.WordEnd).toString(), '2:4');
});

test('double-click word/separator fallback', () => {
	assert.deepEqual(
		getWordOrSeparatorAtColumn('const value = 1;', 8),
		{ word: 'value', startColumn: 7, endColumn: 12 }
	);
	// on the separator "=" → the separator run itself
	assert.deepEqual(
		getWordOrSeparatorAtColumn('const value = 1;', 13),
		{ word: '=', startColumn: 13, endColumn: 14 }
	);
	// on whitespace → the whitespace run
	const whitespace = getWordOrSeparatorAtColumn('a  b', 2);
	assert.equal(whitespace?.word, '  ');
});
