// tests/renameValidation.test.ts — the pure logic behind the rename input box.
//
// The sanity check is the case worth having: a provider that answers a different question returns
// edits that look structurally fine, and applying them rewrites the wrong text in every file.

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	renameLocationAt, validateNewName, validateRenameResult
} from '../src/common/editor/common/model/renameValidation.js';

test('the rename box seeds itself from the word at the cursor', () => {
	const line = 'const total = count + 1;';
	assert.deepEqual(renameLocationAt(line, 7, 8), {
		range: { startLineNumber: 7, startColumn: 7, endLineNumber: 7, endColumn: 12 },
		text: 'total'
	});
});

test('a cursor just after a word still renames that word', () => {
	const line = 'const total = 1;';
	// column 12 is the space after `total`, where the cursor lands having typed the name
	assert.equal(renameLocationAt(line, 1, 12)?.text, 'total');
});

test('there is nothing to rename in whitespace or in an empty line', () => {
	assert.equal(renameLocationAt('  \t  ', 1, 3), null);
	assert.equal(renameLocationAt('', 1, 1), null);
});

test('each rejected name says why', () => {
	assert.equal(validateNewName('', 'old'), 'The new name cannot be empty.');
	assert.equal(validateNewName('a\nb', 'old'), 'The new name cannot contain a line break.');
	assert.equal(validateNewName('   ', 'old'), 'The new name cannot be only whitespace.');
	assert.equal(validateNewName(' new', 'old'), 'The new name cannot start or end with whitespace.');
	assert.equal(validateNewName('new ', 'old'), 'The new name cannot start or end with whitespace.');
	assert.equal(validateNewName('old', 'old'), 'The new name is the same as the old name.');
	assert.equal(validateNewName('newName', 'old'), null);
});

test('a result with no edits is refused', () => {
	assert.equal(validateRenameResult([], 'newName'), 'No result.');
});

test('a result whose edits do not mention the new name is refused', () => {
	const reason = validateRenameResult([{ text: 'newName' }, { text: 'somethingElse' }], 'newName');
	assert.equal(reason, "Rename produced an edit that does not contain 'newName'.");
	// a deletion is not a rename either
	assert.equal(validateRenameResult([{ text: null }], 'newName'), "Rename produced an edit that does not contain 'newName'.");
});

test('a result whose every edit contains the new name is applied', () => {
	assert.equal(validateRenameResult([{ text: 'newName' }, { text: 'this.newName' }], 'newName'), null);
});
