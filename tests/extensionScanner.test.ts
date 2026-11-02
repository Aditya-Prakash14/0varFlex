// The extension scanner: validation, identity normalization, engines checks, dedupe and the
// mtime-keyed manifest cache — driven through an in-memory file system.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	checkEngineCompatibility,
	toDisplayId,
	toExtensionIdentifier,
	validateManifest, isInsideExtension, normalizeExtensionPath } from '../src/common/platform/extensions/common/extensions.js';
import {
	emptyManifestCache,
	IExtensionScanResult,
	IScannerFileSystem,
	scanExtensions
} from '../src/common/platform/extensions/common/extensionScanner.js';

class MemoryFileSystem implements IScannerFileSystem {

	/** path → directory children */
	readonly directories = new Map<string, string[]>();
	readonly files = new Map<string, string>();
	readonly mtimes = new Map<string, number>();

	addDirectory(path: string, children: string[] = []): void {
		this.directories.set(path, children);
		this.mtimes.set(path, 1);
	}

	addFile(path: string, content: string): void {
		this.files.set(path, content);
		this.mtimes.set(path, 1);
	}

	async readdir(path: string): Promise<readonly { name: string; isDirectory: boolean }[]> {
		const children = this.directories.get(path);
		if (!children) {
			throw new Error('ENOENT');
		}
		return children.map(name => ({ name, isDirectory: this.directories.has(`${path}/${name}`) }));
	}

	async readFile(path: string): Promise<string> {
		const content = this.files.get(path);
		if (content === undefined) {
			throw new Error('ENOENT');
		}
		return content;
	}

	async stat(path: string): Promise<{ mtimeMs: number }> {
		const mtimeMs = this.mtimes.get(path);
		if (mtimeMs === undefined) {
			throw new Error('ENOENT');
		}
		return { mtimeMs };
	}
}

function makeLogger(): { log: { info(m: string): void; warn(m: string): void; error(m: string): void }; infos: string[]; warns: string[]; errors: string[] } {
	const infos: string[] = [];
	const warns: string[] = [];
	const errors: string[] = [];
	return {
		infos, warns, errors,
		log: {
			info: message => infos.push(message),
			warn: message => warns.push(message),
			error: message => errors.push(message)
		}
	};
}

const VALID_MANIFEST = JSON.stringify({
	name: 'hello',
	publisher: 'Mini',
	version: '1.0.0',
	engines: { '0varflex': '^0.0.1' },
	main: './out/extension.js',
	activationEvents: ['onCommand:hello.sayHello'],
	contributes: { commands: [{ command: 'hello.sayHello', title: 'Say Hello', category: 'Hello' }] }
});

function scanRootWith(manifest: string | null, name = 'hello'): MemoryFileSystem {
	const fs = new MemoryFileSystem();
	fs.addDirectory('/builtin', [name]);
	fs.addDirectory(`/builtin/${name}`, manifest === null ? [] : ['package.json']);
	if (manifest !== null) {
		fs.addFile(`/builtin/${name}/package.json`, manifest);
	}
	return fs;
}

test('identity: lowercase identity, display casing preserved (the reference rule)', () => {
	assert.equal(toExtensionIdentifier('Mini', 'Hello'), 'mini.hello');
	assert.equal(toDisplayId('mini', 'hello'), 'Mini.Hello');
});

test('validator: the ported required-field list', () => {
	const missingName = validateManifest({ publisher: 'a', version: '1.0.0', engines: { '0varflex': '*' } });
	assert.ok(missingName.messages.some(m => m.message.includes('`name`')), JSON.stringify(missingName.messages));

	const missingEngines = validateManifest({ name: 'a', publisher: 'a', version: '1.0.0' });
	assert.ok(missingEngines.messages.some(m => m.message.includes('engines')), JSON.stringify(missingEngines.messages));

	const activationWithoutMain = validateManifest({ name: 'a', publisher: 'a', version: '1.0.0', engines: { '0varflex': '*' }, activationEvents: ['onCommand:x'] });
	assert.ok(activationWithoutMain.messages.some(m => m.message.includes('`main`')), JSON.stringify(activationWithoutMain.messages));

	const valid = validateManifest(JSON.parse(VALID_MANIFEST));
	assert.equal(valid.messages.length, 0);
	assert.ok(valid.manifest);
});

