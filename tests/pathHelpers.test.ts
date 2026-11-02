// tests/pathHelpers.test.ts — the path helpers that replaced five hand-rolled copies.
//
// Two of those copies split on '/' only, so on Windows — where `URI.fsPath` is
// backslash-separated — they found no separator at all:
//
//   * explorerService.dirnameUri returned '/' for every path, so the explorer never found a
//     parent directory;
//   * the settings-file watcher watched the filesystem ROOT instead of the settings directory,
//     which is why editing settings.json outside the app never triggered a reload on Windows.
//
// Both now call the vendored path module. These tests pin the behaviour that was broken, and the
// win32-vs-platform distinction that decides which function a caller should use.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { basename, dirname, posix, win32 } from '../src/vendor/vscode/base/common/path.js';
import { basename as labelBasename } from '../src/renderer/workbench/common/editor/textEditorInput.js';
import { URI } from '../src/common/base/common/uri.js';
import { dirnameUri } from '../src/renderer/workbench/contrib/files/browser/explorerService.js';

test('win32 treats BOTH separators as separators, on any host', () => {
	// this is why a display label uses win32 and not the platform default: a path may have been
	// produced on another machine
	assert.equal(win32.basename('C:\\dir\\file.ts'), 'file.ts');
	assert.equal(win32.basename('/a/b/file.ts'), 'file.ts');
	assert.equal(win32.dirname('C:\\dir\\file.ts'), 'C:\\dir');
	assert.equal(win32.dirname('/a/b/file.ts'), '/a/b');
});

test('posix treats a backslash as an ordinary filename character', () => {
	// and this is why a REAL local path must use the platform default: on posix a backslash is
	// data, and win32's rules would split a legitimate filename in half
	assert.equal(posix.basename('a\\b.ts'), 'a\\b.ts');
	assert.equal(posix.dirname('a\\b.ts'), '.');
});

test('the display basename accepts either separator and survives a trailing one', () => {
	assert.equal(labelBasename('/a/b/file.ts'), 'file.ts');
	assert.equal(labelBasename('/a/b/'), 'b');
	assert.equal(labelBasename('C:\\dir\\file.ts'), 'file.ts');
	assert.equal(labelBasename('C:\\dir\\'), 'dir');
	assert.equal(labelBasename('file.ts'), 'file.ts');
	assert.equal(labelBasename(''), '');
});

test('dirname of a Windows path is its directory, not the filesystem root', () => {
	// the settings-watcher bug, stated as the assertion that would have caught it
	const settings = 'C:\\Users\\someone\\AppData\\Roaming\\0varflex\\User\\settings.json';
	assert.equal(win32.dirname(settings), 'C:\\Users\\someone\\AppData\\Roaming\\0varflex\\User');
	assert.notEqual(win32.dirname(settings), '/');
});

test('dirname of a posix path is its directory', () => {
	assert.equal(posix.dirname('/home/someone/.config/0varflex/User/settings.json'),
		'/home/someone/.config/0varflex/User');
});

test('the platform-default exports follow the host', () => {
	// whichever host runs this, the default pair must agree with that host's rules
	const expected = process.platform === 'win32' ? win32 : posix;
	assert.equal(basename('/a/b/c.ts'), expected.basename('/a/b/c.ts'));
	assert.equal(dirname('/a/b/c.ts'), expected.dirname('/a/b/c.ts'));
});

test('a path with no directory part has no parent', () => {
	assert.equal(win32.dirname('file.ts'), '.');
	assert.equal(posix.dirname('file.ts'), '.');
});

test('dirnameUri returns the real parent, not the filesystem root', () => {
	// The reason this test exists: I replaced dirnameUri's '/'-only string split with the vendored
	// dirname, then reverted the fix to check a test would catch it — and all 674 passed. The
	// function had no coverage whatsoever, which is precisely why a Windows-breaking bug lived in
	// it. The platform-dependent expectation is the point: URI.fsPath is backslash-separated on
	// win32, and the old code found no separator there at all.
	const parent = dirnameUri(URI.file('/a/b/file.ts'));
	assert.equal(parent.fsPath, URI.file(process.platform === 'win32' ? '\\a\\b' : '/a/b').fsPath);
	assert.notEqual(parent.fsPath, URI.file('/').fsPath, 'the parent of a nested file is not the root');

	// and a file directly under the root still has the root as its parent
	assert.equal(dirnameUri(URI.file('/file.ts')).fsPath, URI.file('/').fsPath);
});
