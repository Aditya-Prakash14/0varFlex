// tests/diskFileWrite.test.ts — writing a file whose directory does not exist yet.
//
// This is a regression test for a real bug: the settings file lives in a directory nothing else
// creates, so on a fresh profile the FIRST attempt to change a setting failed with ENOENT. It was
// invisible because the only caller discarded the rejection with `void`. The reference's
// FileService mkdirp's the parent before writing; so does ours now.
//
// Runs against the real disk in a temp directory, because the bug was in the real provider's
// interaction with the filesystem and an in-memory harness would have had to reproduce the fault
// to catch it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { URI } from '../src/common/base/common/uri.js';
import { DiskFileSystemProvider } from '../src/main/files/diskFileSystemProvider.js';

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(path.join(tmpdir(), '0varflex-write-'));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test('writeFile creates a missing parent directory', async () => {
	await withTempDir(async root => {
		const provider = new DiskFileSystemProvider();
		// `User` is exactly the settings case: one level that nothing else has created
		const target = path.join(root, 'User', 'settings.json');
		await provider.writeFile(URI.file(target), '{\n\t"a": 1\n}', {});
		assert.equal(await readFile(target, 'utf8'), '{\n\t"a": 1\n}');
	});
});

test('an atomic write creates a missing parent directory too', async () => {
	await withTempDir(async root => {
		const provider = new DiskFileSystemProvider();
		const target = path.join(root, 'User', 'settings.json');
		await provider.writeFile(URI.file(target), '{}', { atomic: true });
		assert.equal(await readFile(target, 'utf8'), '{}');
	});
});

test('an atomic write leaves no temp file behind', async () => {
	await withTempDir(async root => {
		const provider = new DiskFileSystemProvider();
		const target = path.join(root, 'nested', 'deep', 'settings.json');
		await provider.writeFile(URI.file(target), '{}', { atomic: true });
		await assert.rejects(() => stat(`${target}.tmp-write`), /ENOENT/);
	});
});

test('writeFile creates several missing levels at once', async () => {
	await withTempDir(async root => {
		const provider = new DiskFileSystemProvider();
		const target = path.join(root, 'a', 'b', 'c', 'file.txt');
		await provider.writeFile(URI.file(target), 'hi', {});
		assert.equal(await readFile(target, 'utf8'), 'hi');
	});
});

test('overwrite: false still refuses an existing file', async () => {
	await withTempDir(async root => {
		const provider = new DiskFileSystemProvider();
		const target = path.join(root, 'User', 'settings.json');
		await provider.writeFile(URI.file(target), 'first', {});
		// creating the directory must not have weakened the existence check
		await assert.rejects(() => provider.writeFile(URI.file(target), 'second', { overwrite: false }));
		assert.equal(await readFile(target, 'utf8'), 'first');
	});
});

test('a second write to the same directory still works', async () => {
	await withTempDir(async root => {
		const provider = new DiskFileSystemProvider();
		const target = path.join(root, 'User', 'settings.json');
		await provider.writeFile(URI.file(target), 'one', { atomic: true });
		await provider.writeFile(URI.file(target), 'two', { atomic: true });
		assert.equal(await readFile(target, 'utf8'), 'two');
	});
});