test('engines: the supported range subset', () => {
	assert.equal(checkEngineCompatibility('*', '0.0.1').compatible, true);
	assert.equal(checkEngineCompatibility('^0.0.1', '0.0.1').compatible, true);
	assert.equal(checkEngineCompatibility('^1.0.0', '0.0.1').compatible, false);
	assert.equal(checkEngineCompatibility('^0.2.0', '0.0.1').compatible, false);
	assert.equal(checkEngineCompatibility('>=0.0.1', '0.1.0').compatible, true);
	assert.equal(checkEngineCompatibility('0.0.1', '0.0.1').compatible, true);
	assert.equal(checkEngineCompatibility('garbage', '0.0.1').compatible, false);
	assert.ok(checkEngineCompatibility('^9.9.9', '0.0.1').message?.includes('not compatible'));
});

test('scanner: valid extension is found and normalized', async () => {
	const fs = scanRootWith(VALID_MANIFEST);
	const logger = makeLogger();
	const { result, cache } = await scanExtensions(fs, {
		directories: [{ path: '/builtin', kind: 'builtin' }],
		currentVersion: '0.0.1',
		log: logger.log
	});

	assert.equal(result.extensions.length, 1);
	const description = result.extensions[0].description;
	assert.equal(description.identifier, 'mini.hello');
	assert.equal(description.displayId, 'Mini.Hello');
	assert.equal(description.activationEvents.length, 1);
	assert.deepEqual(description.contributes.commands?.[0], { command: 'hello.sayHello', title: 'Say Hello', category: 'Hello' });
	assert.equal(result.errors.length, 0);
	assert.equal(Object.keys(cache.entries).length, 1);
});

test('scanner: missing package.json is skipped with a log line', async () => {
	const fs = scanRootWith(null);
	const logger = makeLogger();
	const { result } = await scanExtensions(fs, { directories: [{ path: '/builtin', kind: 'builtin' }], currentVersion: '0.0.1', log: logger.log });
	assert.equal(result.extensions.length, 0);
	assert.equal(result.errors.length, 1);
	assert.ok(logger.errors.some(message => message.includes('package.json')), JSON.stringify(logger.errors));
});

test('scanner: missing name (invalid manifest) is skipped and logged', async () => {
	const fs = scanRootWith(JSON.stringify({ publisher: 'mini', version: '1.0.0', engines: { '0varflex': '*' } }));
	const logger = makeLogger();
	const { result } = await scanExtensions(fs, { directories: [{ path: '/builtin', kind: 'builtin' }], currentVersion: '0.0.1', log: logger.log });
	assert.equal(result.extensions.length, 0);
	assert.ok(logger.errors.some(message => message.includes('`name`')), JSON.stringify(logger.errors));
});

test('scanner: incompatible engines disables (not crashes)', async () => {
	const fs = scanRootWith(JSON.stringify({
		name: 'old', publisher: 'mini', version: '1.0.0', engines: { '0varflex': '^9.0.0' }, main: './out/extension.js'
	}));
	const logger = makeLogger();
	const { result } = await scanExtensions(fs, { directories: [{ path: '/builtin', kind: 'builtin' }], currentVersion: '0.0.1', log: logger.log });
	assert.equal(result.extensions.length, 0);
	assert.ok(logger.warns.some(message => message.includes('disabled')), JSON.stringify(logger.warns));
});

test('scanner: duplicate identity — first wins, second warns', async () => {
	const fs = new MemoryFileSystem();
	fs.addDirectory('/builtin', ['one', 'two']);
	for (const folder of ['one', 'two']) {
		fs.addDirectory(`/builtin/${folder}`, ['package.json']);
		fs.addFile(`/builtin/${folder}/package.json`, JSON.stringify({ name: 'dup', publisher: 'mini', version: '1.0.0', engines: { '0varflex': '*' }, main: './out/extension.js' }));
	}
	const logger = makeLogger();
	const { result } = await scanExtensions(fs, { directories: [{ path: '/builtin', kind: 'builtin' }], currentVersion: '0.0.1', log: logger.log });
	assert.equal(result.extensions.length, 1);
	assert.ok(result.extensions[0].description.extensionLocation.endsWith('/one'), result.extensions[0].description.extensionLocation);
	assert.ok(logger.warns.some(message => message.includes('duplicate')), JSON.stringify(logger.warns));
});

