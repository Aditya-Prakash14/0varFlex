// src/main/parts/ipc/channels.ts — the main-side channel implementations: log, file, window.

import { app, BrowserWindow, dialog, shell } from 'electron';
import { Emitter, Event } from '../../../common/base/common/event.js';
import { DisposableStore, toDisposable } from '../../../common/base/common/lifecycle.js';
import { ChannelServer, ProxyChannel } from '../../../common/base/parts/ipc/ipc.js';
import { ILogChannel } from '../../../common/platform/log/common/logIpc.js';
import { LogLevel } from '../../../common/platform/log/common/log.js';
import { FileService } from '../../../common/platform/files/common/fileService.js';
import { createFileServiceWire, IFileServiceWire } from '../../../common/platform/files/common/fileIpc.js';
import { IWindowChannel, IWindowInfo, WindowMenuCommand } from '../../../common/platform/window/common/window.js';
import { ExtensionHostLauncher, scanExtensionsMain } from '../../extensionHost.js';
import type { ILogService } from '../../../common/platform/log/common/log.js';
import type { IExtensionScanResult } from '../../../common/platform/extensions/common/extensionScanner.js';
import { StorageMainService } from '../../../common/platform/storage/common/storageIpc.js';
import { IWindowContext } from './ipcMain.js';

// --- log: everything the renderer logs lands on main's stdout, tagged once

class LogChannel implements ILogChannel {

	async log(level: LogLevel, message: string): Promise<void> {
		if (level === 'trace') {
			// trace stays in the renderer's dev console — main's stdout keeps info+
			return;
		}
		console[level]('[main]', message);
	}
}

// --- window: info and focus events for one BrowserWindow

class WindowChannelService implements IWindowChannel {

	private readonly _onDidChangeFocus = new Emitter<boolean>();
	/** menu commands are fired by the Electron menu (see sendMenuCommand) */
	private readonly _onMenuCommand = new Emitter<WindowMenuCommand>();
	private readonly _onDidChangeFullScreen = new Emitter<boolean>();
	private readonly _onWillCloseWindow = new Emitter<void>();

