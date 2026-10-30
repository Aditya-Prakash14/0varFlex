// src/main/parts/ipc/channels.ts — the main-side channel implementations: log, fileIO, window.

import { app, BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import { unwatchFile, watchFile } from 'node:fs';
import * as os from 'node:os';
import { Emitter, Event } from '../../../common/base/common/event.js';
import { DisposableStore, toDisposable } from '../../../common/base/common/lifecycle.js';
import { ChannelServer, IServerChannel, ProxyChannel } from '../../../common/base/parts/ipc/ipc.js';
import { ILogChannel } from '../../../common/platform/log/common/logIpc.js';
import { LogLevel } from '../../../common/platform/log/common/log.js';
import { IWindowChannel, IWindowInfo, WindowMenuCommand } from '../../../common/platform/window/common/window.js';
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

	constructor(private readonly _window: BrowserWindow, store: DisposableStore) {
		store.add(toDisposable(() => this._onDidChangeFocus.dispose()));
		store.add(toDisposable(() => this._onMenuCommand.dispose()));
		store.add(toDisposable(() => this._onDidChangeFullScreen.dispose()));

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

		// this window's service is the routing target for menu commands
		windowServices.set(this._window.id, this);
		store.add(toDisposable(() => windowServices.delete(this._window.id)));
	}

	async getInfo(): Promise<IWindowInfo> {
		return {
			id: this._window.id,
			bounds: this._window.getBounds(),
			focused: this._window.isFocused()
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

	get onDidChangeFullScreen(): Event<boolean> {
		return this._onDidChangeFullScreen.event;
	}

	fireMenuCommand(command: WindowMenuCommand): void {
		this._onMenuCommand.fire(command);
	}
}

// --- fileIO: read/write/exists plus a per-path "watch-lite" event

class FileIOChannel implements IServerChannel<IWindowContext> {

	async call<T>(_ctx: IWindowContext, command: string, arg?: unknown[]): Promise<T> {
		const args = arg ?? [];
		let result: unknown;
		switch (command) {
			case 'readTextFile':
				result = await readTextFile(args[0] as string);
				break;
			case 'writeTextFile':
				await fs.writeFile(args[0] as string, args[1] as string, 'utf8');
				break;
			case 'exists':
				result = await fileExists(args[0] as string);
				break;
			case 'getHomePath':
				result = os.homedir();
				break;
			case 'getUserDataPath':
				result = app.getPath('userData');
				break;
			default:
				throw new Error(`Unknown channel command: ${command}`);
		}
		return result as T;
	}

	listen<T>(_ctx: IWindowContext, event: string, arg: string): Event<T> {
		if (event === 'onDidChangeFile') {
			return watchPath(arg) as unknown as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}
}

async function readTextFile(path: string): Promise<string | null> {
	try {
		return await fs.readFile(path, 'utf8');
	} catch {
		return null;
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}

// shortcut: fs.watchFile polling ("watch-lite", on purpose) — the real file watcher arrives in
// exercise 10; upgrade when latency/reliability matters
function watchPath(path: string): Event<void> {
	return (listener, thisArgs, disposables) => {
		const onChange = (): void => {
			listener.call(thisArgs, undefined);
		};
		watchFile(path, { interval: 400 }, onChange);
		return toDisposable(() => unwatchFile(path, onChange));
	};
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

export function registerChannels(window: BrowserWindow, server: ChannelServer<IWindowContext>, store: DisposableStore): void {
	server.registerChannel('log', ProxyChannel.fromService<IWindowContext>(new LogChannel(), store));
	server.registerChannel('fileIO', new FileIOChannel());
	server.registerChannel('window', ProxyChannel.fromService<IWindowContext>(new WindowChannelService(window, store), store));
}