test('scanner: the manifest cache skips unchanged directories (mtime keys)', async () => {
	const fs = scanRootWith(VALID_MANIFEST);
	const logger = makeLogger();
	const first = await scanExtensions(fs, { directories: [{ path: '/builtin', kind: 'builtin' }], currentVersion: '0.0.1', log: logger.log });
	assert.equal(first.result.cacheHits, 0);

	// second run with the cache: a hit, and the manifest still comes out
	const second = await scanExtensions(fs, { directories: [{ path: '/builtin', kind: 'builtin' }], currentVersion: '0.0.1', cache: first.cache, log: logger.log });
	assert.equal(second.result.cacheHits, 1);
	assert.equal(second.result.extensions.length, 1);

	// the directory changed (new mtime): no hit, re-parse
	fs.mtimes.set('/builtin/hello', 99);
	const third = await scanExtensions(fs, { directories: [{ path: '/builtin', kind: 'builtin' }], currentVersion: '0.0.1', cache: second.cache, log: logger.log });
	assert.equal(third.result.cacheHits, 0);
});

test('scanner: real VS Code extensions fail gracefully (engines.vscode only)', async () => {
	// a manifest shaped like a real workbench extension: it parses, but engines.0varflex is missing
	const realish = JSON.stringify({
		name: 'git', publisher: 'vscode', version: '1.0.0', engines: { vscode: '^1.80.0' }, main: './out/extension.js'
	});
	const fs = scanRootWith(realish, 'git');
	const logger = makeLogger();
	const { result } = await scanExtensions(fs, { directories: [{ path: '/builtin', kind: 'builtin' }], currentVersion: '0.0.1', log: logger.log });
	assert.equal(result.extensions.length, 0, 'not activated — the API gaps would kill it anyway');
	assert.ok(result.errors.length > 0);
});

test('scanner: missing directories are not errors (no user extensions yet)', async () => {
	const fs = new MemoryFileSystem();
	const logger = makeLogger();
	const result: { result: IExtensionScanResult } = await scanExtensions(fs, { directories: [{ path: '/user', kind: 'user' }], currentVersion: '0.0.1', cache: emptyManifestCache(), log: logger.log });
	assert.equal(result.result.extensions.length, 0);
	assert.equal(result.result.errors.length, 0);
});

// ---- extensionLocation ↔ file-path matching
//
// This is the comparison the `require('vscode')` shim makes to decide which extension's api a
// file gets. It was broken on Windows and killed EVERY extension at runtime: the scanner joins
// paths with '/' while Node reports '\', so the two strings never matched and each extension
// failed with "Cannot find module 'vscode'". Found by running the app; pinned here.

test('isInsideExtension matches a file inside the extension directory', () => {
	assert.equal(isInsideExtension('/ext/git-lite', '/ext/git-lite/out/extension.js'), true);
	assert.equal(isInsideExtension('/ext/git-lite', '/ext/git-lite'), true, 'the directory itself counts');
});

test('isInsideExtension matches across MIXED separators (the bug)', () => {
	// exactly the shapes the app produced: scanner location vs Node's filename
	assert.equal(
		isInsideExtension('C:\\repo\\extensions/git-lite', 'C:\\repo\\extensions\\git-lite\\out\\extension.js'),
		true,
		'a mixed-separator location must still match the real file path'
	);
	assert.equal(isInsideExtension('/ext/a', '\\ext\\a\\out\\x.js'), true);
});

test('isInsideExtension does not match a sibling with a shared prefix', () => {
	// `.../git-lite` must not claim `.../git-lite-extra`'s files
	assert.equal(isInsideExtension('/ext/git-lite', '/ext/git-lite-extra/out/extension.js'), false);
	assert.equal(isInsideExtension('/ext/a', '/ext/ab/out/x.js'), false);
});

test('isInsideExtension rejects a file outside the extension', () => {
	assert.equal(isInsideExtension('/ext/a', '/ext/b/out/x.js'), false);
	assert.equal(isInsideExtension('/ext/a', '/elsewhere/x.js'), false);
	assert.equal(isInsideExtension('/ext/a', ''), false);
});

test('normalizeExtensionPath unifies separators', () => {
	assert.equal(normalizeExtensionPath('a\\b\\c'), 'a/b/c');
	assert.equal(normalizeExtensionPath('a/b/c'), 'a/b/c');
});

test('on Windows the comparison is case-insensitive, because the filesystem is', () => {
	// the drive letter in particular arrives in either case depending on who produced the path
	const sameFile = isInsideExtension('C:\\Repo\\Extensions/Git-Lite', 'c:\\repo\\extensions\\git-lite\\out\\extension.js');
	assert.equal(sameFile, process.platform === 'win32');
});
