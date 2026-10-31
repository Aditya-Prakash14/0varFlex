import { contextBridge, ipcRenderer } from 'electron';
import { MINI_PTY_HOST_CHANNEL, MINI_EXT_HOST_CHANNEL, MINI_IPC_CHANNEL } from '../common/base/parts/ipc/ipc.electron.js';

// This is the surface the web page gets: a ping, a raw minimal IPC pair for the channel client,
// and the utility-process ports (extension host, pty host) wrapped in plain functions — a
// MessagePort cannot cross contextBridge; the preload keeps the port and proxies messages.

interface IPortBridge {
	/** resolves once main transferred the port into this renderer */
	requestPort(): Promise<void>;
	send(message: unknown): void;
	onMessage(handler: (message: unknown) => void): void;
	onExit(handler: (code: number | undefined) => void): void;
}

/** one MessagePort bridge per utility process (the 11 dance, done twice — which validates it) */
function makePortBridge(channel: string): IPortBridge {
	let port: MessagePort | null = null;
	const messageHandlers = new Set<(message: unknown) => void>();
	const exitHandlers = new Set<(code: number | undefined) => void>();
	const pendingPortWaiters: (() => void)[] = [];
	const bufferedMessages: unknown[] = [];

	const deliver = (message: unknown): void => {
		if (messageHandlers.size === 0) {
			bufferedMessages.push(message);
			return;
		}
		for (const handler of messageHandlers) {
			handler(message);
		}
	};

	ipcRenderer.on(channel, (event, payload: { type: string; code?: number }) => {
		if (payload?.type === 'port') {
			port = event.ports[0] ?? null;
			if (port) {
				// the host's messages arrive HERE (this is the renderer's end of the pair)
				port.onmessage = (messageEvent: MessageEvent) => deliver(messageEvent.data);
				port.start();
				for (const waiter of pendingPortWaiters.splice(0)) {
					waiter();
				}
			}
		} else if (payload?.type === 'exit') {
			for (const handler of exitHandlers) {
				handler(payload.code);
			}
		}
	});

	return {
		requestPort: () => {
			if (port) {
				return Promise.resolve();
			}
			return new Promise<void>(resolve => pendingPortWaiters.push(resolve));
		},
		send: message => {
			port?.postMessage(message);
		},
		onMessage: handler => {
			messageHandlers.add(handler);
			for (const buffered of bufferedMessages.splice(0)) {
				handler(buffered);
			}
		},
		onExit: handler => {
			exitHandlers.add(handler);
		}
	};
}

contextBridge.exposeInMainWorld('host', {
	ping: (payload: string): Promise<{ pong: string; from: string }> =>
		ipcRenderer.invoke('mini:ping', payload),

	ipc: {
		send: (message: unknown): void => {
			ipcRenderer.send(MINI_IPC_CHANNEL, message);
		},
		onMessage: (handler: (message: unknown) => void): void => {
			ipcRenderer.on(MINI_IPC_CHANNEL, (_event, message: unknown) => handler(message));
		},
	},

	extHost: makePortBridge(MINI_EXT_HOST_CHANNEL),
	ptyHost: makePortBridge(MINI_PTY_HOST_CHANNEL)
});
