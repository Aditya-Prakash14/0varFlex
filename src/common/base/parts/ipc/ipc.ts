// src/common/base/parts/ipc/ipc.ts — ported from vs/base/parts/ipc/common/ipc.ts, transport-free:
// the channel protocol, the client/server terminals and the ProxyChannel pair.
// Skipped upstream: VSBuffer framing, the initialize handshake, request timeouts, IPC logging,
// cancellation tokens, routing (IClientRouter).
//
// shortcut: no cross-process cancellation — upstream's IChannel.call carries a CancellationToken;
// revisit when the search appendix or LSP (12) need it.

import { Emitter, Event } from '../../common/event.js';
import { Disposable, dispose, DisposableStore, IDisposable, toDisposable } from '../../common/lifecycle.js';
import type { WireEvent, WireMessage, WireReply, WireReplyErr, WireSubscribe } from './ipc.electron.js';

/**
 * An `IChannel` is an abstraction over a collection of commands.
 * You can `call` several commands on a channel, each taking at
 * most one single argument. A `call` always returns a promise
 * with at most one single return value.
 */
export interface IChannel {
	call<T>(command: string, arg?: any): Promise<T>;
	listen<T>(event: string, arg?: any): Event<T>;
}

/**
 * An `IServerChannel` is the counter part to `IChannel`,
 * on the server-side. You should implement this interface
 * if you'd like to handle remote promises or events.
 */
export interface IServerChannel<TContext = string> {
	call<T>(ctx: TContext, command: string, arg?: any): Promise<T>;
	listen<T>(ctx: TContext, event: string, arg?: any): Event<T>;
}

/**
 * An `IChannelServer` hosts a collection of channels. You are
 * able to register channels onto it, provided a channel name.
 */
export interface IChannelServer<TContext = string> {
	registerChannel(channelName: string, channel: IServerChannel<TContext>): void;
}

/**
 * An `IChannelClient` has access to a collection of channels. You
 * are able to get those channels, given their channel name.
 */
export interface IChannelClient {
	getChannel<T extends IChannel>(channelName: string): T;
}

/**
 * A two-way message pipe: `send` puts a wire message on the wire,
 * `onMessage` receives them. The Electron transports implement this.
 */
export interface IMessagePassingProtocol {
	send(message: unknown): void;
	readonly onMessage: Event<unknown>;
}

interface PendingRequest {
	readonly resolve: (data: unknown) => void;
	readonly reject: (error: Error) => void;
}

/**
 * The client terminal: turns `IChannel` calls and `listen` subscriptions into wire
 * messages and routes replies/events back. One client per process connection.
 */
export class ChannelClient implements IChannelClient, IDisposable {

	private _isDisposed = false;
	private _lastRequestId = 0;
	private readonly _pendingRequests = new Map<number, PendingRequest>();
	private readonly _subscriptions = new Map<number, Emitter<unknown>>();
	private readonly _protocolListener: IDisposable;

	constructor(private readonly protocol: IMessagePassingProtocol) {
		this._protocolListener = protocol.onMessage(message => this._onMessage(message as WireMessage));
	}

	getChannel<T extends IChannel>(channelName: string): T {
		const that = this;
		return {
			call(command: string, arg?: any) { return that._requestPromise(channelName, command, arg); },
			listen(event: string, arg?: any) { return that._requestEvent(channelName, event, arg); }
		} as T;
	}

	dispose(): void {
		if (this._isDisposed) {
			return;
		}
		this._isDisposed = true;
		this._protocolListener.dispose();

		for (const [id, emitter] of this._subscriptions) {
			this._send({ type: 'unsubscribe', id }); // don't leak server-side listeners on dispose
			emitter.dispose();
		}
		this._subscriptions.clear();

		for (const pending of this._pendingRequests.values()) {
			pending.reject(new Error('ChannelClient has been disposed'));
		}
		this._pendingRequests.clear();
	}

