// src/common/platform/terminal/common/terminal.ts — the terminal channel surface + constants,
// ported in shape from vs/platform/terminal/common/terminal.ts + localPtyChannel.ts:
//
//   - the pty host serves `$createProcess/$start/$input/$ackData/$resize/$shutdown` and the
//     `onProcessData/onProcessReady/onProcessExit` events over the proxy channel;
//   - FlowControlConstants are the REAL values (verified against the reference revision):
//     pause the pty above 100k unacknowledged chars, resume below 5k, ack every 5k;
//   - the data batch throttle is the one `TerminalDataBufferer.startBuffering` defaults to (5ms):
//     without it `yes` floods the IPC.

import { Event } from '../../../base/common/event.js';

export interface IProcessEnvironment {
	[key: string]: string | undefined;
}

/** the real product id streaming into the shell */
export const TERM_PROGRAM = 'mini-vscode';

export interface ICreateProcessOptions {
	/** undefined → the pty host resolves the user's shell ($SHELL, /bin/zsh fallback) */
	readonly shell?: string;
	readonly shellArgs?: readonly string[];
	readonly cwd?: string;
	/** undefined → the pty host builds a curated env from its own process.env */
	readonly env?: IProcessEnvironment;
	readonly cols: number;
	readonly rows: number;
}

export interface ICreateProcessResult {
	readonly id: number;
	/** the shell basename the host resolved (the tab title, real: profile name) */
	readonly shellName: string;
	readonly cwd: string;
}

export interface IPtyHostProcessDataEvent {
	readonly id: number;
	readonly data: string;
}

export interface IProcessExitEvent {
	readonly id: number;
	readonly exitCode: number;
	readonly signal?: number;
}

/** the ipc channel the pty host serves (ported from localPtyChannel.ts) */
export interface IPtyHostService {
	$createProcess(options: ICreateProcessOptions): Promise<ICreateProcessResult>;
	$start(id: number): Promise<void>;
	$input(id: number, data: string): Promise<void>;
	$ackData(id: number, charCount: number): Promise<void>;
	$resize(id: number, cols: number, rows: number): Promise<void>;
	$shutdown(id: number): Promise<void>;
	/** kills every process (the host stays alive for new ones) */
	$dispose(): Promise<void>;
	/** the lazy `ps` check behind the confirm-on-kill dialog */
	$hasChildProcesses(id: number): Promise<boolean>;
	readonly onProcessData: Event<IPtyHostProcessDataEvent>;
	readonly onProcessReady: Event<number>;
	readonly onProcessExit: Event<IProcessExitEvent>;
}

export const PTY_HOST_CHANNEL = 'ptyHost';

/** ported verbatim (verified: 100_000 / 5_000 / 5_000) */
export const enum FlowControlConstants {
	HighWatermarkChars = 100_000,
	LowWatermarkChars = 5_000,
	CharCountAckSize = 5_000
}

/** `TerminalDataBufferer.startBuffering`'s default throttle (5ms) */
export const DATA_BUFFER_THROTTLE_MS = 5;

/** resize propagation is debounced while the panel sash is dragged (real debounces the fit) */
export const RESIZE_DEBOUNCE_MS = 100;

/** the kill grace: SIGTERM, then SIGKILL after this (real keeps a close timeout too) */
export const KILL_GRACE_MS = 2_000;

/**
 * The env curation the exercise calls out: start from a source env, drop the host's injected
 * vars (Electron/NODE_OPTIONS would make every shell rc spawn a nested runtime), stamp TERM*,
 * and keep PATH byte-for-byte (a missing PATH breaks every shell rc).
 */
export function sanitizePtyEnv(source: IProcessEnvironment, appVersion: string): IProcessEnvironment {
	const env: IProcessEnvironment = { ...source };
	// the host's own injected variables must not leak into the user's shell
	delete env.NODE_OPTIONS;
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.ELECTRON_ENABLE_LOGGING;
	delete env.ELECTRON_NO_ATTACH_CONSOLE;
	delete env.MINI_VSCODE_VERSION;
	delete env.VSCODE_IPC_HOOK;
	delete env.VSCODE_NLS_CONFIG;
	env.TERM_PROGRAM = TERM_PROGRAM;
	env.TERM_PROGRAM_VERSION = appVersion;
	if (!env.TERM) {
		env.TERM = 'xterm-256color';
	}
	// PATH stays verbatim — deleting it is the classic "every command is missing" bug
	return env;
}

/** the user's shell: $SHELL, else the platform default (real resolves profiles; delta) */
export function resolveDefaultShell(env: IProcessEnvironment): string {
	if (env.SHELL && env.SHELL.length > 0) {
		return env.SHELL;
	}
	return process.platform === 'win32' ? (env.COMSPEC ?? 'cmd.exe') : '/bin/zsh';
}

/** the dim " * message " banner the real workbench writes into the buffer */
export function formatMessageForTerminal(message: string, options: { excludeLeadingNewLine?: boolean; loudFormatting?: boolean } = {}): string {
	let result = '';
	if (!options.excludeLeadingNewLine) {
		result += '\r\n';
	}
	result += '\x1b[0m\x1b[7m * ';
	result += options.loudFormatting ? '\x1b[0;104m' : '\x1b[0m';
	result += ` ${message} \x1b[0m\n\r`;
	return result;
}
