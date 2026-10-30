// src/common/platform/storage/common/storage.ts — the storage contract, ported from
// vs/platform/storage/common/storage.ts. Scopes: APPLICATION and WORKSPACE (PROFILE is a delta).
//
// Values are stored as strings (the real service behaves this way): getBoolean/getNumber parse,
// getObject JSON-parses.

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * Written once when a storage file is first created — lets migration code tell a fresh store
 * (nothing to migrate) from an existing one.
 */
export const IS_NEW_KEY = '__$__isNewStorageMarker';

/**
 * Records the StorageTarget per key so later tooling (sync, profiles, mirroring) can tell which
 * entries belong to which target when files are written or merged.
 */
export const TARGET_KEY = '__$__targetStorageMarker';

export const IStorageService = createDecorator<IStorageService>('storageService');

export enum WillSaveStateReason {
	None = 0,
	Shutdown = 1
}

export interface IWillSaveStateEvent {
	readonly reason: WillSaveStateReason;
}

export const enum StorageScope {
	APPLICATION = 1,
	WORKSPACE = 2
}

export const enum StorageTarget {
	USER = 0,
	MACHINE = 1
}

export interface IStorageValueChangeEvent {
	readonly scope: StorageScope;
	readonly key: string;
}

export interface IStorageService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeStorage: Event<IStorageValueChangeEvent>;

	/**
	 * Fired when the state is about to be saved (debounced write or shutdown) — subscribers get a
	 * last chance to add state before the flush.
	 */
	readonly onWillSaveState: Event<IWillSaveStateEvent>;

	/** hydrates the sync cache for a scope; call before first get() */
	initialize(scope: StorageScope): Promise<void>;

	// sync reads from the cache (layout passes cannot await)
	get(key: string, scope: StorageScope): string | undefined;
	getBoolean(key: string, scope: StorageScope): boolean | undefined;
	getNumber(key: string, scope: StorageScope): number | undefined;
	getObject<T>(key: string, scope: StorageScope): T | undefined;

	// async writes behind the cache: cached + debounced, flushed on quit
	store(key: string, value: string | boolean | number | null | object, scope: StorageScope): void;
	remove(key: string, scope: StorageScope): void;

	flush(reason?: WillSaveStateReason): Promise<void>;
}
