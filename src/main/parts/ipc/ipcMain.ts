// src/main/parts/ipc/ipcMain.ts — the main-side transport: Electron's `ipcMain` bus ↔ one
// ChannelServer per window.

import { ipcMain, WebContents } from 'electron';
import { Emitter } from '../../../common/base/common/event.js';
import { DisposableStore, IDisposable } from '../../../common/base/common/lifecycle.js';
import { ChannelServer, IMessagePassingProtocol } from '../../../common/base/parts/ipc/ipc.js';
import { MINI_IPC_CHANNEL, WireMessage } from '../../../common/base/parts/ipc/ipc.electron.js';

/** Everything a server channel gets as its `ctx` — which window the client belongs to. */
export interface IWindowContext {
	readonly windowId: number;
}

class WindowProtocol implements IMessagePassingProtocol {

	private readonly _onMessage = new Emitter<unknown>();
	readonly onMessage = this._onMessage.event;

	constructor(private readonly _sender: WebContents) { }

	acceptMessage(message: unknown): void {
		this._onMessage.fire(message);
	}

	send(message: unknown): void {
		try {
			if (!this._sender.isDestroyed()) {
				this._sender.send(MINI_IPC_CHANNEL, message);
			}
		} catch {
			// the renderer is gone — drop silently (a late reply must not crash main)
		}
	}
}

interface IWindowServer {
	readonly server: ChannelServer<IWindowContext>;
	readonly protocol: WindowProtocol;
	readonly store: DisposableStore;
	dispose(): void;
}

export class MainProcessIpc implements IDisposable {

	private readonly _servers = new Map<number, IWindowServer>();
	private readonly _ipcMainListener: (event: Electron.IpcMainEvent, message: unknown) => void;

	constructor(
		private readonly _setup: (server: ChannelServer<IWindowContext>, store: DisposableStore, sender: WebContents) => void
	) {
		this._ipcMainListener = (event, message) => this._onMessage(event.sender, message);
		ipcMain.on(MINI_IPC_CHANNEL, this._ipcMainListener);
	}

	dispose(): void {
		ipcMain.off(MINI_IPC_CHANNEL, this._ipcMainListener);
		for (const entry of [...this._servers.values()]) {
			entry.dispose();
		}
		this._servers.clear();
	}

	private _onMessage(sender: WebContents, message: unknown): void {
		let entry = this._servers.get(sender.id);
		if (!entry) {
			entry = this._createServer(sender);
		}
		entry.protocol.acceptMessage(message);

		// instrumented for the exercise's reload-leak check
		const type = (message as WireMessage | undefined)?.type;
		if (type === 'subscribe' || type === 'unsubscribe') {
			console.log(`[main] ipc subscriptions: ${entry.server.subscriptionCount}`);
		}
	}

	private _createServer(sender: WebContents): IWindowServer {
		const store = new DisposableStore();
		const protocol = new WindowProtocol(sender);
		const server = new ChannelServer<IWindowContext>(protocol, { windowId: sender.id });

		// this window's channels (log, fileIO, window) — registered by main.ts
		this._setup(server, store, sender);

		const entry: IWindowServer = {
			server,
			protocol,
			store,
			dispose: () => {
				sender.off('destroyed', onDestroyed);
				sender.off('did-start-navigation', onNavigate);
				this._servers.delete(sender.id);
				console.log(`[main] ipc server for window ${sender.id} disposed (subscriptions: ${server.subscriptionCount})`);
				store.dispose();
				server.dispose();
			}
		};

		// a reload starts a fresh ChannelClient (ids restart at 1) and a closed window is gone:
		// both must drop this server's subscriptions
		const onNavigate = (_event: Electron.Event, _url: string, _isInPlace: boolean, isMainFrame: boolean): void => {
			if (isMainFrame) {
				entry.dispose();
			}
		};
		const onDestroyed = (): void => entry.dispose();
		sender.on('destroyed', onDestroyed);
		sender.on('did-start-navigation', onNavigate);

		this._servers.set(sender.id, entry);
		return entry;
	}
}
