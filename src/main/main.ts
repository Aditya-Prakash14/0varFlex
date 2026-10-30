import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// In modern JavaScript modules there is no __dirname; these two lines recreate it.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createWindow(): void {
	const win = new BrowserWindow({
		width: 1100,
		height: 720,
		show: false,                 // don't show until the page has painted…
		backgroundColor: '#1e1e1e',  // …and paint dark, so there is no white flash
		webPreferences: {
			contextIsolation: true,  // wall between web page and preload internals
			nodeIntegration: false,  // the web page gets NO Node.js powers
			preload: path.join(__dirname, 'preload.cjs'),
		},
	});

	win.once('ready-to-show', () => win.show());
	void win.loadFile(path.join(__dirname, 'index.html'));
}

// The one IPC endpoint so far: the renderer asks "mini:ping", the main process answers.
ipcMain.handle('mini:ping', (_event, payload: string) => ({
	pong: payload,
	from: 'main',
}));

void app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
	app.quit(); // close the window → quit the whole app (incl. on macOS)
});
