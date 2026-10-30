// uri.ts — file-scheme exactness. All expected values were verified against the reference
// vs/base/common/uri.ts implementation with a differential run.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { URI } from '../src/common/base/common/uri.js';

test('parse splits scheme/authority/path and decodes percent-encoding', () => {
	const uri = URI.parse('file:///tmp/a%20b.ts');
	assert.equal(uri.scheme, 'file');
	assert.equal(uri.authority, '');
	assert.equal(uri.path, '/tmp/a b.ts');
	assert.equal(uri.fsPath, '/tmp/a b.ts');
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
		'/tmp/back\\slash-on-mac.ts',
		'/',
		'/tmp/uni🚀code/é.ts',
	];
	for (const p of paths) {
		assert.equal(URI.file(p).fsPath, p, `fsPath mismatch for ${p}`);
	}
});

test('toString quotes reserved characters and round-trips through parse', () => {
	assert.equal(URI.file('/Users/x/a b.ts').toString(), 'file:///Users/x/a%20b.ts');
	assert.equal(URI.file('/tmp/a#b.ts').toString(), 'file:///tmp/a%23b.ts');
	assert.equal(URI.file('/tmp/a?b.ts').toString(), 'file:///tmp/a%3Fb.ts');
	assert.equal(URI.file('/tmp/back\\slash-on-mac.ts').toString(), 'file:///tmp/back%5Cslash-on-mac.ts');

	const uri = URI.file('/Users/x/a b#c?d.ts');
	const back = URI.parse(uri.toString());
	assert.equal(back.path, uri.path);
	assert.equal(back.fsPath, '/Users/x/a b#c?d.ts');
});

test('windows drive letters are preserved (lower-cased, like upstream)', () => {
	assert.equal(URI.file('C:/Users/me').fsPath, 'c:/Users/me');
	assert.equal(URI.file('C:/Users/me').toString(), 'file:///c%3A/Users/me');
	assert.equal(URI.parse('file:///c:/Users/me').fsPath, 'c:/Users/me');
});

test('UNC paths become an authority', () => {
	const uri = URI.file('//server/share/x');
	assert.equal(uri.authority, 'server');
	assert.equal(uri.path, '/share/x');
	assert.equal(uri.fsPath, '//server/share/x');
	assert.equal(uri.toString(), 'file://server/share/x');
});

test('joinPath normalizes the joined path', () => {
	assert.equal(URI.joinPath(URI.file('/a/b'), 'c d.ts').toString(), 'file:///a/b/c%20d.ts');
	assert.equal(URI.joinPath(URI.file('/a/b'), 'c d.ts').fsPath, '/a/b/c d.ts');
	assert.equal(URI.joinPath(URI.file('/a/b'), '../c').fsPath, '/a/c');
	assert.equal(URI.joinPath(URI.file('/a/b'), 'c', 'd').path, '/a/b/c/d');
	assert.throws(() => URI.joinPath(URI.parse('foo:'), 'x'), /\[UriError\]: cannot call joinPath/);
});
