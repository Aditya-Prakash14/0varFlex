// The watcher pipeline's pure logic: coalesceEvents (the EventCoalescer port) and the
// stale-delete guard — plus the FileWatcherService over a fake host with injected timers.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { URI } from '../src/common/base/common/uri.js';
import { FileChangeType, IFileChange } from '../src/common/platform/files/common/files.js';
import { coalesceEvents, FileWatcherService, StaleDeleteGuard, STALE_DELETE_WINDOW } from '../src/common/platform/files/common/watcher.js';

function change(path: string, type: FileChangeType): IFileChange {
	return { resource: URI.file(path), type };
}

function types(changes: IFileChange[]): string[] {
	return changes.map(c => `${c.resource.fsPath}:${c.type === FileChangeType.ADDED ? 'A' : c.type === FileChangeType.DELETED ? 'D' : 'U'}`);
}

test('coalesce: add then delete in one batch cancels out', () => {
	assert.deepEqual(coalesceEvents([change('/a/x', FileChangeType.ADDED), change('/a/x', FileChangeType.DELETED)]), []);
});

test('coalesce: delete then add flattens into UPDATED', () => {
	const result = coalesceEvents([change('/a/x', FileChangeType.DELETED), change('/a/x', FileChangeType.ADDED)]);
	assert.deepEqual(types(result), ['/a/x:U']);
});

test('coalesce: add then update keeps the ADD (the file is new once)', () => {
	const result = coalesceEvents([change('/a/x', FileChangeType.ADDED), change('/a/x', FileChangeType.UPDATED)]);
	assert.deepEqual(types(result), ['/a/x:A']);
});

test('coalesce: case-only rename keeps both ADD and DELETE for the different names', () => {
	const result = coalesceEvents([change('/a/x.ts', FileChangeType.ADDED), change('/a/X.ts', FileChangeType.DELETED)]);
	assert.deepEqual(types(result).sort(), ['/a/X.ts:D', '/a/x.ts:A']);
});

test('coalesce: deletes collapse up the tree (a deleted folder suppresses child deletes)', () => {
	const result = coalesceEvents([
		change('/a/dir', FileChangeType.DELETED),
		change('/a/dir/x', FileChangeType.DELETED),
		change('/a/dir/y', FileChangeType.DELETED),
		change('/a/other', FileChangeType.DELETED)
	]);
	assert.deepEqual(types(result).sort(), ['/a/dir:D', '/a/other:D']);
});

test('stale-delete guard: a delete right after a create is the rename race, not a delete', () => {
	const guard = new StaleDeleteGuard();
	const first = guard.filter([change('/a/x', FileChangeType.ADDED)], 1000);
	assert.deepEqual(types(first), ['/a/x:A']);

	// the delete arrives within the window: dropped
	assert.deepEqual(guard.filter([change('/a/x', FileChangeType.DELETED)], 1000 + STALE_DELETE_WINDOW - 1), []);

	// long after: a real delete goes through
	const late = guard.filter([change('/a/x', FileChangeType.DELETED)], 1000 + STALE_DELETE_WINDOW + 1);
	assert.deepEqual(types(late), ['/a/x:D']);
});

test('FileWatcherService: raw events coalesce into ONE batch on the timer', () => {
	const batches: IFileChange[][] = [];
	let capturedTimer: (() => void) | undefined;
	const exists = new Set<string>(['/w/kept.txt']);

	const service = new FileWatcherService(
		{
			watch: (_root, _recursive, onRawEvent) => {
				// immediately emit a storm: three updates and a create/delete pair
				onRawEvent('/w/a.txt', FileChangeType.UPDATED);
				onRawEvent('/w/a.txt', FileChangeType.UPDATED);
				onRawEvent('/w/b.txt', 'unknown'); // exists? no → DELETED
				onRawEvent('/w/kept.txt', 'unknown'); // exists → UPDATED
				return { dispose: () => { /* fake */ } };
			}
		},
		changes => batches.push(changes),
		path => exists.has(path),
		() => 0,
		(callback, _ms) => {
			capturedTimer = callback;
			return 1;
		}
	);

	service.watch({ resource: URI.file('/w'), recursive: true });
	assert.equal(batches.length, 0, 'nothing fires before the coalescing window');
	capturedTimer?.();
	assert.equal(batches.length, 1, 'one batch per window, not one per event');
	assert.deepEqual(types(batches[0]).sort(), ['/w/a.txt:U', '/w/b.txt:D', '/w/kept.txt:U']);
	service.dispose();
});

test('FileWatcherService: excludes filter raw events', () => {
	const batches: IFileChange[][] = [];
	let capturedTimer: (() => void) | undefined;
	const service = new FileWatcherService(
		{
			watch: (_root, _recursive, onRawEvent) => {
				onRawEvent('/w/keep.txt', FileChangeType.UPDATED);
				onRawEvent('/w/node_modules/skip.txt', FileChangeType.UPDATED);
				return { dispose: () => { /* fake */ } };
			}
		},
		changes => batches.push(changes),
		() => true,
		() => 0,
		callback => {
			capturedTimer = callback;
			return 1;
		}
	);
	service.watch({ resource: URI.file('/w'), recursive: true, excludes: ['/node_modules'] });
	capturedTimer?.();
	assert.deepEqual(batches.flat().map(c => c.resource.fsPath), ['/w/keep.txt']);
	service.dispose();
});
