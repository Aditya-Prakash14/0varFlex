// src/main/files/fileWatcher.ts — the main-process watch host: one `fs.watch` per request.
//
// The reference's universal watcher spawns a helper with native recursion (@parcel/watcher) and
// falls back to a non-recursive walker on Linux; here recursion is node's own
// (`fs.watch(root, { recursive: true })` — macOS/Windows only, documented delta) and raw events
// are classified by existence before entering the shared coalescing pipeline (common/watcher.ts).

import * as fs from 'node:fs';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { FileChangeType } from '../../common/platform/files/common/files.js';
import { FileWatcherService, IWatcherHost } from '../../common/platform/files/common/watcher.js';

export class NodeWatcherHost implements IWatcherHost {

	private readonly _log: (message: string) => void;

	constructor(log: (message: string) => void = () => { /* silent */ }) {
		this._log = log;
	}

	watch(rootPath: string, recursive: boolean, onRawEvent: (path: string, type: FileChangeType | 'unknown') => void): { dispose(): void } {
		try {
			// macOS: /var is a symlink to /private/var, and recursive fs.watch reports events with
			// the RESOLVED prefix — rewrite them back to the root the caller asked for, or every
			// path comparison downstream misses
			const watchedRoot = rootPath.replace(/\/$/, '');
			let realRoot = watchedRoot;
			try {
				realRoot = fs.realpathSync(watchedRoot).replace(/\/$/, '');
			} catch {
				// keep the requested path; fs.watch below will fail and log
			}
			// watching a FILE works too (fs.watch on a path): the config/keybindings watchers
			// watch their single file, the explorer watches its folder tree recursively
			const watcher = fs.watch(realRoot, { recursive: recursive && this._isDirectory(realRoot) }, (eventType, filename) => {
				const name = filename?.toString();
				if (!name) {
					return;
				}
				const fullPath = path.join(realRoot, name);
				const normalizedPath = fullPath.startsWith(realRoot)
					? watchedRoot + fullPath.substring(realRoot.length)
					: fullPath;
				if (eventType === 'change') {
					onRawEvent(normalizedPath, FileChangeType.UPDATED);
				} else {
					// 'rename' means created, deleted or moved somewhere: classify by existence
					onRawEvent(normalizedPath, 'unknown');
				}
			});
			watcher.on('error', error => {
				this._log(`watcher error for ${rootPath}: ${(error as Error).message}`);
			});
			return { dispose: () => watcher.close() };
		} catch (error) {
			// the watched root may not exist yet (e.g. a settings file not created): no-op watcher
			this._log(`cannot watch ${rootPath}: ${(error as Error).message}`);
			return { dispose: () => { /* nothing was started */ } };
		}
	}

	private _isDirectory(fsPath: string): boolean {
		try {
			return fs.statSync(fsPath).isDirectory();
		} catch {
			return true; // let fs.watch try (and fail with a logged note) if it is gone
		}
	}
}

/** the main-process watcher stack: host + coalescing service, wired into the FileService */
export function createFileWatcher(onChanges: (changes: import('../../common/platform/files/common/files.js').IFileChange[]) => void, log?: (message: string) => void): FileWatcherService {
	return new FileWatcherService(
		new NodeWatcherHost(log),
		onChanges,
		fsPath => existsSync(fsPath),
		() => Date.now(),
		(callback, ms) => setTimeout(callback, ms)
	);
}
