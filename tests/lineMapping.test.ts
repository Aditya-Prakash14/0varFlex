// tests/lineMapping.test.ts — the model ↔ view line map.
//
// This is the piece folding and word wrap share, so it is tested on its own before either is
// built on it. The cases that matter: a hidden line has to map SOMEWHERE sensible (its fold
// header) rather than to a line that is not drawn, the two directions have to round-trip for
// every visible line, and nested folds have to merge rather than double-count.

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { LineMapping, normalizeHiddenRanges } from '../src/common/editor/common/viewModel/lineMapping.js';

const range = (startLineNumber: number, endLineNumber: number) => ({ startLineNumber, endLineNumber });

// ---- normalizeHiddenRanges

test('ranges come back sorted', () => {
	assert.deepEqual(normalizeHiddenRanges([range(5, 6), range(1, 2)]), [range(1, 2), range(5, 6)]);
});

test('overlapping ranges merge', () => {
	assert.deepEqual(normalizeHiddenRanges([range(1, 5), range(3, 8)]), [range(1, 8)]);
});

test('abutting ranges merge', () => {
	// [2,4] and [5,7] together hide 2..7; leaving them apart makes every count off by nothing but
	// every lookup do twice the work and the merge logic lie
	assert.deepEqual(normalizeHiddenRanges([range(2, 4), range(5, 7)]), [range(2, 7)]);
});

test('a contained range is absorbed', () => {
	assert.deepEqual(normalizeHiddenRanges([range(1, 10), range(3, 4)]), [range(1, 10)]);
});

test('ranges with a gap stay separate', () => {
	assert.deepEqual(normalizeHiddenRanges([range(2, 3), range(6, 7)]), [range(2, 3), range(6, 7)]);
});

test('an inverted range is dropped', () => {
	assert.deepEqual(normalizeHiddenRanges([range(5, 2)]), []);
});

// ---- no hidden lines: the mapping must be the identity

test('with nothing hidden the map is the identity', () => {
	const mapping = new LineMapping(10);
	assert.equal(mapping.viewLineCount, 10);
	assert.equal(mapping.hasHiddenLines(), false);
	for (let line = 1; line <= 10; line++) {
		assert.equal(mapping.modelToView(line), line);
		assert.equal(mapping.viewToModel(line), line);
		assert.equal(mapping.isHidden(line), false);
	}
});

// ---- one hidden range

test('lines after a hidden range shift up by its size', () => {
	// hide 3..5 of 10: view lines are model 1,2,6,7,8,9,10
	const mapping = new LineMapping(10, [range(3, 5)]);
	assert.equal(mapping.viewLineCount, 7);
	assert.equal(mapping.modelToView(1), 1);
	assert.equal(mapping.modelToView(2), 2);
	assert.equal(mapping.modelToView(6), 3);
	assert.equal(mapping.modelToView(10), 7);
});

test('a hidden line maps to its fold header', () => {
	// model 3..5 are collapsed into model line 2, which is view line 2
	const mapping = new LineMapping(10, [range(3, 5)]);
	assert.equal(mapping.isHidden(3), true);
	assert.equal(mapping.isHidden(5), true);
	assert.equal(mapping.modelToView(3), 2);
	assert.equal(mapping.modelToView(4), 2);
	assert.equal(mapping.modelToView(5), 2);
});

test('viewToModel skips the hidden range', () => {
	const mapping = new LineMapping(10, [range(3, 5)]);
	assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(view => mapping.viewToModel(view)), [1, 2, 6, 7, 8, 9, 10]);
});

test('every visible line round-trips', () => {
	const mapping = new LineMapping(20, [range(4, 7), range(12, 15)]);
	for (let view = 1; view <= mapping.viewLineCount; view++) {
		assert.equal(mapping.modelToView(mapping.viewToModel(view)), view, `view line ${view}`);
	}
});

// ---- several ranges

test('two hidden ranges both shift what follows', () => {
	// hide 3..4 and 7..8 of 10: view is model 1,2,5,6,9,10
	const mapping = new LineMapping(10, [range(3, 4), range(7, 8)]);
	assert.equal(mapping.viewLineCount, 6);
	assert.deepEqual([1, 2, 3, 4, 5, 6].map(view => mapping.viewToModel(view)), [1, 2, 5, 6, 9, 10]);
	assert.equal(mapping.modelToView(9), 5);
});

test('nested folds merge instead of hiding the same line twice', () => {
	// collapsing an inner block then the outer one produces overlapping ranges
	const mapping = new LineMapping(10, [range(2, 9), range(4, 6)]);
	assert.equal(mapping.viewLineCount, 2, 'lines 2..9 hidden once, not twice');
	assert.deepEqual([1, 2].map(view => mapping.viewToModel(view)), [1, 10]);
});

// ---- edges

test('hiding from line 1 keeps a view line to stand on', () => {
	const mapping = new LineMapping(5, [range(1, 5)]);
	assert.equal(mapping.viewLineCount, 1, 'a document with no height has nothing to click on');
	assert.equal(mapping.modelToView(1), 1);
});

test('a range past the end of the document is clamped', () => {
	const mapping = new LineMapping(5, [range(3, 99)]);
	assert.equal(mapping.viewLineCount, 2);
	assert.deepEqual(mapping.getHiddenRanges(), [range(3, 5)]);
});

test('out-of-bounds lookups are clamped rather than throwing', () => {
	const mapping = new LineMapping(5, [range(2, 3)]);
	assert.equal(mapping.modelToView(0), 1);
	assert.equal(mapping.modelToView(99), mapping.viewLineCount);
	assert.equal(mapping.viewToModel(0), 1);
	assert.equal(mapping.viewToModel(99), 5);
});

test('hiding the last line works', () => {
	const mapping = new LineMapping(5, [range(5, 5)]);
	assert.equal(mapping.viewLineCount, 4);
	assert.equal(mapping.modelToView(5), 4, 'collapsed into line 4');
});

test('clearing the ranges restores the identity', () => {
	const mapping = new LineMapping(10, [range(3, 5)]);
	mapping.setHiddenRanges([]);
	assert.equal(mapping.viewLineCount, 10);
	assert.equal(mapping.modelToView(6), 6);
});

test('a shrinking document clamps the ranges it still holds', () => {
	const mapping = new LineMapping(10, [range(6, 9)]);
	mapping.setModelLineCount(7);
	assert.deepEqual(mapping.getHiddenRanges(), [range(6, 7)]);
	assert.equal(mapping.viewLineCount, 5);
});

// ---- modelLinesForViewRange, which the layers loop directly

test('modelLinesForViewRange leaves hidden lines out', () => {
	const mapping = new LineMapping(10, [range(3, 5)]);
	assert.deepEqual(mapping.modelLinesForViewRange(1, 7), [1, 2, 6, 7, 8, 9, 10]);
});

test('modelLinesForViewRange covers only the asked-for window', () => {
	const mapping = new LineMapping(10, [range(3, 5)]);
	assert.deepEqual(mapping.modelLinesForViewRange(2, 4), [2, 6, 7]);
});

test('modelLinesForViewRange clamps to the document', () => {
	const mapping = new LineMapping(4);
	assert.deepEqual(mapping.modelLinesForViewRange(-5, 99), [1, 2, 3, 4]);
});
