// src/common/platform/window/common/window.ts — the window channel: info and focus events.

import { Event } from '../../../base/common/event.js';

export interface IWindowInfo {
	readonly id: number;
	readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	readonly focused: boolean;
}

/** Commands the Electron menu sends to the window's renderer. */
export type WindowMenuCommand = 'toggleSidebar' | 'togglePanel' | 'openSampleFile';

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
	// ---- window close veto (09): main asks, the renderer answers after its dialogs
	onWillCloseWindow: Event<void>;
	resolveClose(allow: boolean): Promise<void>;
	/** ask main to request a close (fires the same flow; the dev hook and tests drive this) */
	requestCloseWindow(): Promise<void>;
	/** the file passed on the command line (`mini-vscode somepath.txt`), or null */
	getOpenedFile(): Promise<string | null>;
}
