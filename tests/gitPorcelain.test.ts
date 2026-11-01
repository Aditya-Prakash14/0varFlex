// A2-1: the `git status --porcelain -z` parser and its two-axis → one-letter collapse.
// Pure logic, so it is tested directly; the extension's spawning is not.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePorcelain, statusLetter } from '../extensions/git-lite/src/porcelain.js';

/** -z terminates every field with NUL */
function z(...records: string[]): string {
	return records.map(record => `${record}\0`).join('');
}

// ---- the letter collapse

test('statusLetter: untracked and ignored are their own states', () => {
	assert.equal(statusLetter('?', '?'), 'U');
	assert.equal(statusLetter('!', '!'), 'I');
});

test('statusLetter: conflicts win over everything', () => {
	assert.equal(statusLetter('U', 'U'), 'C');
	assert.equal(statusLetter('A', 'U'), 'C');
	assert.equal(statusLetter('U', 'D'), 'C');
	// git reports both-added and both-deleted for conflicts without a 'U' on either axis
	assert.equal(statusLetter('A', 'A'), 'C');
	assert.equal(statusLetter('D', 'D'), 'C');
});

test('statusLetter: the worktree axis wins when it has a state', () => {
	assert.equal(statusLetter(' ', 'M'), 'M');   // modified, not staged
	assert.equal(statusLetter('M', 'M'), 'M');   // staged AND modified again
	assert.equal(statusLetter(' ', 'D'), 'D');
});

test('statusLetter: a staged-only change falls back to the index axis', () => {
	assert.equal(statusLetter('A', ' '), 'A');   // newly added, staged, untouched since
	assert.equal(statusLetter('M', ' '), 'M');
	assert.equal(statusLetter('R', ' '), 'R');
});

// ---- the parser

test('parsePorcelain: an empty status yields no entries', () => {
	assert.deepEqual(parsePorcelain(''), []);
	assert.deepEqual(parsePorcelain('\0'), []);
});

test('parsePorcelain: three modified files become three entries with the right letters', () => {
	const entries = parsePorcelain(z(' M src/a.ts', 'A  src/b.ts', ' D src/c.ts'));
	assert.equal(entries.length, 3);
	assert.deepEqual(entries.map(entry => [entry.path, entry.letter]), [
		['src/a.ts', 'M'],
		['src/b.ts', 'A'],
		['src/c.ts', 'D']
	]);
});

test('parsePorcelain: an untracked file is U', () => {
	const entries = parsePorcelain(z('?? notes.md'));
	assert.equal(entries.length, 1);
	assert.equal(entries[0].letter, 'U');
	assert.equal(entries[0].path, 'notes.md');
});

test('parsePorcelain: a rename consumes the FOLLOWING field as the original path', () => {
	// git emits "R  <new>\0<old>\0" — the old path is a separate field, not part of the record
	const entries = parsePorcelain(z('R  src/new.ts', 'src/old.ts', ' M src/other.ts'));
	assert.equal(entries.length, 2, 'the original path must not be read as its own entry');
	assert.equal(entries[0].path, 'src/new.ts');
	assert.equal(entries[0].letter, 'R');
	assert.equal(entries[0].originalPath, 'src/old.ts');
	// the entry after the rename is still parsed correctly
	assert.equal(entries[1].path, 'src/other.ts');
	assert.equal(entries[1].letter, 'M');
	assert.equal(entries[1].originalPath, undefined);
});

test('parsePorcelain: a copy also consumes the original path', () => {
	const entries = parsePorcelain(z('C  dst.ts', 'src.ts'));
	assert.equal(entries.length, 1);
	assert.equal(entries[0].originalPath, 'src.ts');
});

test('parsePorcelain: paths with spaces survive (-z never quotes)', () => {
	const entries = parsePorcelain(z(' M my folder/a file.ts'));
	assert.equal(entries.length, 1);
	assert.equal(entries[0].path, 'my folder/a file.ts');
});

test('parsePorcelain: a path containing a quote or backslash is taken literally', () => {
	// this is exactly why -z is used instead of the default escaped output
	const entries = parsePorcelain(z(' M weird/"quoted".ts', ' M back\\slash.ts'));
	assert.deepEqual(entries.map(entry => entry.path), ['weird/"quoted".ts', 'back\\slash.ts']);
});

test('parsePorcelain: both axes are preserved for callers that want them', () => {
	const entries = parsePorcelain(z('MM src/a.ts'));
	assert.equal(entries[0].indexStatus, 'M');
	assert.equal(entries[0].worktreeStatus, 'M');
});

test('parsePorcelain: truncated or junk records are skipped, never thrown', () => {
	assert.deepEqual(parsePorcelain(z('M', ' M', 'xy')), []);
	// a well-formed record after junk is still found
	const entries = parsePorcelain(z('M', ' M src/a.ts'));
	assert.equal(entries.length, 1);
	assert.equal(entries[0].path, 'src/a.ts');
});

test('parsePorcelain: a rename with a missing original path does not swallow the next entry', () => {
	// defensive: malformed input must not consume an unrelated record
	const entries = parsePorcelain('R  src/new.ts\0\0 M src/other.ts\0');
	assert.equal(entries.length, 2);
	assert.equal(entries[0].originalPath, undefined);
	assert.equal(entries[1].path, 'src/other.ts');
});
