// The suggest filter (12): subsequence scoring with matched indices for bolding, and the word
// prefix used both for filtering and as the fallback replace range.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scoreItem, wordPrefixAt } from '../src/renderer/editor/contrib/suggest/suggest.js';

test('an empty prefix matches everything with no bold ranges', () => {
	const result = scoreItem('name', '');
	assert.ok(result);
	assert.deepEqual(result.matched, []);
});

test('subsequence matching is case-insensitive and reports indices into the label', () => {
	const result = scoreItem('timeout', 'tmt');
	assert.ok(result);
	assert.deepEqual(result.matched, [0, 2, 6]);

	assert.equal(scoreItem('name', 'xyz'), null);
	assert.ok(scoreItem('NAME', 'na'));
});

test('consecutive matches score higher than scattered ones', () => {
	const consecutive = scoreItem('name', 'nam');
	const scattered = scoreItem('n_a_m_e', 'nam');
	assert.ok(consecutive);
	assert.ok(scattered);
	assert.ok(consecutive.score > scattered.score, `${consecutive.score} > ${scattered.score}`);
});

test('wordPrefixAt stops at the separator table', () => {
	// "timeout = au" with the cursor AFTER "au" (1-based column 13): the prefix is "au"
	assert.deepEqual(wordPrefixAt('timeout = au', 13), { prefix: 'au', startColumn: 11 });
	// cursor between "a" and "u" (column 12): only "a" precedes it
	assert.deepEqual(wordPrefixAt('timeout = au', 12), { prefix: 'a', startColumn: 11 });
	// cursor right after the "=": empty prefix starting at the cursor
	assert.deepEqual(wordPrefixAt('timeout = ', 10), { prefix: '', startColumn: 10 });
	assert.deepEqual(wordPrefixAt('', 1), { prefix: '', startColumn: 1 });
	assert.deepEqual(wordPrefixAt('name', 5), { prefix: 'name', startColumn: 1 });
});
