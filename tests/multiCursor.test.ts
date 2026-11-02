// tests/multiCursor.test.ts — the bookkeeping behind several cursors.
//
// Two things go wrong with multi-cursor and both are arithmetic. Cursors that drift onto the same
// spot must MERGE, or every keystroke is applied twice there. And after N insertions each cursor
// has to account for every edit before it — cursor 3 is two insertions further along than it
// looks. Both are tested here without a widget.

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { Selection } from '../src/renderer/editor/browser/core/selection.js';
import {
	editsForCursors, normalizeCursors, positionsAfterInsert, selectionsOverlap
} from '../src/common/editor/common/model/multiCursor.js';
import { wordAt } from '../src/renderer/editor/contrib/multicursor/multicursor.js';

/** a cursor (empty selection) at a position */
const at = (lineNumber: number, column: number) => new Selection(lineNumber, column, lineNumber, column);
/** a selection from one position to another */
const sel = (l1: number, c1: number, l2: number, c2: number) => new Selection(l1, c1, l2, c2);
/** the readable form of a cursor list */
const positions = (selections: readonly Selection[]) =>
	selections.map(s => [s.startLineNumber, s.startColumn, s.endLineNumber, s.endColumn]);

// ---- selectionsOverlap

test('two cursors in the same place overlap', () => {
	assert.equal(selectionsOverlap(at(1, 5), at(1, 5)), true);
});

test('two cursors in different places do not overlap', () => {
	assert.equal(selectionsOverlap(at(1, 5), at(1, 6)), false);
	assert.equal(selectionsOverlap(at(1, 5), at(2, 5)), false);
});

test('a cursor at the edge of a selection is a separate cursor', () => {
	// clicking just before or after a selected word is a legitimate second cursor
	assert.equal(selectionsOverlap(sel(1, 3, 1, 7), at(1, 3)), false);
	assert.equal(selectionsOverlap(sel(1, 3, 1, 7), at(1, 7)), false);
});

test('a cursor inside a selection overlaps it', () => {
	assert.equal(selectionsOverlap(sel(1, 3, 1, 7), at(1, 5)), true);
});

test('selections that share characters overlap', () => {
	assert.equal(selectionsOverlap(sel(1, 1, 1, 5), sel(1, 4, 1, 9)), true);
});

test('selections that merely touch do not overlap', () => {
	assert.equal(selectionsOverlap(sel(1, 1, 1, 5), sel(1, 5, 1, 9)), false);
});

test('overlap across lines is detected', () => {
	assert.equal(selectionsOverlap(sel(1, 1, 3, 1), at(2, 4)), true);
	assert.equal(selectionsOverlap(sel(1, 1, 3, 1), at(4, 1)), false);
});

// ---- normalizeCursors

test('cursors come back in document order', () => {
	const result = normalizeCursors([at(5, 1), at(1, 1), at(3, 1)], 0);
	assert.deepEqual(result.selections.map(s => s.startLineNumber), [1, 3, 5]);
});

test('the primary follows its selection through the sort', () => {
	// index 0 is the cursor on line 5, which sorts last
	const result = normalizeCursors([at(5, 1), at(1, 1), at(3, 1)], 0);
	assert.equal(result.selections[result.primaryIndex].startLineNumber, 5);
});

test('duplicate cursors merge', () => {
	const result = normalizeCursors([at(1, 1), at(1, 1), at(2, 1)], 0);
	assert.deepEqual(result.selections.map(s => s.startLineNumber), [1, 2]);
});

test('a merge never loses the primary', () => {
	// the primary is the duplicate that gets dropped; the survivor must inherit it
	const result = normalizeCursors([at(2, 1), at(1, 1), at(1, 1)], 2);
	assert.equal(result.selections.length, 2);
	assert.deepEqual(
		[result.selections[result.primaryIndex].startLineNumber, result.selections[result.primaryIndex].startColumn],
		[1, 1]
	);
});

test('overlapping selections merge to one', () => {
	const result = normalizeCursors([sel(1, 1, 1, 6), sel(1, 4, 1, 9)], 0);
	assert.equal(result.selections.length, 1);
});

test('identical selections merge', () => {
	const result = normalizeCursors([sel(1, 1, 1, 6), sel(1, 1, 1, 6)], 0);
	assert.equal(result.selections.length, 1);
});

test('distinct cursors are all kept', () => {
	const result = normalizeCursors([at(1, 1), at(2, 1), at(3, 1)], 1);
	assert.equal(result.selections.length, 3);
	assert.equal(result.primaryIndex, 1);
});

