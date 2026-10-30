// lifecycle.ts contracts + the disposable-subscription contracts of event.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Emitter, Event } from '../src/common/base/common/event.js';
import { Disposable, DisposableStore, dispose, IDisposable, toDisposable } from '../src/common/base/common/lifecycle.js';

test('DisposableStore disposes its contents in insertion order, then clears', () => {
	const store = new DisposableStore();
	const events: string[] = [];
	store.add(toDisposable(() => events.push('a')));
	store.add(toDisposable(() => events.push('b')));

	assert.equal(store.isDisposed, false);
	store.dispose();
	assert.deepEqual(events, ['a', 'b']);
	assert.equal(store.isDisposed, true);
});

test('DisposableStore.clear() disposes contents and anything added meanwhile, then clears', () => {
	const store = new DisposableStore();
	const events: string[] = [];
	const late = toDisposable(() => events.push('late'));
	store.add(toDisposable(() => {
		events.push('first');
		store.add(late); // added from inside a dispose handler
	}));

	store.clear();
	assert.deepEqual(events, ['first', 'late']);
	assert.equal(store.isDisposed, false); // clear() does not dispose the store itself
	store.add(toDisposable(() => { })); // ...so the store is still usable
});

test('DisposableStore: dispose is idempotent; adding after dispose throws', () => {
	const store = new DisposableStore();
	let count = 0;
	store.add(toDisposable(() => count++));

	store.dispose();
	store.dispose();
	assert.equal(count, 1);

	assert.throws(() => store.add(toDisposable(() => { })), /Object has been disposed/);
});

test('Disposable.dispose() runs its store once; calling twice is a no-op', () => {
	class Holder extends Disposable {
		register(d: IDisposable): IDisposable {
			return this._register(d);
		}
	}

	const holder = new Holder();
	let count = 0;
	holder.register(toDisposable(() => count++));

	holder.dispose();
	holder.dispose();
	assert.equal(count, 1);
});

test('dispose() helper handles single values and iterables', () => {
	let single = 0;
	let a = 0;
	let b = 0;
	dispose(toDisposable(() => single++));
	dispose([toDisposable(() => a++), toDisposable(() => b++)]);
	assert.deepEqual([single, a, b], [1, 1, 1]);
});

test('Emitter.fire snapshots the listener list', () => {
	const emitter = new Emitter<number>();
	const calls: string[] = [];
	let second: IDisposable;

	const first = emitter.event(() => {
		calls.push('first');
		second.dispose(); // unsubscribe a later listener mid-fire
	});
	second = emitter.event(() => calls.push('second'));

	emitter.fire(1);
	assert.deepEqual(calls, ['first', 'second']); // order preserved; later listener still sees this fire

	calls.length = 0;
	emitter.fire(2);
	assert.deepEqual(calls, ['first']); // gone on the next fire

	first.dispose();
	assert.equal(emitter.hasListeners(), false);
});

test('Event.once fires at most once and cleans up its source subscription', () => {
	const emitter = new Emitter<string>();
	let count = 0;
	Event.once(emitter.event)(() => count++);

	emitter.fire('a');
	emitter.fire('b');
	assert.equal(count, 1);
	assert.equal(emitter.hasListeners(), false);
});

test('Event.map/filter: unsubscribing does not leak the source listener', () => {
	const emitter = new Emitter<number>();
	const seen: number[] = [];
	const mapped = Event.filter(Event.map(emitter.event, n => n * 2), n => n > 4);

	const subscription = mapped(v => seen.push(v));
	assert.equal(emitter.hasListeners(), true);

	emitter.fire(1); // -> 2, filtered out
	emitter.fire(3); // -> 6
	assert.deepEqual(seen, [6]);

	subscription.dispose();
	assert.equal(emitter.hasListeners(), false); // source listener is gone

	emitter.fire(4);
	assert.deepEqual(seen, [6]);
});

test('event subscriptions can be added to a DisposableStore', () => {
	const emitter = new Emitter<void>();
	const store = new DisposableStore();
	let called = 0;

	emitter.event(() => called++, null, store);
	emitter.fire();
	assert.equal(called, 1);

	store.dispose();
	emitter.fire();
	assert.equal(called, 1);
	assert.equal(emitter.hasListeners(), false);
});

test('Event.None never fires and returns a disposable', () => {
	const disposable = Event.None(() => { throw new Error('should not fire'); });
	disposable.dispose();
});
