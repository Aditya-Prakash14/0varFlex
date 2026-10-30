// src/common/base/common/lifecycle.ts — ported from vs/base/common/lifecycle.ts.
// Skipped upstream: leak tracking (DisposableTracker, markAsDisposed), parent-of-disposable bookkeeping.

/**
 * An object that performs a cleanup operation when `.dispose()` is called.
 */
export interface IDisposable {
	dispose(): void;
}

/**
 * Check if `thing` is disposable.
 */
export function isDisposable<E>(thing: E): thing is E & IDisposable {
	return typeof thing === 'object' && thing !== null && typeof (thing as unknown as IDisposable).dispose === 'function' && (thing as unknown as IDisposable).dispose.length === 0;
}

/**
 * Disposes of the value(s) passed in.
 */
export function dispose<T extends IDisposable>(disposable: T): T;
export function dispose<T extends IDisposable>(disposable: T | undefined): T | undefined;
export function dispose<T extends IDisposable, A extends Iterable<T> = Iterable<T>>(disposables: A): A;
export function dispose<T extends IDisposable>(disposables: Array<T>): Array<T>;
export function dispose<T extends IDisposable>(disposables: ReadonlyArray<T>): ReadonlyArray<T>;
export function dispose<T extends IDisposable>(arg: T | Iterable<T> | undefined): any {
	if (arg && typeof (arg as Iterable<T>)[Symbol.iterator] === 'function') {
		const errors: any[] = [];
		for (const d of arg as Iterable<T>) {
			if (d) {
				try {
					d.dispose();
				} catch (e) {
					errors.push(e);
				}
			}
		}
		if (errors.length === 1) {
			throw errors[0];
		} else if (errors.length > 1) {
			throw new AggregateError(errors, 'Encountered errors while disposing of store');
		}
		return Array.isArray(arg) ? [] : arg;
	} else if (arg) {
		(arg as T).dispose();
		return arg;
	}
}

/**
 * Turn a function that implements dispose into an {@link IDisposable}.
 *
 * @param fn Clean up function, guaranteed to be called only **once**.
 */
export function toDisposable(fn: () => void): IDisposable {
	let disposed = false;
	return {
		dispose(): void {
			if (disposed) {
				return;
			}
			disposed = true;
			fn();
		}
	};
}

/**
 * Manages a collection of disposable values.
 */
export class DisposableStore implements IDisposable {

	private readonly _toDispose = new Set<IDisposable>();
	private _isDisposed = false;

	/**
	 * Dispose of all registered disposables and mark this object as disposed.
	 */
	dispose(): void {
		if (this._isDisposed) {
			return;
		}
		this._isDisposed = true;
		this.clear();
	}

	/**
	 * @return `true` if this object has been disposed of.
	 */
	get isDisposed(): boolean {
		return this._isDisposed;
	}

	/**
	 * Dispose of all registered disposables but do not mark this object as disposed.
	 * Anything added from within a dispose handler is disposed too, then the store is cleared.
	 */
	clear(): void {
		while (this._toDispose.size > 0) {
			const items = [...this._toDispose];
			this._toDispose.clear();
			dispose(items);
		}
	}

	/**
	 * Add a new {@link IDisposable disposable} to the collection.
	 */
	add<T extends IDisposable>(o: T): T {
		if (!o || o === Disposable.None) {
			return o;
		}
		if ((o as unknown as DisposableStore) === this) {
			throw new Error('Cannot register a disposable on itself!');
		}
		if (this._isDisposed) {
			// upstream (newer revisions) warns and leaks instead; this course keeps the original throw
			throw new Error('Object has been disposed');
		}
		this._toDispose.add(o);
		return o;
	}

	/**
	 * Deletes a disposable from the store and disposes of it.
	 */
	delete<T extends IDisposable>(o: T): void {
		if (!o) {
			return;
		}
		if ((o as unknown as DisposableStore) === this) {
			throw new Error('Cannot dispose a disposable on itself!');
		}
		this._toDispose.delete(o);
		o.dispose();
	}

	/**
	 * Deletes the value from the store, but does not dispose it.
	 */
	deleteAndLeak<T extends IDisposable>(o: T): void {
		if (!o) {
			return;
		}
		this._toDispose.delete(o);
	}
}

/**
 * Abstract base class for a {@link IDisposable disposable} object.
 *
 * Subclasses can {@linkcode _register} disposables that will be automatically cleaned up when this object is disposed of.
 */
export abstract class Disposable implements IDisposable {

	/**
	 * A disposable that does nothing when it is disposed of.
	 */
	static readonly None = Object.freeze<IDisposable>({ dispose() { } });

	protected readonly _store = new DisposableStore();

	dispose(): void {
		this._store.dispose();
	}

	/**
	 * Adds `o` to the collection of disposables managed by this object.
	 */
	protected _register<T extends IDisposable>(o: T): T {
		if ((o as unknown as Disposable) === this) {
			throw new Error('Cannot register a disposable on itself!');
		}
		return this._store.add(o);
	}
}
