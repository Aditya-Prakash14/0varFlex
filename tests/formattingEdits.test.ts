// tests/formattingEdits.test.ts — what a formatting provider's edits turn into before they reach
// the model: order, overlap rejection, and whether anything actually changes.
//
// The no-op cases are the ones that matter: a formatter that returns the document unchanged must
// leave the file clean, so "no provider" and "nothing to format" look the same to the user.

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { IRange, Range } from '../src/common/editor/common/core/range.js';
import {
	IFormattingSource, ITextEdit, prepareFormattingEdits, sortFormattingEdits
} from '../src/common/editor/common/model/formattingEdits.js';

/** a source over a plain string, resolving ranges the way the text buffer does */
function source(text: string): IFormattingSource {
	const lines = text.split('\n');
	return {
		getValueInRange: (range: IRange) => {
			if (range.startLineNumber === range.endLineNumber) {
				return lines[range.startLineNumber - 1].substring(range.startColumn - 1, range.endColumn - 1);
			}
			const parts = [lines[range.startLineNumber - 1].substring(range.startColumn - 1)];
			for (let line = range.startLineNumber + 1; line < range.endLineNumber; line++) {
				parts.push(lines[line - 1]);
			}
			parts.push(lines[range.endLineNumber - 1].substring(0, range.endColumn - 1));
			return parts.join('\n');
		}
	};
}

function edit(startLine: number, startColumn: number, endLine: number, endColumn: number, text: string): ITextEdit {
	return { range: new Range(startLine, startColumn, endLine, endColumn), text };
}

/** edits as [startLine, startColumn, endLine, endColumn, text], which is what the assertions are about */
function shape(edits: readonly ITextEdit[]): unknown[] {
	return edits.map(e => [e.range.startLineNumber, e.range.startColumn, e.range.endLineNumber, e.range.endColumn, e.text]);
}

// ---- ordering

test('edits are sorted into document order', () => {
	const unsorted = [edit(3, 1, 3, 2, 'c'), edit(1, 5, 1, 6, 'b'), edit(1, 1, 1, 2, 'a')];
	assert.deepEqual(sortFormattingEdits(unsorted).map(e => e.text), ['a', 'b', 'c']);
});

test('sorting leaves the provider array alone', () => {
	const unsorted = [edit(2, 1, 2, 2, 'b'), edit(1, 1, 1, 2, 'a')];
	sortFormattingEdits(unsorted);
	assert.equal(unsorted[0].text, 'b');
});

test('an insert sorts before a replace starting at the same position', () => {
	const unsorted = [edit(1, 1, 1, 4, 'replace'), edit(1, 1, 1, 1, 'insert')];
	assert.deepEqual(sortFormattingEdits(unsorted).map(e => e.text), ['insert', 'replace']);
});

test('unordered input is prepared in document order', () => {
	const result = prepareFormattingEdits(source('aaaa\nbbbb'), [edit(2, 1, 2, 2, 'X'), edit(1, 1, 1, 2, 'Y')]);
	assert.deepEqual(shape(result.edits), [[1, 1, 1, 2, 'Y'], [2, 1, 2, 2, 'X']]);
	assert.equal(result.hasChanges, true);
});

// ---- overlap

test('overlapping edits are rejected and nothing is applied', () => {
	const result = prepareFormattingEdits(source('abcdef'), [edit(1, 1, 1, 4, 'X'), edit(1, 3, 1, 6, 'Y')]);
	assert.deepEqual(result.edits, []);
	assert.equal(result.hasChanges, false);
	assert.ok(result.overlap);
	// reported in document order whichever order the provider used
	assert.equal(result.overlap[0].startColumn, 1);
	assert.equal(result.overlap[1].startColumn, 3);
});

test('an overlap across lines is rejected', () => {
	const result = prepareFormattingEdits(source('abc\ndef'), [edit(1, 2, 2, 3, 'X'), edit(2, 1, 2, 4, 'Y')]);
	assert.ok(result.overlap);
});

test('two inserts at the same position are an overlap only if one is a replace', () => {
	// two zero-width inserts at the same spot touch rather than overlap, so they merge
	const result = prepareFormattingEdits(source('ab'), [edit(1, 2, 1, 2, 'X'), edit(1, 2, 1, 2, 'Y')]);
	assert.equal(result.overlap, undefined);
	assert.deepEqual(shape(result.edits), [[1, 2, 1, 2, 'XY']]);
});

test('touching edits are not an overlap', () => {
	const result = prepareFormattingEdits(source('abcdef'), [edit(1, 1, 1, 3, 'X'), edit(1, 3, 1, 5, 'Y')]);
	assert.equal(result.overlap, undefined);
	assert.deepEqual(shape(result.edits), [[1, 1, 1, 5, 'XY']]);
});

test('edits with a gap between them stay separate', () => {
	const result = prepareFormattingEdits(source('abcdef'), [edit(1, 1, 1, 2, 'X'), edit(1, 4, 1, 5, 'Y')]);
	assert.deepEqual(shape(result.edits), [[1, 1, 1, 2, 'X'], [1, 4, 1, 5, 'Y']]);
});

// ---- no-ops

test('an edit whose text already matches the model is dropped', () => {
	const result = prepareFormattingEdits(source('abcdef'), [edit(1, 1, 1, 3, 'ab'), edit(1, 4, 1, 5, 'X')]);
	assert.deepEqual(shape(result.edits), [[1, 4, 1, 5, 'X']]);
	assert.equal(result.hasChanges, true);
});

test('an all-no-op edit list reports no change', () => {
	const result = prepareFormattingEdits(source('abc\ndef'), [edit(1, 1, 1, 4, 'abc'), edit(2, 1, 2, 4, 'def')]);
	assert.deepEqual(result.edits, []);
	assert.equal(result.hasChanges, false);
	assert.equal(result.overlap, undefined);
});

test('an empty insert at a position is a no-op', () => {
	const result = prepareFormattingEdits(source('abc'), [edit(1, 2, 1, 2, '')]);
	assert.equal(result.hasChanges, false);
});

test('a whole-document edit that changes nothing reports no change', () => {
	const text = 'const a = 1;\nconst b = 2;';
	const result = prepareFormattingEdits(source(text), [edit(1, 1, 2, 13, text)]);
	assert.equal(result.hasChanges, false);
});

// ---- the whole-document and empty cases

test('a single whole-document edit survives as one edit', () => {
	const result = prepareFormattingEdits(source('const a=1;\nconst b=2;'), [
		edit(1, 1, 2, 11, 'const a = 1;\nconst b = 2;')
	]);
	assert.deepEqual(shape(result.edits), [[1, 1, 2, 11, 'const a = 1;\nconst b = 2;']]);
	assert.equal(result.hasChanges, true);
});

test('an empty edit list reports no change', () => {
	const result = prepareFormattingEdits(source('abc'), []);
	assert.deepEqual(result.edits, []);
	assert.equal(result.hasChanges, false);
	assert.equal(result.overlap, undefined);
});
