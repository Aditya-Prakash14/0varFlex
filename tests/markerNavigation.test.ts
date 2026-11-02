// tests/markerNavigation.test.ts — which marker F8 goes to.
//
// Three cases carry the weight: the cursor sitting exactly on a marker (must advance, not stand
// still), the cursor past the last one (must wrap), and two markers on one line (must order by
// column, not by the severity order the service returns them in).

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { URI } from '../src/common/base/common/uri.js';
import { IMarker, MarkerSeverity } from '../src/renderer/workbench/services/markers/browser/markerService.js';
import {
	describeMarker, findMarkerNear, indexOfMarker, sortedForNavigation
} from '../src/renderer/editor/contrib/gotoError/markerNavigation.js';

const resource = URI.file('/a/b.ts');

function marker(lineNumber: number, column: number, message = `m${lineNumber}:${column}`, severity = MarkerSeverity.Error): IMarker {
	return {
		owner: 'test',
		resource,
		severity,
		message,
		range: { startLineNumber: lineNumber, startColumn: column, endLineNumber: lineNumber, endColumn: column + 3 }
	};
}

const AT = (m: IMarker | null) => m && [m.range.startLineNumber, m.range.startColumn];

// ---- ordering

test('sortedForNavigation orders by line then column, ignoring severity', () => {
	const markers = [
		marker(5, 1, 'e', MarkerSeverity.Error),
		marker(1, 9, 'w', MarkerSeverity.Warning),
		marker(1, 2, 'h', MarkerSeverity.Hint)
	];
	assert.deepEqual(sortedForNavigation(markers).map(m => [m.range.startLineNumber, m.range.startColumn]),
		[[1, 2], [1, 9], [5, 1]]);
});

test('sortedForNavigation does not mutate its input', () => {
	const markers = [marker(5, 1), marker(1, 1)];
	sortedForNavigation(markers);
	assert.equal(markers[0].range.startLineNumber, 5);
});

// ---- next

test('next finds the following marker', () => {
	const markers = [marker(2, 1), marker(8, 1)];
	assert.deepEqual(AT(findMarkerNear(markers, { lineNumber: 1, column: 1 }, 'next')), [2, 1]);
	assert.deepEqual(AT(findMarkerNear(markers, { lineNumber: 5, column: 1 }, 'next')), [8, 1]);
});

test('next from exactly on a marker advances rather than standing still', () => {
	// pressing F8 twice must reach the second problem
	const markers = [marker(2, 1), marker(8, 1)];
	assert.deepEqual(AT(findMarkerNear(markers, { lineNumber: 2, column: 1 }, 'next')), [8, 1]);
});

test('next wraps to the first marker past the end', () => {
	const markers = [marker(2, 1), marker(8, 1)];
	assert.deepEqual(AT(findMarkerNear(markers, { lineNumber: 99, column: 1 }, 'next')), [2, 1]);
});

test('next distinguishes two markers on the same line by column', () => {
	const markers = [marker(3, 20), marker(3, 5)];
	assert.deepEqual(AT(findMarkerNear(markers, { lineNumber: 3, column: 1 }, 'next')), [3, 5]);
	assert.deepEqual(AT(findMarkerNear(markers, { lineNumber: 3, column: 5 }, 'next')), [3, 20]);
	// past both on that line, it wraps rather than returning one of them again
	assert.deepEqual(AT(findMarkerNear(markers, { lineNumber: 3, column: 30 }, 'next')), [3, 5]);
});

// ---- previous

test('previous finds the preceding marker', () => {
	const markers = [marker(2, 1), marker(8, 1)];
	assert.deepEqual(AT(findMarkerNear(markers, { lineNumber: 9, column: 1 }, 'previous')), [8, 1]);
	assert.deepEqual(AT(findMarkerNear(markers, { lineNumber: 5, column: 1 }, 'previous')), [2, 1]);
});

test('previous from exactly on a marker goes back rather than standing still', () => {
	const markers = [marker(2, 1), marker(8, 1)];
	assert.deepEqual(AT(findMarkerNear(markers, { lineNumber: 8, column: 1 }, 'previous')), [2, 1]);
});

test('previous wraps to the last marker before the start', () => {
	const markers = [marker(2, 1), marker(8, 1)];
	assert.deepEqual(AT(findMarkerNear(markers, { lineNumber: 1, column: 1 }, 'previous')), [8, 1]);
});

test('next and previous round-trip between two markers', () => {
	const markers = [marker(2, 1), marker(8, 1)];
	const forward = findMarkerNear(markers, { lineNumber: 1, column: 1 }, 'next')!;
	const back = findMarkerNear(markers, {
		lineNumber: forward.range.startLineNumber,
		column: forward.range.startColumn
	}, 'previous')!;
	assert.deepEqual(AT(back), [8, 1]); // wrapped, because 2 is the first
});

// ---- edges

test('a single marker is returned from anywhere, in both directions', () => {
	const markers = [marker(4, 1)];
	assert.deepEqual(AT(findMarkerNear(markers, { lineNumber: 1, column: 1 }, 'next')), [4, 1]);
	assert.deepEqual(AT(findMarkerNear(markers, { lineNumber: 9, column: 1 }, 'next')), [4, 1]);
	assert.deepEqual(AT(findMarkerNear(markers, { lineNumber: 4, column: 1 }, 'previous')), [4, 1]);
});

test('no markers gives null, not a crash', () => {
	assert.equal(findMarkerNear([], { lineNumber: 1, column: 1 }, 'next'), null);
	assert.equal(findMarkerNear([], { lineNumber: 1, column: 1 }, 'previous'), null);
});

// ---- the message

test('describeMarker shows severity, position and message', () => {
	assert.equal(describeMarker(marker(5, 1, 'missing semicolon'), 1, 2), 'Error (2 of 2): missing semicolon');
});

test('describeMarker omits the count for a lone marker', () => {
	assert.equal(describeMarker(marker(1, 1, 'oops'), 0, 1), 'Error: oops');
});

test('describeMarker names the severity', () => {
	assert.equal(describeMarker(marker(1, 1, 'careful', MarkerSeverity.Warning), 0, 1), 'Warning: careful');
});

test('indexOfMarker reports the reading-order position', () => {
	const markers = [marker(9, 1, 'last'), marker(1, 1, 'first')];
	assert.equal(indexOfMarker(markers, markers[1]), 0);
	assert.equal(indexOfMarker(markers, markers[0]), 1);
});
