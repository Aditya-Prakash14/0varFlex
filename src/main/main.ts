import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MainProcessIpc } from './parts/ipc/ipcMain.js';
import { registerChannels } from './parts/ipc/channels.js';
import { StorageMainService } from '../common/platform/storage/common/storageIpc.js';
import { installMenu } from './menu.js';

// In modern JavaScript modules there is no __dirname; these two lines recreate it.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let storage: StorageMainService;

function createWindow(): void {
	const win = new BrowserWindow({
		width: 1100,
		height: 720,
		show: false,                 // don't show until the page has painted…
		backgroundColor: '#1e1e1e',  // …and paint dark, so there is no white flash
		// exercise 03: the custom title bar. `hiddenInset` keeps the macOS traffic lights and
		// tucks them into our title bar (no explicit trafficLightPosition in this VS Code
		// revision — the title bar CSS reserves room with a left padding instead)
		titleBarStyle: 'hiddenInset',
		webPreferences: {
			contextIsolation: true,  // wall between web page and preload internals
			nodeIntegration: false,  // the web page gets NO Node.js powers
			preload: path.join(__dirname, 'preload.cjs'),
		},
	});

	win.once('ready-to-show', () => win.show());
	void win.loadFile(path.join(__dirname, 'index.html'));
}

// The one IPC endpoint of exercise 00: the renderer asks "mini:ping", the main process answers.
ipcMain.handle('mini:ping', (_event, payload: string) => ({
	pong: payload,
	from: 'main',
}));

// Exercise 02: the channel transport. One ChannelServer per window, created lazily with the
// renderer's first message.
const ipc = new MainProcessIpc((server, store, sender) => {
	const window = BrowserWindow.fromWebContents(sender);
	if (window) {
		registerChannels(window, server, store, storage);
	}
});

void app.whenReady().then(() => {
	// storage lives in main (one file per scope) — the renderer reads through the channel
	storage = new StorageMainService(app.getPath('userData'));
	installMenu();
	createWindow();
});

app.on('window-all-closed', () => {
	ipc.dispose();
	app.quit(); // close the window → quit the whole app (incl. on macOS)
});
