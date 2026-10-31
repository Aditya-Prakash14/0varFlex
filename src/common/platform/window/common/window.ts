// src/common/platform/window/common/window.ts — the window channel: info and focus events.

import { Event } from '../../../base/common/event.js';

export interface IWindowInfo {
	readonly id: number;
	readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	readonly focused: boolean;
	/** the app version from package.json (11: `engines.0varflex` checks) */
	readonly appVersion: string;
}

/** Commands the Electron menu sends to the window's renderer. */
export type WindowMenuCommand = 'toggleSidebar' | 'togglePanel' | 'openSampleFile' | 'openFolder';

/** 14: the CLI path kinds + argv decisions (ported shape of the real cli.ts) */
export type WindowCliPathKind = 'file' | 'folder' | 'missing';

export interface IWindowCliPath {
	readonly path: string;
	readonly kind: WindowCliPathKind;
}

/** 14: the About dialog's payload, gathered from the main process (the real About lists these) */
export interface IVersionInfo {
	readonly nameShort: string;
	readonly version: string;
	readonly commit: string;
	readonly date: string;
	readonly electron: string;
	readonly chromium: string;
	readonly node: string;
	readonly v8: string;
	readonly os: string;
}

/** 14: the update state the main-process service reports (a subset of the real state machine) */
export interface IUpdateStateDto {
	readonly type: 'uninitialized' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'updating';
	readonly version?: string;
	readonly error?: string;
	readonly explicit?: boolean;
}

export interface IInstallCommandResult {
	readonly ok: boolean;
	/** the symlink that now points at the CLI script */
	readonly target?: string;
	readonly error?: string;
}

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
	/** the file passed on the command line (`0varflex somepath.txt`), or null */
	getOpenedFile(): Promise<string | null>;
	/** 14: every path the CLI asked to open (files AND folders), from the first launch */
	getInitialPaths(): Promise<readonly IWindowCliPath[]>;
	/** 14: a second `0varflex` launch forwarded its argv here (single-instance) */
	onDidOpenPaths: Event<readonly IWindowCliPath[]>;
	/** 14: `Shell Command: Install '0varflex' command in PATH` (the real installCommandLine action) */
	installShellCommand(): Promise<IInstallCommandResult>;
	/** 14: the About dialog's version list */
	getVersionInfo(): Promise<IVersionInfo>;
	/** 14: Copy in the About dialog — main-process clipboard (no user-gesture requirement) */
	writeClipboardText(text: string): Promise<void>;
	/** 14: the current update state (a renderer reload re-reads it) */
	getUpdateState(): Promise<IUpdateStateDto>;
	onDidChangeUpdateState: Event<IUpdateStateDto>;
	checkForUpdates(explicit: boolean): Promise<IUpdateStateDto>;
	restartToUpdate(): Promise<void>;
	/** the app's userData directory (the environment path the renderer needs for settings etc.) */
	getUserDataPath(): Promise<string>;
	// ---- extensions (11)
	/** main scans the builtin + user extension directories (fs lives in main) */
	scanExtensions(): Promise<unknown>;
	/** main forks the utility process and transfers a MessagePort into this renderer */
	startExtensionHost(): Promise<void>;
	/** note: the port carries the RPC; this event only reports the process exit */
	onDidExtensionHostExit: Event<number | undefined>;
	/** 13: spawn the pty host utility process + transfer its port (same dance as 11) */
	startPtyHost(): Promise<void>;
	/** all terminals die together when this fires (the renderer lazily respawns) */
	onDidPtyHostExit: Event<number | undefined>;
	/** Developer: Reload Window — the workbench terminates the host first, then main reloads */
	reloadWindow(): Promise<void>;
}
