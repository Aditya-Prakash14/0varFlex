// The pure protocol: call/response, error propagation, event subscribe/unsubscribe with arg
// filtering, proxy conversion — all over a fake in-memory transport pair (no Electron).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Emitter, Event } from '../src/common/base/common/event.js';
import { DisposableStore } from '../src/common/base/common/lifecycle.js';
import { ChannelClient, ChannelServer, IMessagePassingProtocol, IServerChannel, ProxyChannel } from '../src/common/base/parts/ipc/ipc.js';

class FakeProtocol implements IMessagePassingProtocol {

	private readonly _onMessage = new Emitter<unknown>();
	readonly onMessage = this._onMessage.event;

	other!: FakeProtocol;

	send(message: unknown): void {
		this.other._onMessage.fire(message);
	}
}

function connect() {
	const serverSide = new FakeProtocol();
	const clientSide = new FakeProtocol();
	serverSide.other = clientSide;
	clientSide.other = serverSide;

	const server = new ChannelServer(serverSide, { windowId: 1 });
	const client = new ChannelClient(clientSide);
	return { server, client };
}

test('call round-trips with arguments and results', async () => {
	const { server, client } = connect();
	server.registerChannel('math', ProxyChannel.fromService({ add: (a: number, b: number) => a + b }, new DisposableStore()));

	const math = ProxyChannel.toService<{ add(a: number, b: number): Promise<number> }>(client.getChannel('math'));
	assert.equal(await math.add(20, 22), 42);
});

test('call errors reject with the original message; unknown channel/command too', async () => {
	const { server, client } = connect();
	server.registerChannel('boom', ProxyChannel.fromService({
		fail: () => { throw new Error('boom!'); }
	}, new DisposableStore()));

	const service = ProxyChannel.toService<{ fail(): Promise<never> }>(client.getChannel('boom'));
	await assert.rejects(service.fail(), /boom!/);

	await assert.rejects(client.getChannel('boom').call('doesNotExist'), /Unknown channel command: doesNotExist/);
	await assert.rejects(client.getChannel('nope').call('anything'), /Unknown channel: nope/);
});

test('listen delivers arg-filtered events; unsubscribing stops delivery', () => {
	const { server, client } = connect();

	// a hand-written channel: `arg` selects the watched resource (like fileIO's per-path watch)
	const emitters = new Map<string, Emitter<void>>();
	const channel = {
		call: async () => undefined,
		listen: (_ctx: unknown, event: string, arg: string) => {
			assert.equal(event, 'onDidPing');
			let emitter = emitters.get(arg);
			if (!emitter) {
				emitter = new Emitter<void>();
				emitters.set(arg, emitter);
			}
			return emitter.event;
		}
	} as unknown as IServerChannel<{ windowId: number }>;
	server.registerChannel('resource', channel);

	const receivedA: string[] = [];
	const receivedB: string[] = [];
	const subA = client.getChannel('resource').listen('onDidPing', 'a')(() => receivedA.push('a'));
	const subB = client.getChannel('resource').listen('onDidPing', 'b')(() => receivedB.push('b'));

	emitters.get('a')!.fire();
	emitters.get('a')!.fire();
	emitters.get('b')!.fire();
	assert.deepEqual(receivedA, ['a', 'a']);
	assert.deepEqual(receivedB, ['b']);

	assert.equal(server.subscriptionCount, 2);
	subA.dispose();
	assert.equal(server.subscriptionCount, 1);

	emitters.get('a')!.fire();
	assert.deepEqual(receivedA, ['a', 'a']); // no more delivery after unsubscribe
	assert.deepEqual(receivedB, ['b']);
});

test('a throwing listener does not kill the channel', async () => {
	const { server, client } = connect();
	const emitter = new Emitter<number>();
	server.registerChannel('events', {
		call: async () => undefined,
		listen: () => emitter.event
	} as unknown as IServerChannel<{ windowId: number }>);

	const surviving: string[] = [];
	client.getChannel('events').listen('onDidChange')(() => { throw new Error('listener exploded'); });
	client.getChannel('events').listen('onDidChange')(() => surviving.push('survivor'));

	emitter.fire(1); // the throwing listener must not take the channel down
	emitter.fire(2);
	assert.deepEqual(surviving, ['survivor', 'survivor']);

	// ...and calls still work afterwards
	server.registerChannel('ok', ProxyChannel.fromService({ ping: () => 'pong' }, new DisposableStore()));
	assert.equal(await client.getChannel('ok').call('ping', []), 'pong');
});

test('ProxyChannel: toService round-trips methods and static events', async () => {
	const { server, client } = connect();

	const _onDidPing = new Emitter<string>();
	server.registerChannel('svc', ProxyChannel.fromService({
		onDidPing: _onDidPing.event,
		greet: (name: string) => `hi ${name}`
	}, new DisposableStore()));

	const proxy = ProxyChannel.toService<{ greet(name: string): Promise<string>; onDidPing: Event<string> }>(client.getChannel('svc'));

	const seen: string[] = [];
	const subscription = proxy.onDidPing(ping => seen.push(ping));
	_onDidPing.fire('one');
	_onDidPing.fire('two');
	assert.deepEqual(seen, ['one', 'two']);
	assert.equal(await proxy.greet('world'), 'hi world');

	subscription.dispose();
	_onDidPing.fire('three');
	assert.deepEqual(seen, ['one', 'two']);
	assert.equal(server.subscriptionCount, 0);
});

test('disposing the client drops subscriptions; disposing the server sends nothing further', () => {
	const { server, client } = connect();
	const emitter = new Emitter<void>();
	server.registerChannel('events', {
		call: async () => undefined,
		listen: () => emitter.event
	} as unknown as IServerChannel<{ windowId: number }>);

	let calls = 0;
	client.getChannel('events').listen('onDidChange')(() => calls++);
	emitter.fire();
	assert.equal(calls, 1);

	client.dispose();
	emitter.fire(); // the relay listener is disposed with the server's subscription
	assert.equal(server.subscriptionCount, 0);
	assert.equal(calls, 1);
});
