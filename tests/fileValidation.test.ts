// The explorer's validation (isValidBasename / getWellFormedFileName / validateFileName ported
// from extpath.ts + fileActions.ts) and the inline input's accept/cancel flow (no DOM needed for
// the validation functions; the widget flows are driven through a minimal DOM shim is out of
// scope — those are covered by the live acceptance).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getWellFormedFileName, isValidBasename, validateFileName } from '../src/renderer/workbench/contrib/files/browser/inlineInput.js';

test('isValidBasename: unix rules (the platform default)', () => {
	assert.equal(isValidBasename('file.ts'), true);
	assert.equal(isValidBasename('with space.txt'), true);
	assert.equal(isValidBasename('with.dot.in.name'), true);

	assert.equal(isValidBasename('a/b'), false, 'slashes are invalid');
	assert.equal(isValidBasename(''), false);
	assert.equal(isValidBasename('   '), false, 'whitespace only');
	assert.equal(isValidBasename('.'), false, 'reserved');
	assert.equal(isValidBasename('..'), false, 'reserved');
	assert.equal(isValidBasename('x'.repeat(256)), false, 'over 255 chars');
	assert.equal(isValidBasename('x'.repeat(255)), true);
	assert.equal(isValidBasename('trailing.dot.'), true, 'unix allows trailing dots');
});

test('isValidBasename: windows rules when asked (reserved names, trailing dot/space)', () => {
	assert.equal(isValidBasename('con', true), false);
	assert.equal(isValidBasename('CON.txt', true), false);
	assert.equal(isValidBasename('lpt1', true), false);
	assert.equal(isValidBasename('clock$', true), false);
	assert.equal(isValidBasename('trailing.dot.', true), false);
	assert.equal(isValidBasename('trailing space ', true), false);
	assert.equal(isValidBasename('a\\b', true), false, 'backslashes invalid on windows');
	assert.equal(isValidBasename('file.ts', true), true);
});

test('getWellFormedFileName: trims tabs and trailing slashes', () => {
	assert.equal(getWellFormedFileName('\tname.ts\t'), 'name.ts');
	assert.equal(getWellFormedFileName('folder/'), 'folder');
	assert.equal(getWellFormedFileName('folder\\'), 'folder');
	assert.equal(getWellFormedFileName(''), '');
});

test('validateFileName: the ported message order', () => {
	assert.equal(validateFileName(''), 'A file or folder name must be provided.');
	assert.equal(validateFileName('   '), 'A file or folder name must be provided.');
	assert.equal(validateFileName('/absolute'), 'A file or folder name cannot start with a slash.');
	assert.equal(validateFileName('\\absolute'), 'A file or folder name cannot start with a slash.');
	assert.equal(
		validateFileName('a/b', { parentChildNames: [] }),
		'The name a/b is not valid as a file or folder name. Please choose a different name.'
	);
	assert.equal(
		validateFileName('exists.ts', { parentChildNames: ['exists.ts', 'other.ts'] }),
		'A file or folder exists.ts already exists at this location. Please choose a different name.'
	);
	assert.equal(validateFileName('exists.ts', { parentChildNames: ['exists.ts'], currentName: 'exists.ts' }), null, 'renaming to the same name is fine');
	assert.equal(validateFileName('fresh.ts', { parentChildNames: ['other.ts'] }), null);
});
