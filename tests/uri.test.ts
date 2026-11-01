// uri.ts — file-scheme exactness. All expected values were verified against the reference
// vs/base/common/uri.ts implementation with a differential run.
//
// `fsPath` is platform-dependent ON PURPOSE: uriToFsPath renders `\` separators on Windows,
// matching upstream. The `uri.path` and `toString()` forms stay POSIX everywhere, so only the
// fsPath expectations go through `fsPath()` below. Tests that assert a behaviour which only
// exists on one platform (a backslash inside a file NAME) say so explicitly.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { URI } from '../src/common/base/common/uri.js';

const isWindows = process.platform === 'win32';

/** a POSIX expectation, respelled for the platform under test */
function fsPath(posix: string): string {
	return isWindows ? posix.replace(/\//g, '\\') : posix;
}

test('parse splits scheme/authority/path and decodes percent-encoding', () => {
	const uri = URI.parse('file:///tmp/a%20b.ts');
	assert.equal(uri.scheme, 'file');
	assert.equal(uri.authority, '');
	// the URI form is POSIX on every platform
	assert.equal(uri.path, '/tmp/a b.ts');
	// the filesystem form is not
	assert.equal(uri.fsPath, fsPath('/tmp/a b.ts'));
	assert.equal(uri.toString(), 'file:///tmp/a%20b.ts');
});

test('file(): fsPath round-trips 20 tricky paths', () => {
	const paths = [
		'/Users/x/a b.ts',
		'/tmp/über/страница.md',
		'/tmp/日本語/文件.txt',
		'/tmp/a#b.ts',
		'/tmp/a?b.ts',
		'/tmp/trailing/',
		'/tmp/100%.ts',
		'/tmp/emoji 🚀/file.ts',
		'/very/deep/path/with/many/segments/a/b/c/d/e/f.ts',
		'/tmp/dots/../still/literal.ts',
		'/tmp/quotes-\'sym".ts',
		'/tmp/amp&ersand.ts',
		'/tmp/semi;colon.ts',
		'/tmp/paren(1).ts',
		'/tmp/plus+sign.ts',
		'/tmp/equals=sign.ts',
		'/tmp/at@sign.ts',
		'/',
		'/tmp/uni🚀code/é.ts',
	];
	for (const p of paths) {
		assert.equal(URI.file(p).fsPath, fsPath(p), `fsPath mismatch for ${p}`);
	}
});

test('a backslash in a file name is a separator on Windows and a character elsewhere', () => {
	// the one path from the list above whose MEANING differs per platform, so it gets its own case
	const uri = URI.file('/tmp/back\\slash-on-mac.ts');
	if (isWindows) {
		// Windows cannot have a backslash inside a name: it is a separator, so it becomes one
		assert.equal(uri.path, '/tmp/back/slash-on-mac.ts');
		assert.equal(uri.toString(), 'file:///tmp/back/slash-on-mac.ts');
		assert.equal(uri.fsPath, '\\tmp\\back\\slash-on-mac.ts');
	} else {
		// elsewhere it is a legal character and must survive, percent-encoded in the URI form
		assert.equal(uri.path, '/tmp/back\\slash-on-mac.ts');
		assert.equal(uri.toString(), 'file:///tmp/back%5Cslash-on-mac.ts');
		assert.equal(uri.fsPath, '/tmp/back\\slash-on-mac.ts');
	}
});

test('toString quotes reserved characters and round-trips through parse', () => {
	// toString is POSIX and percent-encoded on every platform
	assert.equal(URI.file('/Users/x/a b.ts').toString(), 'file:///Users/x/a%20b.ts');
	assert.equal(URI.file('/tmp/a#b.ts').toString(), 'file:///tmp/a%23b.ts');
	assert.equal(URI.file('/tmp/a?b.ts').toString(), 'file:///tmp/a%3Fb.ts');

	const uri = URI.file('/Users/x/a b#c?d.ts');
	const back = URI.parse(uri.toString());
	assert.equal(back.path, uri.path);
	assert.equal(back.fsPath, fsPath('/Users/x/a b#c?d.ts'));
});

test('windows drive letters are preserved (lower-cased, like upstream)', () => {
	assert.equal(URI.file('C:/Users/me').fsPath, isWindows ? 'c:\\Users\\me' : 'c:/Users/me');
	assert.equal(URI.file('C:/Users/me').toString(), 'file:///c%3A/Users/me');
	assert.equal(URI.parse('file:///c:/Users/me').fsPath, isWindows ? 'c:\\Users\\me' : 'c:/Users/me');
});

test('UNC paths become an authority', () => {
	const uri = URI.file('//server/share/x');
	assert.equal(uri.authority, 'server');
	assert.equal(uri.path, '/share/x');
	// the UNC filesystem form is \\server\share\x on Windows
	assert.equal(uri.fsPath, isWindows ? '\\\\server\\share\\x' : '//server/share/x');
	assert.equal(uri.toString(), 'file://server/share/x');
});

test('joinPath normalizes the joined path', () => {
	assert.equal(URI.joinPath(URI.file('/a/b'), 'c d.ts').toString(), 'file:///a/b/c%20d.ts');
	assert.equal(URI.joinPath(URI.file('/a/b'), 'c d.ts').fsPath, fsPath('/a/b/c d.ts'));
	assert.equal(URI.joinPath(URI.file('/a/b'), '../c').fsPath, fsPath('/a/c'));
	// path stays POSIX
	assert.equal(URI.joinPath(URI.file('/a/b'), 'c', 'd').path, '/a/b/c/d');
	assert.throws(() => URI.joinPath(URI.parse('foo:'), 'x'), /\[UriError\]: cannot call joinPath/);
});
