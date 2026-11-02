// src/common/platform/storage/common/storageService.ts — the renderer side: a sync cache over an
// async channel. Reads are synchronous because consumers (the layout pass!) cannot await;
// writes update the cache immediately, are debounced, and are flushed through the channel.
//
// This split (sync reads, async writes) is the real architecture — state the reason in the quiz.

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import type { ILogService } from '../../log/common/log.js';
import { IChannel } from '../../../base/parts/ipc/ipc.js';
import { IStorageService, IStorageValueChangeEvent, IWillSaveStateEvent, StorageScope, WillSaveStateReason } from './storage.js';

export class BrowserStorageService extends Disposable implements IStorageService {

	declare readonly _serviceBrand: undefined;

	private readonly _cache = new Map<StorageScope, Map<string, string>>();
	private readonly _dirty = new Map<StorageScope, Set<string>>();
	private _writeTimer: ReturnType<typeof setTimeout> | undefined;

	private readonly _onDidChangeStorage = this._register(new Emitter<IStorageValueChangeEvent>());
	readonly onDidChangeStorage: Event<IStorageValueChangeEvent> = this._onDidChangeStorage.event;

	private readonly _onWillSaveState = this._register(new Emitter<IWillSaveStateEvent>());
	readonly onWillSaveState: Event<IWillSaveStateEvent> = this._onWillSaveState.event;

	constructor(
		private readonly _channel: IChannel,
		private readonly _logService: ILogService,
		private readonly _writeDelayMs: number = 500
	) {
		super();
	}

	async initialize(scope: StorageScope): Promise<void> {
		try {
			const values = await this._channel.call<{ [key: string]: string }>('initialize', [scope]);
			this._cache.set(scope, new Map(Object.entries(values)));
		} catch (error) {
			this._logService.warn(`storage could not be initialized: ${(error as Error).message}`);
			this._cache.set(scope, new Map());
		}
	}

	get(key: string, scope: StorageScope): string | undefined {
		return this._cache.get(scope)?.get(key);
	}

	getBoolean(key: string, scope: StorageScope): boolean | undefined {
		const value = this.get(key, scope);
		return value === 'true' ? true : value === 'false' ? false : undefined;
	}

	getNumber(key: string, scope: StorageScope): number | undefined {
		const value = this.get(key, scope);
		if (value === undefined) {
			return undefined;
		}
		const parsed = parseInt(value, 10);
		return Number.isNaN(parsed) ? undefined : parsed;
	}

	getObject<T>(key: string, scope: StorageScope): T | undefined {
		const value = this.get(key, scope);
		if (value === undefined) {
			return undefined;
		}
		try {
			return JSON.parse(value) as T;
		} catch {
			this._logService.warn(`storage entry '${key}' is not valid JSON`);
			return undefined;
		}
	}

	store(key: string, value: string | boolean | number | null | object, scope: StorageScope): void {
		const stringValue = value === null ? 'null' : typeof value === 'object' ? JSON.stringify(value) : String(value);
		if (this.get(key, scope) === stringValue) {
			return;
		}
		let cache = this._cache.get(scope);
		if (!cache) {
			cache = new Map();
			this._cache.set(scope, cache);
		}
		cache.set(key, stringValue);
		this._markDirty(key, scope);
		this._onDidChangeStorage.fire({ scope, key });
		this._scheduleWrite();
	}

	remove(key: string, scope: StorageScope): void {
		if (this._cache.get(scope)?.delete(key)) {
			this._markDirty(key, scope);
			this._onDidChangeStorage.fire({ scope, key });
			this._scheduleWrite();
		}
	}

	async flush(reason: WillSaveStateReason = WillSaveStateReason.None): Promise<void> {
		if (this._writeTimer !== undefined) {
			clearTimeout(this._writeTimer);
			this._writeTimer = undefined;
		}

		// subscribers get a last chance to add state before the flush
		this._onWillSaveState.fire({ reason });

		for (const [scope, keys] of [...this._dirty]) {
			if (keys.size === 0) {
				this._dirty.delete(scope);
				continue;
			}
			const updates: [string, string | null][] = [];
			for (const key of keys) {
				updates.push([key, this._cache.get(scope)?.get(key) ?? null]);
			}
			// cleared BEFORE the write on purpose, so a `set` arriving during the await lands in a
			// fresh set instead of being swallowed by this flush
			this._dirty.delete(scope);
			try {
				await this._channel.call('flushUpdates', [scope, updates]);
			} catch (error) {
				// put the keys back: they were already cleared, so without this the state is
				// dropped for good and no later flush would ever retry it. Not rescheduled here —
				// a permanently broken channel would turn that into an endless retry loop — so
				// these ride along with the next write or the shutdown snapshot.
				for (const [key] of updates) {
					this._markDirty(key, scope);
				}
				this._logService.error(`storage flush failed: ${(error as Error).message}`);
			}
		}

		// on shutdown write complete snapshots: guarantees the files exist (and are complete)
		// even if nothing changed this session — a deleted storage.json is recreated
		if (reason === WillSaveStateReason.Shutdown) {
			for (const [scope, cache] of this._cache) {
				try {
					await this._channel.call('flushUpdates', [scope, [...cache.entries()]]);
				} catch (error) {
					this._logService.error(`storage snapshot failed: ${(error as Error).message}`);
				}
			}
		}
	}

	private _markDirty(key: string, scope: StorageScope): void {
		let keys = this._dirty.get(scope);
		if (!keys) {
			keys = new Set();
			this._dirty.set(scope, keys);
		}
		keys.add(key);
	}

	private _scheduleWrite(): void {
		if (this._writeTimer !== undefined) {
			clearTimeout(this._writeTimer);
		}
		this._writeTimer = setTimeout(() => {
			this._writeTimer = undefined;
			void this.flush();
		}, this._writeDelayMs);
	}
}
