// src/common/platform/files/common/watcher.ts — the watcher pipeline's pure logic, ported from
// vs/platform/files/common/watcher.ts: coalesceEvents (the EventCoalescer, verbatim behavior)
// and the happens-before guard.
//
// The real watcher correlates watch requests with the requests that caused the change
// (isWatchRequestWithCorrelation) because create-then-rename races produce out-of-order events
// between different watchers. Ours is single-watcher: shortcut: no correlation ids — a DELETE
// that arrives within STALE_DELETE_WINDOW after an ADD/UPDATED for the same path is dropped as
// a stale race artifact (the classic save-as dance).

import { FileChangeType, IFileChange } from './files.js';
import { URI } from '../../../base/common/uri.js';

/** how long after an add/update a delete for the same path is treated as a stale race artifact */
export const STALE_DELETE_WINDOW = 200;
/** the coalescing window (real: the watcher's own coalescing delay) */
export const COALESCE_WINDOW = 100;

function pathsEqual(a: string, b: string): boolean {
	// macOS/Windows volumes are case-insensitive: normalize (reference does the same on darwin)
	return a.toLowerCase() === b.toLowerCase();
}

/**
 * `fsPath` uses the platform's separator, so comparing with a hardcoded `/` meant this returned
 * false for every path on Windows — a deleted folder then failed to suppress its children's
 * DELETE events, and consumers saw N events instead of one.
 */
function isParent(parent: string, child: string): boolean {
	const normalizedParent = parent.replace(/\\/g, '/').replace(/\/+$/, '');
	const normalizedChild = child.replace(/\\/g, '/');
	return normalizedChild.startsWith(normalizedParent + '/');
}

/**
 * delta: the real watcher parses glob patterns (`parseWatcherPatterns`); ours treats each
 * exclude as a path segment name (`node_modules`, `.git`) — enough for the acceptance's
 * excludes and honest about the simplification.
 */
function matchesExclude(fsPath: string, exclude: string): boolean {
	const segment = exclude.replace(/^\*+|\*+$/g, '').replace(/^\/+|\/+$/g, '');
	if (!segment) {
		return false;
	}
	// split on BOTH separators: on Windows `\w\node_modules\x` has no `/`, so splitting on `/`
	// alone produced a single segment and every exclude was silently ignored
	return fsPath.split(/[\\/]/).includes(segment);
}

// ---- EventCoalescer (ported from watcher.ts)

class EventCoalescer {

	private readonly coalesced = new Set<IFileChange>();
	private readonly mapPathToChange = new Map<string, IFileChange>();

	processEvent(event: IFileChange): void {
		const key = event.resource.fsPath.toLowerCase();
		const existingEvent = this.mapPathToChange.get(key);
		let keepEvent = false;

		if (existingEvent) {
			const currentChangeType = existingEvent.type;
			const newChangeType = event.type;

			// track renames to a different case by keeping both ADD and DELETE
			if (existingEvent.resource.fsPath !== event.resource.fsPath && (event.type === FileChangeType.DELETED || event.type === FileChangeType.ADDED)) {
				keepEvent = true;
			}
			// ignore ADD followed by DELETE in one go
			else if (currentChangeType === FileChangeType.ADDED && newChangeType === FileChangeType.DELETED) {
				this.mapPathToChange.delete(key);
				this.coalesced.delete(existingEvent);
			}
			// flatten DELETE followed by ADD into UPDATED
			else if (currentChangeType === FileChangeType.DELETED && newChangeType === FileChangeType.ADDED) {
				(existingEvent as { type: FileChangeType }).type = FileChangeType.UPDATED;
			}
			// ADD + UPDATED: keep the ADD
			else if (currentChangeType === FileChangeType.ADDED && newChangeType === FileChangeType.UPDATED) {
				// nothing to do
			}
			// otherwise take the new type
			else {
				(existingEvent as { type: FileChangeType }).type = newChangeType;
			}
		} else {
			keepEvent = true;
		}

		if (keepEvent) {
			this.coalesced.add(event);
			this.mapPathToChange.set(key, event);
		}
	}

	coalesce(): IFileChange[] {
		const addOrChangeEvents: IFileChange[] = [];
		const deletedPaths: string[] = [];

		// DELETEs collapse up the tree: a deleted folder suppresses the deletes of its children
		return Array.from(this.coalesced).filter(event => {
			if (event.type !== FileChangeType.DELETED) {
				addOrChangeEvents.push(event);
				return false;
			}
			return true;
		}).sort((a, b) => a.resource.fsPath.length - b.resource.fsPath.length).filter(event => {
			if (deletedPaths.some(deletedPath => isParent(deletedPath, event.resource.fsPath))) {
				return false;
			}
			deletedPaths.push(event.resource.fsPath);
			return true;
		}).concat(addOrChangeEvents);
	}
}

