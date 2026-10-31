import { contextBridge, ipcRenderer } from 'electron';
import { MINI_EXT_HOST_CHANNEL, MINI_IPC_CHANNEL } from '../common/base/parts/ipc/ipc.electron.js';

// This is the surface the web page gets: a ping, a raw minimal IPC pair for the channel client,
// and the extension host port wrapped in plain functions (a MessagePort cannot cross
// contextBridge; the preload keeps the port and proxies messages).

let extHostPort: MessagePort | null = null;
const extHostMessageHandlers = new Set<(message: unknown) => void>();
const extHostExitHandlers = new Set<(code: number | undefined) => void>();
const pendingPortWaiters: (() => void)[] = [];
const bufferedMessages: unknown[] = [];

function deliverExtHostMessage(message: unknown): void {
	if (extHostMessageHandlers.size === 0) {
		bufferedMessages.push(message);
		return;
	}
	for (const handler of extHostMessageHandlers) {
		handler(message);
	}
}

ipcRenderer.on(MINI_EXT_HOST_CHANNEL, (event, payload: { type: string; code?: number }) => {
	if (payload?.type === 'port') {
		extHostPort = event.ports[0] ?? null;
		if (extHostPort) {
			// the host's messages arrive HERE (this is the renderer's end of the pair)
			extHostPort.onmessage = (messageEvent: MessageEvent) => deliverExtHostMessage(messageEvent.data);
			extHostPort.start();
			for (const waiter of pendingPortWaiters.splice(0)) {
				waiter();
			}
		}
	} else if (payload?.type === 'exit') {
		for (const handler of extHostExitHandlers) {
			handler(payload.code);
		}
	}
});

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

	extHost: {
		/** resolves once main transferred the port into this renderer */
		requestPort: (): Promise<void> => {
			if (extHostPort) {
				return Promise.resolve();
			}
			return new Promise<void>(resolve => pendingPortWaiters.push(resolve));
		},
		send: (message: unknown): void => {
			extHostPort?.postMessage(message);
		},
		onMessage: (handler: (message: unknown) => void): void => {
			extHostMessageHandlers.add(handler);
			for (const buffered of bufferedMessages.splice(0)) {
				handler(buffered);
			}
		},
		onExit: (handler: (code: number | undefined) => void): void => {
			extHostExitHandlers.add(handler);
		}
	},
});
