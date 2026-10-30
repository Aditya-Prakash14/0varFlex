// src/main/parts/ipc/channels.ts — the main-side channel implementations: log, fileIO, window.

import { BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import { unwatchFile, watchFile } from 'node:fs';
import * as os from 'node:os';
import { Emitter, Event } from '../../../common/base/common/event.js';
import { DisposableStore, toDisposable } from '../../../common/base/common/lifecycle.js';
import { ChannelServer, IServerChannel, ProxyChannel } from '../../../common/base/parts/ipc/ipc.js';
import { ILogChannel } from '../../../common/platform/log/common/logIpc.js';
import { LogLevel } from '../../../common/platform/log/common/log.js';
import { IWindowChannel, IWindowInfo } from '../../../common/platform/window/common/window.js';
import { IWindowContext } from './ipcMain.js';

// --- log: everything the renderer logs lands on main's stdout, tagged once

class LogChannel implements ILogChannel {

	async log(level: LogLevel, message: string): Promise<void> {
		console[level]('[main]', message);
	}
}

// --- window: info and focus events for one BrowserWindow

class WindowChannelService implements IWindowChannel {

	private readonly _onDidChangeFocus = new Emitter<boolean>();

	constructor(private readonly _window: BrowserWindow, store: DisposableStore) {
		store.add(toDisposable(() => this._onDidChangeFocus.dispose()));

		const onFocus = (): void => this._onDidChangeFocus.fire(true);
		const onBlur = (): void => this._onDidChangeFocus.fire(false);
		this._window.on('focus', onFocus);
		this._window.on('blur', onBlur);
		store.add(toDisposable(() => {
			this._window.off('focus', onFocus);
			this._window.off('blur', onBlur);
		}));
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

export function registerChannels(window: BrowserWindow, server: ChannelServer<IWindowContext>, store: DisposableStore): void {
	server.registerChannel('log', ProxyChannel.fromService<IWindowContext>(new LogChannel(), store));
	server.registerChannel('fileIO', new FileIOChannel());
	server.registerChannel('window', ProxyChannel.fromService<IWindowContext>(new WindowChannelService(window, store), store));
}