	/** set once the renderer allowed the close (or the watchdog did) */
	private _closeAllowed = false;
	private _closeWatchdog: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly _window: BrowserWindow, store: DisposableStore, private readonly _openedFile: string | null, private readonly _logService: ILogService) {
		store.add(toDisposable(() => this._onDidChangeFocus.dispose()));
		store.add(toDisposable(() => this._onMenuCommand.dispose()));
		store.add(toDisposable(() => this._onDidChangeFullScreen.dispose()));
		store.add(toDisposable(() => this._onWillCloseWindow.dispose()));
		store.add(toDisposable(() => {
			if (this._closeWatchdog !== undefined) {
				clearTimeout(this._closeWatchdog);
			}
		}));

		// ---- the close veto: intercept `close`, ask the renderer, destroy only on a yes.
		// The watchdog (2s) covers a hung/crashed renderer — same idea as the real main
		// process's hung-renderer handling: never trap the user in an unclosable window.
		this._window.on('close', (event: Electron.Event) => {
			if (this._closeAllowed) {
				return;
			}
			event.preventDefault();
			this._onWillCloseWindow.fire();
			if (this._closeWatchdog === undefined) {
				this._closeWatchdog = setTimeout(() => void this.resolveClose(true), 2000);
			}
		});

		const onFocus = (): void => this._onDidChangeFocus.fire(true);
		const onBlur = (): void => this._onDidChangeFocus.fire(false);
		this._window.on('focus', onFocus);
		this._window.on('blur', onBlur);

		const onEnterFullScreen = (): void => this._onDidChangeFullScreen.fire(true);
		const onLeaveFullScreen = (): void => this._onDidChangeFullScreen.fire(false);
		this._window.on('enter-full-screen', onEnterFullScreen);
		this._window.on('leave-full-screen', onLeaveFullScreen);

		store.add(toDisposable(() => {
			this._window.off('focus', onFocus);
			this._window.off('blur', onBlur);
			this._window.off('enter-full-screen', onEnterFullScreen);
			this._window.off('leave-full-screen', onLeaveFullScreen);
		}));

		// the extension host belongs to this window: killing it on navigation/close is what keeps
		// five reloads from accumulating utility processes
		store.add(toDisposable(() => this._extHostLauncher.kill()));

		// this window's service is the routing target for menu commands
		windowServices.set(this._window.id, this);
		store.add(toDisposable(() => windowServices.delete(this._window.id)));
	}

	async getInfo(): Promise<IWindowInfo> {
		return {
			id: this._window.id,
			bounds: this._window.getBounds(),
			focused: this._window.isFocused(),
			appVersion: app.getVersion()
		};
	}

	get onDidChangeFocus(): Event<boolean> {
		return this._onDidChangeFocus.event;
	}

	get onDidMenuCommand(): Event<WindowMenuCommand> {
		return this._onMenuCommand.event;
	}

	async toggleFullScreen(): Promise<boolean> {
		this._window.setFullScreen(!this._window.isFullScreen());
		return this._window.isFullScreen();
	}

	async isFullScreen(): Promise<boolean> {
		return this._window.isFullScreen();
	}

	async showItemInFolder(path: string): Promise<void> {
		shell.showItemInFolder(path);
	}

	// ---- the extension host (11): one utility process per window, port-transferred to the renderer

	private readonly _extHostLauncher: ExtensionHostLauncher =
		new ExtensionHostLauncher(() => this._window.webContents);

	/** 10: the Open Folder picker (ported from IFileDialogService.showOpenDialog) */
	async showOpenFolderDialog(options?: { title?: string; defaultPath?: string }): Promise<string | null> {
		const result = await dialog.showOpenDialog(this._window, {
			title: options?.title ?? 'Open Folder',
			defaultPath: options?.defaultPath,
			properties: ['openDirectory', 'createDirectory']
		});
		return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
	}

	get onDidChangeFullScreen(): Event<boolean> {
		return this._onDidChangeFullScreen.event;
	}

	get onWillCloseWindow(): Event<void> {
		return this._onWillCloseWindow.event;
	}

	async resolveClose(allow: boolean): Promise<void> {
		if (this._closeWatchdog !== undefined) {
			clearTimeout(this._closeWatchdog);
			this._closeWatchdog = undefined;
		}
		if (!allow) {
			// the renderer cancelled (a dialog): the window stays; a later close asks again
			return;
		}
		this._closeAllowed = true;
		this._window.close();
	}

	async requestCloseWindow(): Promise<void> {
		this._window.close();
	}

	async getOpenedFile(): Promise<string | null> {
		return this._openedFile;
	}

	async getUserDataPath(): Promise<string> {
		return app.getPath('userData');
	}

	async scanExtensions(): Promise<IExtensionScanResult> {
		return scanExtensionsMain(this._logService);
	}

	async startExtensionHost(): Promise<void> {
		this._extHostLauncher.start();
	}

	get onDidExtensionHostExit(): Event<number | undefined> {
		return this._extHostLauncher.onDidExit;
	}

	async reloadWindow(): Promise<void> {
		this._window.webContents.reload();
	}

	fireMenuCommand(command: WindowMenuCommand): void {
		this._onMenuCommand.fire(command);
	}
}

// --- registration: called once per window when its IPC server comes up

/** window id → the window's service, so the app menu can route commands. */
const windowServices = new Map<number, WindowChannelService>();

/** Send a menu command to the focused window's renderer (no-op if no window is served yet). */
export function sendMenuCommand(command: WindowMenuCommand): void {
	const window = BrowserWindow.getFocusedWindow();
	if (!window) {
		return;
	}
	windowServices.get(window.id)?.fireMenuCommand(command);
}

export function registerChannels(window: BrowserWindow, server: ChannelServer<IWindowContext>, store: DisposableStore, storage: StorageMainService, fileService: FileService, openedFile: string | null, logService: ILogService): void {
	server.registerChannel('log', ProxyChannel.fromService<IWindowContext>(new LogChannel(), store));
	// 10: ONE `file` channel replaces 02's hand-written fileIO channel — the FileService runs in
	// main (disk provider + watcher) and the renderer gets the proxied wire shape
	void logService;
	const fileWire = createFileServiceWire(fileService);
	store.add(toDisposable(() => fileWire.dispose()));
	server.registerChannel('file', ProxyChannel.fromService<IWindowContext>(fileWire.service, store));
	server.registerChannel('window', ProxyChannel.fromService<IWindowContext>(new WindowChannelService(window, store, openedFile, logService), store));
	// storage is app-level (not per window), but it rides the window's channel server
	server.registerChannel('storage', storage);
}
