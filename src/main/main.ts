// src/main/main.ts — the Electron main entry.
//
// 14 added the shipping pieces, ported in shape from vs/code/electron-main/main.ts +
// code/node/cli.ts:
//
//   - a SINGLE INSTANCE: a second `mini file` hands its argv over through Electron's
//     `second-instance` event and exits (the real CLI talks to the running instance over a
//     socket — delta documented);
//   - the CLI decision table (`--open-file`/`--open-folder`, bare paths, unknown flags) lives in
//     common/platform/cli/common/cliArgs.ts so it unit-tests;
//   - a pre-WINDOW failure to start shows a native dialog with a Copy Error button (the real
//     main.ts reports startup errors the same way) before exiting;
//   - the update service (electron-updater against the generic feed) is created and started here;
//     the renderer drives its UI over the window channel.

import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron';
import { Event } from '../common/base/common/event.js';
import type { ILogService } from '../common/platform/log/common/log.js';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliPathKind, parseCliArgs } from '../common/platform/cli/common/cliArgs.js';
import type { IWindowCliPath } from '../common/platform/window/common/window.js';
import { MainProcessIpc } from './parts/ipc/ipcMain.js';
import { registerChannels, sendPathsToWindow } from './parts/ipc/channels.js';
import { createUpdateService } from './update/updateService.js';
import type { IUpdateService } from './update/updateService.js';
import { StorageMainService } from '../common/platform/storage/common/storageIpc.js';
import { FileService } from '../common/platform/files/common/fileService.js';
import { DiskFileSystemProvider } from './files/diskFileSystemProvider.js';
import { createFileWatcher } from './files/fileWatcher.js';
import { installMenu } from './menu.js';

// In modern JavaScript modules there is no __dirname; these two lines recreate it.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let storage: StorageMainService;
let fileService: FileService;
let updateService: IUpdateService | undefined;
/** the pre-window failure guard: dialogs only apply until a window exists */
let windowCreated = false;

// main-side log surface (the renderer has its own through the log channel)
const mainLogService: ILogService = {
	_serviceBrand: undefined,
	onDidLog: Event.None,
	trace: () => { /* console noise */ },
	info: message => console.log('[main]', message),
	warn: message => console.warn('[main]', message),
	error: message => console.error('[main]', typeof message === 'string' ? message : message.message)
};

// ---- 14: the CLI decision table (ported from code/node/cli.ts at 1%)

function classifyPath(absolutePath: string): CliPathKind {
	try {
		const stat = statSync(absolutePath);
		return stat.isDirectory() ? 'folder' : 'file';
	} catch {
		return 'missing';
	}
}

/** argv → the paths to open. Packaged: skip the binary; dev: skip the binary AND `.`. */
function pathsFromArgv(argv: readonly string[], cwd: string): readonly IWindowCliPath[] {
	const args = argv.slice(app.isPackaged ? 1 : 2);
	return parseCliArgs(args, candidate => classifyPath(path.resolve(cwd, candidate))).paths
		.map(entry => ({ path: path.resolve(cwd, entry.path), kind: entry.kind }));
}

const initialPaths = pathsFromArgv(process.argv, process.cwd());

// ---- 14: the pre-window failure dialog (the real main.ts's startup error path)

function showStartupFailure(error: unknown): void {
	const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
	try {
		const result = dialog.showMessageBoxSync({
			type: 'error',
			title: 'mini-vscode',
			message: 'mini-vscode failed to start',
			detail,
			buttons: ['Copy Error', 'Close'],
			defaultId: 1,
			cancelId: 1,
			noLink: true
		});
		if (result === 0) {
			clipboard.writeText(detail);
		}
	} catch {
		console.error(detail);
	}
	app.exit(1);
}

process.on('uncaughtException', error => {
	if (!windowCreated) {
		showStartupFailure(error);
	} else {
		console.error(error);
	}
});

// ---- 14: one instance owns the window; a second launch forwards its argv and exits

const gotInstanceLock = app.requestSingleInstanceLock();

function createWindow(): void {
	windowCreated = true;
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
		registerChannels(window, server, store, storage, fileService, initialPaths, updateService!, mainLogService);
	}
});

function main(): void {
	// a second `mini …`: focus the window and hand the argv to its renderer
	app.on('second-instance', (_event, argv, workingDirectory) => {
		const window = BrowserWindow.getAllWindows()[0];
		if (window) {
			if (window.isMinimized()) {
				window.restore();
			}
			window.focus();
		}
		mainLogService.info(`second instance: forwarding ${argv.length} argv entry/ies`);
		sendPathsToWindow(pathsFromArgv(argv, workingDirectory));
	});

	void app.whenReady().then(() => {
		// storage lives in main (one file per scope) — the renderer reads through the channel
		storage = new StorageMainService(app.getPath('userData'));

		// 10: the file stack also lives in main: disk provider + watcher behind the `file` channel
		const diskProvider = new DiskFileSystemProvider();
		diskProvider.setLogger(message => console.log('[file]', message));
		fileService = new FileService();
		fileService.registerProvider('file', diskProvider);
		const watcher = createFileWatcher(changes => fileService.fireFileChanges(changes), message => console.log('[file]', message));
		fileService.setWatcher(watcher);

		// 14: the update loop (a packaged app only; dev runs report themselves unavailable)
		updateService = createUpdateService({ logService: mainLogService, isPackaged: app.isPackaged });
		updateService.start();

		installMenu();
		createWindow();
	}).catch(error => showStartupFailure(error));
}

if (!gotInstanceLock) {
	// another instance is running: `second-instance` in THAT process receives our argv
	app.quit();
} else {
	main();
}

app.on('window-all-closed', () => {
	ipc.dispose();
	app.quit(); // close the window → quit the whole app (incl. on macOS)
});
