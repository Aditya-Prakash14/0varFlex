// src/common/platform/window/common/window.ts — the window channel: info and focus events.

import { Event } from '../../../base/common/event.js';

export interface IWindowInfo {
	readonly id: number;
	readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	readonly focused: boolean;
	/** the app version from package.json (11: `engines.mini-vscode` checks) */
	readonly appVersion: string;
}

/** Commands the Electron menu sends to the window's renderer. */
export type WindowMenuCommand = 'toggleSidebar' | 'togglePanel' | 'openSampleFile' | 'openFolder';

export interface IWindowChannel {
	getInfo(): Promise<IWindowInfo>;
	// the "onSomething" naming convention is what ProxyChannel recognizes as an event
	onDidChangeFocus: Event<boolean>;
	onDidMenuCommand: Event<WindowMenuCommand>;
	toggleFullScreen(): Promise<boolean>;
	isFullScreen(): Promise<boolean>;
	onDidChangeFullScreen: Event<boolean>;
	/** reveals a file in the OS file manager (Finder on macOS) */
	showItemInFolder(path: string): Promise<void>;
	/** the Open Folder picker (10); resolves to the picked folder or null */
	showOpenFolderDialog(options?: { title?: string; defaultPath?: string }): Promise<string | null>;
	// ---- window close veto (09): main asks, the renderer answers after its dialogs
	onWillCloseWindow: Event<void>;
	resolveClose(allow: boolean): Promise<void>;
	/** ask main to request a close (fires the same flow; the dev hook and tests drive this) */
	requestCloseWindow(): Promise<void>;
	/** the file passed on the command line (`mini-vscode somepath.txt`), or null */
	getOpenedFile(): Promise<string | null>;
	/** the app's userData directory (the environment path the renderer needs for settings etc.) */
	getUserDataPath(): Promise<string>;
	// ---- extensions (11)
	/** main scans the builtin + user extension directories (fs lives in main) */
	scanExtensions(): Promise<unknown>;
	/** main forks the utility process and transfers a MessagePort into this renderer */
	startExtensionHost(): Promise<void>;
	/** note: the port carries the RPC; this event only reports the process exit */
	onDidExtensionHostExit: Event<number | undefined>;
	/** Developer: Reload Window — the workbench terminates the host first, then main reloads */
	reloadWindow(): Promise<void>;
}