export function coalesceEvents(changes: IFileChange[]): IFileChange[] {
	const coalescer = new EventCoalescer();
	for (const change of changes) {
		coalescer.processEvent(change);
	}
	return coalescer.coalesce();
}

/**
 * The stale-delete guard: after a create/update, a delete for the same path within the window
 * is the rename-race artifact, not a real delete.
 */
export class StaleDeleteGuard {

	private readonly _lastAddOrUpdate = new Map<string, number>();

	/** returns the changes with stale deletes dropped */
	filter(changes: IFileChange[], now: number): IFileChange[] {
		const result: IFileChange[] = [];
		for (const change of changes) {
			const key = change.resource.fsPath.toLowerCase();
			if (change.type === FileChangeType.DELETED) {
				const last = this._lastAddOrUpdate.get(key);
				if (last !== undefined && now - last < STALE_DELETE_WINDOW) {
					// shortcut: correlation-lite — the real watcher correlates request ids
					this._lastAddOrUpdate.delete(key);
					continue;
				}
			} else {
				this._lastAddOrUpdate.set(key, now);
			}
			result.push(change);
		}
		return result;
	}
}

// ---- watch bookkeeping

export interface IWatchRequest {
	readonly id: number;
	readonly resource: URI;
	readonly recursive: boolean;
	readonly excludes?: readonly string[];
}

/** the main-side host abstraction the watcher service drives; testable with a fake */
export interface IWatcherHost {
	watch(rootPath: string, recursive: boolean, onRawEvent: (path: string, type: FileChangeType | 'unknown') => void): { dispose(): void };
}

/**
 * The watcher service: registers watch requests, normalizes/classifies raw host events,
 * coalesces them on COALESCE_WINDOW and applies the stale-delete guard. The timer is injected
 * so tests do not sleep.
 */
export class FileWatcherService {

	private readonly _requests = new Map<number, { request: IWatchRequest; host: { dispose(): void } }>();
	private readonly _guard = new StaleDeleteGuard();
	private _pending: IFileChange[] = [];
	private _timer: unknown;
	private _nextId = 1;

	constructor(
		private readonly _host: IWatcherHost,
		private readonly _onChanges: (changes: IFileChange[]) => void,
		private readonly _pathExists: (fsPath: string) => boolean,
		private readonly _now: () => number = () => Date.now(),
		private readonly _setTimer: (callback: () => void, ms: number) => unknown = (callback, ms) => setTimeout(callback, ms) as unknown
	) { }

	watch(request: Omit<IWatchRequest, 'id'>): number {
		const id = this._nextId++;
		const fullRequest: IWatchRequest = { ...request, id };
		const registration = { request: fullRequest, host: null as unknown as { dispose(): void } };
		registration.host = this._host.watch(request.resource.fsPath, request.recursive, (path, type) => {
			this._onRawEvent(path, type, fullRequest);
		});
		this._requests.set(id, registration);
		return id;
	}

	unwatch(id: number): void {
		const registration = this._requests.get(id);
		if (registration) {
			registration.host.dispose();
			this._requests.delete(id);
		}
	}

	dispose(): void {
		for (const registration of this._requests.values()) {
			registration.host.dispose();
		}
		this._requests.clear();
	}

	private _onRawEvent(fsPath: string, type: FileChangeType | 'unknown', request: IWatchRequest): void {
		if (request.excludes?.some(exclude => matchesExclude(fsPath, exclude))) {
			return;
		}
		const resolvedType = type === 'unknown'
			? (this._pathExists(fsPath) ? FileChangeType.UPDATED : FileChangeType.DELETED)
			: type;
		this._pending.push({ resource: URI.file(fsPath), type: resolvedType });
		if (this._timer === undefined) {
			this._timer = this._setTimer(() => this._flush(), COALESCE_WINDOW);
		}
	}

	private _flush(): void {
		this._timer = undefined;
		const pending = this._pending;
		this._pending = [];
		if (pending.length === 0) {
			return;
		}
		const changes = this._guard.filter(coalesceEvents(pending), this._now());
		if (changes.length > 0) {
			this._onChanges(changes);
		}
	}
}
