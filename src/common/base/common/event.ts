// src/common/base/common/event.ts — a small core of vs/base/common/event.ts:
// Emitter, Event.once/map/filter/None. Skipped upstream: debounce/throttle, node emitters,
// leak tracking, delivery queues, snapshot-sharing for derived events.

import { Disposable, DisposableStore, IDisposable, toDisposable } from './lifecycle.js';

/**
 * An event with zero or one parameters that can be subscribed to. The event is a function itself.
 */
export interface Event<T> {
	(listener: (e: T) => unknown, thisArgs?: any, disposables?: IDisposable[] | DisposableStore): IDisposable;
}

export namespace Event {

	export const None: Event<any> = () => Disposable.None;

	/**
	 * Given an event, returns another event which only fires once.
	 */
	export function once<T>(event: Event<T>): Event<T> {
		return (listener, thisArgs = null, disposables?) => {
			// we need this, in case the event fires during the listener call
			let didFire = false;
			let result: IDisposable | undefined = undefined;
			result = event(e => {
				if (didFire) {
					return;
				} else if (result) {
					result.dispose();
				} else {
					didFire = true;
				}
				return listener.call(thisArgs, e);
			}, null, disposables);
			if (didFire) {
				result.dispose();
			}
			return result;
		};
	}

	/**
	 * Maps an event of one type into an event of another type, similar to how `Array.prototype.map` works.
	 */
	// shortcut: every listener subscribes the source event (upstream shares one subscription via a
	// snapshot emitter); upgrade if listener counts on hot events ever matter in code
	export function map<I, O>(event: Event<I>, map: (i: I) => O): Event<O> {
		return (listener, thisArgs = null, disposables?) => event(i => listener.call(thisArgs, map(i)), null, disposables);
	}

	/**
	 * Wraps an event in another event that fires only when some condition is met.
	 */
	export function filter<T>(event: Event<T>, filter: (e: T) => boolean): Event<T> {
		return (listener, thisArgs = null, disposables?) => event(e => filter(e) && listener.call(thisArgs, e), null, disposables);
	}
}

export class Emitter<T> implements IDisposable {

	private readonly _listeners = new Set<(e: T) => unknown>();
	private _event?: Event<T>;
	private _disposed = false;

	/**
	 * For the public to allow to subscribe to events from this Emitter.
	 */
	get event(): Event<T> {
		this._event ??= (callback: (e: T) => unknown, thisArgs?: any, disposables?: IDisposable[] | DisposableStore) => {
			if (this._disposed) {
				return Disposable.None;
			}
			const bound = thisArgs ? callback.bind(thisArgs) : callback;
			this._listeners.add(bound);
			const result = toDisposable(() => this._listeners.delete(bound));
			addToDisposables(result, disposables);
			return result;
		};
		return this._event;
	}

	hasListeners(): boolean {
		return this._listeners.size > 0;
	}

	/**
	 * Fire an event to all subscribers.
	 */
	fire(event: T): void {
		if (this._disposed) {
			return;
		}
		// snapshot the listener list: a listener that unsubscribes a later listener must
		// not change this fire's order — and the later listener still receives this event
		const listeners = [...this._listeners];
		for (const listener of listeners) {
			listener(event);
		}
	}

	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._listeners.clear();
	}
}

function addToDisposables(result: IDisposable, disposables: DisposableStore | IDisposable[] | undefined): void {
	if (disposables instanceof DisposableStore) {
		disposables.add(result);
	} else if (Array.isArray(disposables)) {
		disposables.push(result);
	}
}