	private _requestPromise<T>(channelName: string, command: string, arg: unknown): Promise<T> {
		if (this._isDisposed) {
			return Promise.reject(new Error('ChannelClient has been disposed'));
		}
		const id = ++this._lastRequestId;
		return new Promise<T>((resolve, reject) => {
			this._pendingRequests.set(id, { resolve: resolve as (data: unknown) => void, reject });
			this._send({ type: 'req', id, channelName, command, arg });
		});
	}

	private _requestEvent<T>(channelName: string, event: string, arg?: unknown): Event<T> {
		if (this._isDisposed) {
			return Event.None;
		}
		const id = ++this._lastRequestId;
		let emitter: Emitter<T> | undefined;

		// the subscription is created lazily with the first listener and shared by all of them,
		// so an Event that nobody listens to never reaches the server
		return (listener, thisArgs, disposables) => {
			if (this._isDisposed) {
				return Disposable.None;
			}
			if (!emitter) {
				emitter = new Emitter<T>();
				this._subscriptions.set(id, emitter as Emitter<unknown>);
				this._send({ type: 'subscribe', id, channelName, event, arg });
			}
			const subscription = emitter.event(listener, thisArgs, disposables);
			return toDisposable(() => {
				subscription.dispose();
				if (emitter && !emitter.hasListeners()) {
					this._subscriptions.delete(id);
					emitter.dispose();
					emitter = undefined;
					if (!this._isDisposed) {
						this._send({ type: 'unsubscribe', id });
					}
				}
			});
		};
	}

	private _send(message: WireMessage): void {
		try {
			this.protocol.send(message);
		} catch {
			// the other side is gone — drop silently
		}
	}

	private _onMessage(message: WireMessage): void {
		switch (message.type) {
			case 'reply': {
				const pending = this._pendingRequests.get(message.id);
				if (pending) {
					this._pendingRequests.delete(message.id);
					pending.resolve((message as WireReply).data);
				}
				return;
			}
			case 'replyErr': {
				const pending = this._pendingRequests.get(message.id);
				if (pending) {
					this._pendingRequests.delete(message.id);
					pending.reject(new Error((message as WireReplyErr).message));
				}
				return;
			}
			case 'event': {
				const emitter = this._subscriptions.get(message.id);
				if (!emitter) {
					return; // late event for a subscription that is already gone
				}
				try {
					emitter.fire((message as WireEvent).data);
				} catch (error) {
					// a listener threw: report and keep the channel alive for the next message
					console.error('[ipc] channel listener threw', error);
				}
				return;
			}
		}
	}
}

/**
 * The server terminal: routes wire messages to registered channels and pushes
 * replies and events back out. Created per window (per client connection).
 */
export class ChannelServer<TContext = string> implements IChannelServer<TContext>, IDisposable {

	private readonly _channels = new Map<string, IServerChannel<TContext>>();
	private readonly _activeRequests = new Map<number, IDisposable>();
	private readonly _protocolListener: IDisposable;
	private _isDisposed = false;

	constructor(private readonly _protocol: IMessagePassingProtocol, private readonly _ctx: TContext) {
		this._protocolListener = _protocol.onMessage(message => this._onMessage(message as WireMessage));
	}

	/** Number of live subscriptions — used by the exercise's reload-leak instrumentation. */
	get subscriptionCount(): number {
		return this._activeRequests.size;
	}

	registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
		this._channels.set(channelName, channel);
	}

	dispose(): void {
		if (this._isDisposed) {
			return;
		}
		this._isDisposed = true;
		this._protocolListener.dispose();
		dispose(this._activeRequests.values());
		this._activeRequests.clear();
		this._channels.clear();
	}

	private _onMessage(message: WireMessage): void {
		if (this._isDisposed) {
			return;
		}
		switch (message.type) {
			case 'req':
				this._onRequest(message);
				return;
			case 'subscribe':
				this._onSubscribe(message);
				return;
			case 'unsubscribe':
				this._onUnsubscribe(message.id);
				return;
		}
	}

	private _onRequest(request: { id: number; channelName: string; command: string; arg?: unknown }): void {
		const channel = this._channels.get(request.channelName);
		if (!channel) {
			this._sendResponse({ type: 'replyErr', id: request.id, message: `Unknown channel: ${request.channelName}` });
			return;
		}

		// replies and events are independent messages: never serialize them behind a single await
		// chain, or a handler that fires an event on this channel while running would deadlock
		let result: Promise<unknown>;
		try {
			result = Promise.resolve(channel.call(this._ctx, request.command, request.arg));
		} catch (error) {
			this._sendResponse({ type: 'replyErr', id: request.id, message: error instanceof Error ? error.message : String(error) });
			return;
		}
		result.then(
			data => this._sendResponse({ type: 'reply', id: request.id, data }),
			error => this._sendResponse({ type: 'replyErr', id: request.id, message: error instanceof Error ? error.message : String(error) })
		);
	}

	private _onSubscribe(request: { id: number; channelName: string; event: string; arg?: unknown }): void {
		const channel = this._channels.get(request.channelName);
		if (!channel) {
			console.warn(`[ipc] subscribe to unknown channel: ${request.channelName}`);
			return;
		}
		try {
			const listener = channel.listen(this._ctx, request.event, request.arg)(data => {
				this._sendResponse({ type: 'event', id: request.id, data });
			});
			this._activeRequests.set(request.id, listener);
		} catch (error) {
			console.warn(`[ipc] subscribe failed: ${request.channelName}:${request.event}`, error);
		}
	}

	private _onUnsubscribe(id: number): void {
		const listener = this._activeRequests.get(id);
		if (listener) {
			this._activeRequests.delete(id);
			listener.dispose();
		}
	}

	private _sendResponse(message: WireMessage): void {
		if (this._isDisposed) {
			return;
		}
		try {
			this._protocol.send(message);
		} catch {
			// the other side is gone (window closed): drop the message silently
		}
	}
}

/**
 * Use ProxyChannels to automatically wrap and unwrap
 * services to/from IPC channels, instead of manually wrapping
 * each service method and event.
 *
 * Restrictions:
 * - Events must follow the naming convention `onUpperCase`
 * - `CancellationToken` is currently not supported
 */
export namespace ProxyChannel {

	export function fromService<TContext>(service: unknown, disposables: DisposableStore): IServerChannel<TContext> {
		const handler = service as { [key: string]: unknown };

		// shortcut: upstream buffers early emissions (Event.buffer) and uses `disposables` for it;
		// here the service event is subscribed lazily by the channel listener — emissions before
		// anybody listens are lost. Upgrade if a channel needs replay.
		void disposables;

		return new class implements IServerChannel<TContext> {

			listen<T>(_ctx: TContext, event: string, arg: unknown): Event<T> {
				const target = handler[event];
				if (typeof target === 'function' && propertyIsEvent(event)) {
					return target as Event<T>;
				}
				throw new Error(`Event not found: ${event}`);
			}

			call<T>(_ctx: TContext, command: string, arg?: unknown): Promise<T> {
				const target = handler[command];
				if (typeof target === 'function') {
					let res: unknown = (target as Function).apply(handler, (arg as unknown[]) ?? []);
					if (!(res instanceof Promise)) {
						res = Promise.resolve(res);
					}
					return res as Promise<T>;
				}
				throw new Error(`Unknown channel command: ${command}`);
			}
		};
	}

	export function toService<T extends object>(channel: IChannel): T {
		return new Proxy({} as T, {
			get(_target: T, propKey: PropertyKey) {
				if (typeof propKey === 'string') {

					// answering `then` would make this proxy a thenable, so `await` would forward
					// it and never settle
					if (propKey === 'then') {
						return undefined;
					}

					// Event
					if (propertyIsEvent(propKey)) {
						return channel.listen(propKey);
					}

					// Function
					return async function (...args: unknown[]) {
						return channel.call(propKey, args);
					};
				}

				throw new Error(`Property not found: ${String(propKey)}`);
			}
		}) as T;
	}

	// Assume a property is an event if it has a form of "onSomething"
	function propertyIsEvent(name: string): boolean {
		return name[0] === 'o' && name[1] === 'n' && isUpperAsciiLetter(name.charCodeAt(2));
	}

	function isUpperAsciiLetter(code: number): boolean {
		return code >= 65 && code <= 90;
	}
}
