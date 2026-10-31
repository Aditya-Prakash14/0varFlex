// The CLI decision table (14): ported from the real cli.ts shape — bare paths classified by the
// file system, `--open-file`/`--open-folder` forcing the kind, unknown flags ignored. The
// single-instance forwarding hands the same argv back through `second-instance`, so this table
// is the one place the paths are interpreted.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCliArgs, CliPathKind } from '../src/common/platform/cli/common/cliArgs.js';

/** a fake file system: paths in `dirs` are folders, the rest (`known` only) are files */
function statWith(folders: string[], files: string[]) {
	const all = new Set([...folders, ...files]);
	return (candidate: string): CliPathKind => {
		if (!all.has(candidate)) {
			return 'missing';
		}
		return folders.includes(candidate) ? 'folder' : 'file';
	};
}

test('bare paths are classified by the file system', () => {
	const result = parseCliArgs(['/projects/app', '/projects/app/main.ts'], statWith(['/projects/app'], ['/projects/app/main.ts']));
	assert.deepEqual(result.paths, [
		{ path: '/projects/app', kind: 'folder' },
		{ path: '/projects/app/main.ts', kind: 'file' }
	]);
	assert.equal(result.explicitOpen, false);
});

test('a nonexistent bare path is reported as missing (the app shows a clean error)', () => {
	const result = parseCliArgs(['/nope'], statWith([], []));
	assert.deepEqual(result.paths, [{ path: '/nope', kind: 'missing' }]);
});

test('--open-folder / --open-file force the kind (the CLI script pre-classifies)', () => {
	const result = parseCliArgs(['--open-folder', '/projects/app', '--open-file', '/tmp/x.cfg'], statWith([], []));
	assert.deepEqual(result.paths, [
		{ path: '/projects/app', kind: 'folder' },
		{ path: '/tmp/x.cfg', kind: 'file' }
	]);
	assert.equal(result.explicitOpen, true);
});

test('the =value spelling works for both flags', () => {
	const result = parseCliArgs(['--open-file=/a/b.txt', '--open-folder=/a'], statWith([], []));
	assert.deepEqual(result.paths, [
		{ path: '/a/b.txt', kind: 'file' },
		{ path: '/a', kind: 'folder' }
	]);
});

test('unknown flags (Chromium/Electron switches) are ignored', () => {
	const result = parseCliArgs(['--no-sandbox', '--remote-debugging-port=9222', '/real'], statWith([], ['/real']));
	assert.deepEqual(result.paths, [{ path: '/real', kind: 'file' }]);
	assert.equal(result.explicitOpen, false);
});

test('a mix keeps the order and the forced kinds win over stat', () => {
	// /dir would stat as a folder, but --open-file forces it (the CLI decided)
	const result = parseCliArgs(['/dir', '--open-file', '/dir'], statWith(['/dir'], []));
	assert.deepEqual(result.paths, [
		{ path: '/dir', kind: 'folder' },
		{ path: '/dir', kind: 'file' }
	]);
});

test('no arguments: nothing to open', () => {
	const result = parseCliArgs([], statWith([], []));
	assert.deepEqual(result.paths, []);
	assert.equal(result.explicitOpen, false);
});
