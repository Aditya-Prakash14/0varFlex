// src/ptyHost/ptyService.ts — the process registry + lifecycle, ported in shape from
// vs/platform/terminal/node/ptyService.ts:
//
//   - `createProcess` records the launch options and hands back an id (the renderer has not
//     fitted the terminal yet); `start(id)` spawns the pty with the fitted dimensions — this is
//     the ported order that fixes the classic "zsh swallows the first prompt" bug;
//   - data flows pty → TerminalDataBufferer (5ms frames) → the onProcessData event;
//   - `shutdown(id)` kills one, `dispose()` kills all (the host survives);
//   - logs go to stderr: the main process inherits them (the app log carries the flow-control
//     transitions the acceptance greps).

import * as path from 'node:path';
import { Emitter, Event } from '../common/base/common/event.js';
import { Disposable } from '../common/base/common/lifecycle.js';
import { TerminalDataBufferer } from '../common/platform/terminal/common/terminalDataBuffering.js';
import {
	ICreateProcessOptions,
	ICreateProcessResult,
	IProcessExitEvent,
	IPtyHostProcessDataEvent,
	sanitizePtyEnv,
	resolveDefaultShell
} from '../common/platform/terminal/common/terminal.js';
import { TerminalProcess } from './terminalProcess.js';

interface IPtyRecord {
	readonly options: ICreateProcessOptions;
	process: TerminalProcess | undefined;
}

export class PtyService extends Disposable {

	private _lastId = 0;
	private readonly _records = new Map<number, IPtyRecord>();
	private readonly _bufferer = new TerminalDataBufferer((id, data) => this._onProcessData.fire({ id, data }));

	private readonly _onProcessData = this._register(new Emitter<IPtyHostProcessDataEvent>());
	readonly onProcessData: Event<IPtyHostProcessDataEvent> = this._onProcessData.event;
	private readonly _onProcessReady = this._register(new Emitter<number>());
	readonly onProcessReady: Event<number> = this._onProcessReady.event;
	private readonly _onProcessExit = this._register(new Emitter<IProcessExitEvent>());
	readonly onProcessExit: Event<IProcessExitEvent> = this._onProcessExit.event;

	private _log(message: string): void {
		process.stderr.write(`[ptyHost] ${message}\n`);
	}

	createProcess(options: ICreateProcessOptions): ICreateProcessResult {
		const id = ++this._lastId;
		this._records.set(id, { options, process: undefined });
		const env = sanitizePtyEnv(options.env ?? process.env, process.env.MINI_VSCODE_VERSION ?? '0.0.0');
		const shell = options.shell ?? resolveDefaultShell(env);
		const cwd = options.cwd && options.cwd.length > 0 ? options.cwd : env.HOME ?? '';
		this._log(`createProcess ${id}: ${shell} (${options.cols}x${options.rows})`);
		return { id, shellName: path.basename(shell), cwd };
	}

	start(id: number): void {
		const record = this._records.get(id);
		if (!record || record.process) {
			return;
		}
		const terminal = new TerminalProcess(record.options, message => this._log(`#${id} ${message}`));
		record.process = terminal;
		// the 5ms batching sits between the pty and the wire (the reference's localPty layer)
		this._register(this._bufferer.startBuffering(id, terminal.onData));
		this._register(terminal.onReady(() => this._onProcessReady.fire(id)));
		this._register(terminal.onExit(event => this._onProcessExit.fire({ id, exitCode: event.exitCode, signal: event.signal })));
		terminal.start();
	}

	input(id: number, data: string): void {
		this._records.get(id)?.process?.write(data);
	}

	ackData(id: number, charCount: number): void {
		this._records.get(id)?.process?.acknowledgeData(charCount);
	}

	resize(id: number, cols: number, rows: number): void {
		this._records.get(id)?.process?.resize(cols, rows);
	}

	shutdown(id: number): void {
		const record = this._records.get(id);
		if (!record) {
			return;
		}
		this._records.delete(id);
		this._bufferer.stopBuffering(id);
		if (record.process) {
			record.process.dispose();
			this._log(`shutdown ${id}`);
		}
	}

	hasChildProcesses(id: number): boolean {
		return this._records.get(id)?.process?.hasChildProcesses() ?? false;
	}

	/** kills every process; the host process itself stays alive (a fresh create spawns again) */
	dispose(): void {
		for (const id of [...this._records.keys()]) {
			this.shutdown(id);
		}
		this._bufferer.dispose();
		super.dispose();
	}
}
