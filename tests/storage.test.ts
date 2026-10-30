// Storage: sync cache over an async channel, debounced writes, flush reasons, marker keys,
// deleted-file recovery — driven end-to-end through the real main-side file store.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Event } from '../src/common/base/common/event.js';
import { IChannel } from '../src/common/platform/../base/parts/ipc/ipc.js';
import type { ILogService } from '../src/common/platform/log/common/log.js';
import { IS_NEW_KEY, StorageScope, StorageTarget, TARGET_KEY, WillSaveStateReason } from '../src/common/platform/storage/common/storage.js';
import { StorageMainService } from '../src/common/platform/storage/common/storageIpc.js';
import { BrowserStorageService } from '../src/common/platform/storage/common/storageService.js';

function makeLogService(): ILogService {
	return {
		_serviceBrand: undefined,
		onDidLog: Event.None,
		trace: () => { },
		info: () => { },
		warn: () => { },
		error: () => { }
	};
}

test('storage: sync reads, debounced writes, markers, flush and recovery', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'mini-storage-'));

	try {
		const main = new StorageMainService(dir);
		let flushCalls = 0;
		const channel = {
			call: <T>(command: string, arg?: unknown[]): Promise<T> => {
				if (command === 'flushUpdates') {
					flushCalls++;
				}
				return main.call(undefined, command, arg) as Promise<T>;
			},
			listen: (() => { throw new Error('no events'); }) as unknown as IChannel['listen']
		};

		const storage = new BrowserStorageService(channel, makeLogService(), 30);
		await storage.initialize(StorageScope.APPLICATION);

		// sync cache: reads before any store
		assert.equal(storage.get('missing', StorageScope.APPLICATION), undefined);
		assert.equal(storage.getBoolean('missing', StorageScope.APPLICATION), undefined);

		// 5 rapid stores → one debounced write
		storage.store('key1', 'v1', StorageScope.APPLICATION);
		storage.store('key2', 'v2', StorageScope.APPLICATION);
		storage.store('key3', 'v3', StorageScope.APPLICATION);
		storage.store('key4', 'v4', StorageScope.APPLICATION);
		storage.store('key5', 'v5', StorageScope.APPLICATION);
		assert.equal(storage.get('key1', StorageScope.APPLICATION), 'v1'); // written to cache synchronously
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.equal(flushCalls, 1, 'five rapid stores must coalesce into one write');

		// the file exists with the real shape: values + marker keys
		const raw = JSON.parse(await readFile(main.getFilePath(StorageScope.APPLICATION), 'utf8'));
		assert.equal(raw['key1'], 'v1');
		assert.equal(raw[IS_NEW_KEY], 'true');
		assert.equal(typeof raw[TARGET_KEY], 'object');
		assert.equal(raw[TARGET_KEY]['key1'], StorageTarget.USER);

		// typed getters parse the string values
		storage.store('flag', true, StorageScope.APPLICATION);
		storage.store('count', 42, StorageScope.APPLICATION);
		storage.store('shape', { a: 1 }, StorageScope.APPLICATION);
		assert.equal(storage.getBoolean('flag', StorageScope.APPLICATION), true);
		assert.equal(storage.getNumber('count', StorageScope.APPLICATION), 42);
		assert.deepEqual(storage.getObject('shape', StorageScope.APPLICATION), { a: 1 });

		// change events carry the scope and key
		const changes: string[] = [];
		storage.onDidChangeStorage(event => changes.push(`${event.scope}:${event.key}`));
		storage.store('watched', 'x', StorageScope.APPLICATION);
		storage.remove('watched', StorageScope.APPLICATION);
		assert.deepEqual(changes, [`${StorageScope.APPLICATION}:watched`, `${StorageScope.APPLICATION}:watched`]);

		// removal lands on disk
		storage.remove('key1', StorageScope.APPLICATION);
		await storage.flush();
		const afterRemove = JSON.parse(await readFile(main.getFilePath(StorageScope.APPLICATION), 'utf8'));
		assert.equal(afterRemove['key1'], undefined);

		// flush reasons: onWillSaveState fires with the given reason before writing
		const reasons: WillSaveStateReason[] = [];
		storage.onWillSaveState(event => reasons.push(event.reason));
		storage.store('final', 'y', StorageScope.APPLICATION);
		await storage.flush(WillSaveStateReason.Shutdown);
		assert.deepEqual(reasons, [WillSaveStateReason.Shutdown]);
		assert.equal(JSON.parse(await readFile(main.getFilePath(StorageScope.APPLICATION), 'utf8'))['final'], 'y');

		// deleted file → fresh empty state → recreated on the next flush
		await rm(main.getFilePath(StorageScope.APPLICATION));
		const freshMain = new StorageMainService(dir);
		freshMain.call(undefined, 'initialize', [StorageScope.APPLICATION]);
		const fresh = new BrowserStorageService({
			call: <T>(command: string, arg?: unknown[]) => freshMain.call(undefined, command, arg) as Promise<T>,
			listen: (() => { throw new Error('no events'); }) as unknown as IChannel['listen']
		}, makeLogService(), 30);
		await fresh.initialize(StorageScope.APPLICATION);
		assert.equal(fresh.get('key2', StorageScope.APPLICATION), undefined, 'deleted storage starts empty');
		fresh.store('recreated', 'yes', StorageScope.APPLICATION);
		await fresh.flush();
		assert.equal(JSON.parse(await readFile(freshMain.getFilePath(StorageScope.APPLICATION), 'utf8'))['recreated'], 'yes');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
