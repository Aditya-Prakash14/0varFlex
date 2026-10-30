import { contextBridge, ipcRenderer } from 'electron';

// This is the ONLY ability the web page gets. Not "file access". One function.
contextBridge.exposeInMainWorld('host', {
	ping: (payload: string): Promise<{ pong: string; from: string }> =>
		ipcRenderer.invoke('mini:ping', payload),
});
