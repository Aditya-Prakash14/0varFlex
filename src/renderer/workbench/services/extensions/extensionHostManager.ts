// src/renderer/workbench/services/extensions/extensionHostManager.ts — the renderer's end of the
// extension host, ported in shape from
// vs/workbench/services/extensions/electron-browser/extensionHost.ts: main forks the utility
// process and transfers a MessagePort into this renderer; the RPC (both directions) rides 02's
// proxy channels over that port; a 10s handshake timeout treats a silent host as dead.

import { Emitter, Event } from '../../../../common/base/common/event.js';
import { Disposable, toDisposable } from '../../../../common/base/common/lifecycle.js';
import {
	ChannelClient,
	ChannelServer,
	IMessagePassingProtocol,
	ProxyChannel
} from '../../../../common/base/parts/ipc/ipc.js';
import type { IWindowChannel } from '../../../../common/platform/window/common/window.js';
import {
	EXT_HOST_COMMANDS,
	EXT_HOST_EXTENSION_SERVICE
} from '../../../../common/platform/extensions/common/extensionHostProtocol.js';
import type { IExtHostCommandsProxy, IExtHostExtensionService } from '../../../../extHost/mainThreadTypes.js';
import { registerAllMainThreadServices } from './mainThreadServices.js';

/** the preload's surface for the port dance (see src/preload/preload.ts) */
interface IExtHostPreloadBridge {
	requestPort(): Promise<void>;
	send(message: unknown): void;
	onMessage(handler: (message: unknown) => void): void;
	onExit(handler: (code: number | undefined) => void): void;
}

function bridge(): IExtHostPreloadBridge {
	return (window as unknown as { host: { extHost: IExtHostPreloadBridge } }).host.extHost;
}

class ExtHostProtocol implements IMessagePassingProtocol {

	private readonly _onMessage = new Emitter<unknown>();
	readonly onMessage: Event<unknown> = this._onMessage.event;
	private readonly _bridge = bridge();

	constructor() {
		this._bridge.onMessage(message => this._onMessage.fire(message));
	}

	send(message: unknown): void {
		try {
			this._bridge.send(message);
		} catch {
			// the host is gone — drop silently
		}
	}
}

export class ExtensionHostManager extends Disposable {

	private _client: ChannelClient | undefined;
	private _server: ChannelServer<string> | undefined;
	private _commands: IExtHostCommandsProxy | undefined;
	private _extensionService: IExtHostExtensionService | undefined;
	private _alive = false;
	private _started = false;

	private readonly _onDidExit = this._register(new Emitter<number | undefined>());
	readonly onDidExit: Event<number | undefined> = this._onDidExit.event;

	constructor(
		private readonly _windowChannel: IWindowChannel,
		/** the workbench installs its MainThreadX services here (the host calls them) */
		private readonly _registerMainThreadServices: (server: ChannelServer<string>) => void
	) {
		super();
		bridge().onExit(code => {
			this._alive = false;
			this._onDidExit.fire(code);
		});
		this._register(toDisposable(() => { void this.terminate(); }));
	}

	get isAlive(): boolean {
		return this._alive;
	}

	/** fork + port transfer + protocol setup; the caller then performs the initialize handshake */
	async start(): Promise<void> {
		if (this._started) {
			return;
		}
		this._started = true;

		const portArrived = bridge().requestPort();
		await this._windowChannel.startExtensionHost();
		await portArrived;

		const protocol = new ExtHostProtocol();
		this._client = new ChannelClient(protocol);
		this._server = new ChannelServer<string>(protocol, 'mainThread');
		this._registerMainThreadServices(this._server);

		this._commands = ProxyChannel.toService<IExtHostCommandsProxy>(this._client.getChannel(EXT_HOST_COMMANDS));
		this._extensionService = ProxyChannel.toService<IExtHostExtensionService>(this._client.getChannel(EXT_HOST_EXTENSION_SERVICE));
		this._alive = true;
	}

	/** the handshake: initialize(initData) → ready, with the ported 10s timeout */
	async initialize(initData: unknown): Promise<void> {
		if (!this._extensionService) {
			throw new Error('the extension host was not started');
		}
		const timeout = new Promise<never>((_resolve, reject) => {
			setTimeout(() => reject(new Error('the extension host did not become ready within 10s')), 10_000);
		});
		await Promise.race([
			this._extensionService.initialize(initData),
			timeout
		]);
	}

	activateExtension(identifier: string, reason: string): Promise<{ activationTimeMs: number }> {
		if (!this._extensionService || !this._alive) {
			return Promise.reject(new Error('the extension host is not running'));
		}
		return this._extensionService.$activateExtension(identifier, reason);
	}

	/** a generic call into a host-served channel (document/config pushes) */
	callHostService(channel: string, command: string, args: unknown[]): Promise<unknown> {
		if (!this._client || !this._alive) {
			return Promise.resolve(undefined);
		}
		return this._client.getChannel(channel).call(command, args);
	}

	executeCommand(id: string, args: readonly unknown[]): Promise<unknown> {
		if (!this._commands || !this._alive) {
			return Promise.reject(new Error('the extension host is not running'));
		}
		return this._commands.$executeContributedCommand(id, [...args]);
	}

	/** ask the host to deactivate + exit; a 1s cap keeps the reload path snappy */
	async terminate(): Promise<void> {
		if (!this._alive || !this._extensionService) {
			return;
		}
		this._alive = false;
		const exited = new Promise<void>(resolve => {
			const listener = this._onDidExit.event(() => {
				listener.dispose();
				resolve();
			});
		});
		await Promise.race([
			this._extensionService.terminate().catch(() => { /* the host may already be gone */ }),
			new Promise<void>(resolve => setTimeout(resolve, 1000))
		]);
		await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 1000))]);
		this._client?.dispose();
		this._server?.dispose();
	}
}
