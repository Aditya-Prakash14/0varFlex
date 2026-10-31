// src/common/platform/storage/common/storageIpc.ts — MAIN-side storage: one JSON file per scope.
// The renderer talks to this through the channel machinery of exercise 02 (storage lives in main
// so a crashing renderer cannot lose it — the pattern from vs/platform/storage/common/storageIpc.ts).
//
// File layout (mirroring real VS Code):
//   APPLICATION: <userData>/storage.json
//   WORKSPACE:   <userData>/workspaceStorage/<hash>/state.json
//
// shortcut: single JSON files, no SQLite backend, no migration framework (see the reference's
// storageIpc.ts for what the real one migrates — glance, don't port).

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { IServerChannel } from '../../../base/parts/ipc/ipc.js';
import { IS_NEW_KEY, StorageScope, StorageTarget, TARGET_KEY } from './storage.js';

export class StorageMainService implements IServerChannel<unknown> {

	private readonly _entries = new Map<StorageScope, Map<string, string>>();
	private readonly _files = new Map<StorageScope, string>();

	constructor(userDataPath: string) {
		this._files.set(StorageScope.APPLICATION, path.join(userDataPath, 'storage.json'));
		// a workspace identity would hash the folder uri; there are no folders until 10
		const hash = createHash('sha256').update('0varflex-workspace').digest('hex');
		this._files.set(StorageScope.WORKSPACE, path.join(userDataPath, 'workspaceStorage', hash, 'state.json'));
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown[]): Promise<T> {
		const args = arg ?? [];
		switch (command) {
			case 'initialize': {
				const scope = args[0] as StorageScope;
				const entries = await this._load(scope);
				return Object.fromEntries(entries) as T;
			}
			case 'flushUpdates': {
				const scope = args[0] as StorageScope;
				const updates = (args[1] ?? []) as [string, string | null][];
				const entries = await this._load(scope);
				for (const [key, value] of updates) {
					if (value === null) {
						entries.delete(key);
					} else {
						entries.set(key, value);
					}
				}
				await this._write(scope);
				return undefined as T;
			}
		}
		throw new Error(`Unknown channel command: ${command}`);
	}

	listen<T>(): never {
		throw new Error('storage channel does not support events');
	}

	/** test/dev access: the file path of a scope */
	getFilePath(scope: StorageScope): string {
		return this._files.get(scope)!;
	}

	private async _load(scope: StorageScope): Promise<Map<string, string>> {
		let entries = this._entries.get(scope);
		if (entries) {
			return entries;
		}

		entries = new Map();
		try {
			const text = await fs.readFile(this._files.get(scope)!, 'utf8');
			const parsed = JSON.parse(text) as { [key: string]: unknown };
			for (const key of Object.keys(parsed)) {
				if (key !== IS_NEW_KEY && key !== TARGET_KEY) {
					entries.set(key, String(parsed[key]));
				}
			}
		} catch {
			// missing or corrupt file: start empty (the app recreates it on the next flush)
		}

		this._entries.set(scope, entries);
		return entries;
	}

	private async _write(scope: StorageScope): Promise<void> {
		const file = this._files.get(scope)!;
		const entries = this._entries.get(scope)!;

		const out: { [key: string]: unknown } = {};
		const target: { [key: string]: StorageTarget } = {};
		for (const [key, value] of entries) {
			out[key] = value;
			target[key] = StorageTarget.USER;
		}
		out[TARGET_KEY] = target;
		out[IS_NEW_KEY] = 'true';

		await fs.mkdir(path.dirname(file), { recursive: true });
		const tempFile = `${file}.tmp`;
		await fs.writeFile(tempFile, JSON.stringify(out, null, '\t'), 'utf8');
		await fs.rename(tempFile, file);
	}
}
