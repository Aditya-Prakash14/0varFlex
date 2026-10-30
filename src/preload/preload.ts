import { contextBridge, ipcRenderer } from 'electron';
import { MINI_IPC_CHANNEL } from '../common/base/parts/ipc/ipc.electron.js';

// This is the surface the web page gets: a ping and a raw, minimal IPC pair for the channel
// client. Nothing else.
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
});