test('an empty list normalises to an empty list', () => {
	const result = normalizeCursors([], 0);
	assert.deepEqual(result.selections, []);
	assert.equal(result.primaryIndex, 0);
});

test('a single cursor is unchanged', () => {
	const result = normalizeCursors([at(4, 7)], 0);
	assert.deepEqual(positions(result.selections), [[4, 7, 4, 7]]);
	assert.equal(result.primaryIndex, 0);
});

// ---- editsForCursors

test('each cursor contributes one edit over its own range', () => {
	const edits = editsForCursors([at(1, 1), sel(2, 3, 2, 6)], 'x');
	assert.equal(edits.length, 2);
	assert.deepEqual([edits[0].range.startLineNumber, edits[0].range.startColumn], [1, 1]);
	assert.deepEqual([edits[1].range.startColumn, edits[1].range.endColumn], [3, 6]);
	assert.equal(edits[1].text, 'x');
});

test('the edits are in document order, which is what lets the model batch them', () => {
	const edits = editsForCursors(normalizeCursors([at(3, 1), at(1, 1)], 0).selections, 'y');
	assert.deepEqual(edits.map(e => e.range.startLineNumber), [1, 3]);
});

// ---- positionsAfterInsert

test('one cursor advances by the inserted length', () => {
	assert.deepEqual(positionsAfterInsert([at(1, 1)], 'abc'), [{ lineNumber: 1, column: 4 }]);
});

test('cursors on different lines each advance on their own line', () => {
	assert.deepEqual(positionsAfterInsert([at(1, 1), at(2, 1)], 'ab'), [
		{ lineNumber: 1, column: 3 },
		{ lineNumber: 2, column: 3 }
	]);
});

test('a later cursor on the SAME line accounts for the earlier insertion', () => {
	// this is the case that silently goes wrong: without the shift, cursor 2 lands two characters
	// to the left of the text it just typed
	assert.deepEqual(positionsAfterInsert([at(1, 1), at(1, 5)], 'ab'), [
		{ lineNumber: 1, column: 3 },
		{ lineNumber: 1, column: 9 }
	]);
});

test('three cursors on one line accumulate the shift', () => {
	assert.deepEqual(positionsAfterInsert([at(1, 1), at(1, 3), at(1, 5)], 'x'), [
		{ lineNumber: 1, column: 2 },
		{ lineNumber: 1, column: 5 },
		{ lineNumber: 1, column: 8 }
	]);
});

test('replacing a selection accounts for what was removed', () => {
	// 'ab' replaces three characters, so the next cursor on that line moves LEFT by one
	assert.deepEqual(positionsAfterInsert([sel(1, 1, 1, 4), at(1, 6)], 'ab'), [
		{ lineNumber: 1, column: 3 },
		{ lineNumber: 1, column: 7 }
	]);
});

test('a newline pushes every later cursor down a line', () => {
	assert.deepEqual(positionsAfterInsert([at(1, 1), at(2, 1)], '\n'), [
		{ lineNumber: 2, column: 1 },
		{ lineNumber: 4, column: 1 }
	]);
});

test('a multi-line insertion lands the cursor on its last line', () => {
	assert.deepEqual(positionsAfterInsert([at(1, 1)], 'a\nbc'), [{ lineNumber: 2, column: 3 }]);
});

test('replacing a multi-line selection pulls later cursors up', () => {
	// three lines become one, so the cursor two lines below moves up by two
	assert.deepEqual(positionsAfterInsert([sel(1, 1, 3, 1), at(5, 1)], 'x'), [
		{ lineNumber: 1, column: 2 },
		{ lineNumber: 3, column: 2 }
	]);
});

test('no cursors gives no positions', () => {
	assert.deepEqual(positionsAfterInsert([], 'x'), []);
});

// ---- wordAt, which Ctrl+D uses for its first press

test('wordAt finds the word around a column', () => {
	assert.deepEqual(wordAt('const value = 1;', 8), { startColumn: 7, endColumn: 12 });
});

test('wordAt finds the word a cursor sits just after', () => {
	// after typing a word the cursor is past its last character, and Ctrl+D must still find it
	assert.deepEqual(wordAt('const', 6), { startColumn: 1, endColumn: 6 });
});

test('wordAt returns null in whitespace', () => {
	assert.equal(wordAt('a   b', 3), null);
});

test('wordAt returns null on an empty line', () => {
	assert.equal(wordAt('', 1), null);
});

test('wordAt stops at separators', () => {
	assert.deepEqual(wordAt('foo.bar', 6), { startColumn: 5, endColumn: 8 });
});
