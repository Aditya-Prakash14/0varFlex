// src/ptyHost/terminalProcess.ts — the node-pty wrapper, ported in shape from
// vs/platform/terminal/node/terminalProcess.ts:
//
//   - spawn with `name: 'xterm-256color'`, the curated env and the fitted dimensions;
//   - raw data → flow control accounting (pause past 100k unacknowledged) → fire; the batching
//     to 5ms frames happens one layer up (ptyService), exactly like the reference's localPty;
//   - ready heuristic (delta): ready on the first data chunk (real inspects the prompt);
//   - kill(): SIGTERM, then SIGKILL after the grace; guarded on the exited flag
//     (`kill()` on an exited pty throws in node-pty);
//   - resize swallows the "already exited" error (the reference does the same).

import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { spawn, IPty } from 'node-pty';
import { Emitter, Event } from '../common/base/common/event.js';
import { Disposable } from '../common/base/common/lifecycle.js';
import { FlowControlState } from '../common/platform/terminal/common/terminalDataBuffering.js';
import {
	formatMessageForTerminal,
	ICreateProcessOptions,
	sanitizePtyEnv,
	resolveDefaultShell,
	KILL_GRACE_MS
} from '../common/platform/terminal/common/terminal.js';

export class TerminalProcess extends Disposable {

	private _pty: IPty | undefined;
	private _pid = -1;
	private _exited = false;
	private _ready = false;
	private _killTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly _flow = new FlowControlState();

	private readonly _onData = this._register(new Emitter<string>());
	readonly onData: Event<string> = this._onData.event;
	private readonly _onReady = this._register(new Emitter<void>());
	readonly onReady: Event<void> = this._onReady.event;
	private readonly _onExit = this._register(new Emitter<{ exitCode: number; signal?: number }>());
	readonly onExit: Event<{ exitCode: number; signal?: number }> = this._onExit.event;

	constructor(private readonly _options: ICreateProcessOptions, private readonly _log: (message: string) => void) {
		super();
	}

	get pid(): number {
		return this._pid;
	}

	get hasExited(): boolean {
		return this._exited;
	}

	start(): void {
		const env = sanitizePtyEnv(this._options.env ?? process.env, process.env.MINI_VSCODE_VERSION ?? '0.0.0');
		const shell = this._options.shell ?? resolveDefaultShell(env);
		const args = [...(this._options.shellArgs ?? [])];
		const cwd = this._options.cwd && this._options.cwd.length > 0 ? this._options.cwd : os.homedir();

		const pty = spawn(shell, args, {
			name: 'xterm-256color',
			cols: Math.max(1, this._options.cols),
			rows: Math.max(1, this._options.rows),
			cwd,
			env
		});
		this._pty = pty;
		this._pid = pty.pid;

		pty.onData(data => {
			if (this._flow.sent(data.length)) {
				this._log(`Flow control: Pause (${this._flow.unacknowledgedChars} > ${100_000})`);
				pty.pause();
			}
			this._onData.fire(data);
			if (!this._ready && data.length > 0) {
				// shortcut: ready on first data — the real one matches shell prompt markers
				this._ready = true;
				this._onReady.fire();
			}
		});
		pty.onExit(event => {
			this._exited = true;
			if (this._killTimer !== undefined) {
				clearTimeout(this._killTimer);
				this._killTimer = undefined;
			}
			this._onExit.fire({ exitCode: event.exitCode, signal: event.signal });
		});
	}

	/** the renderer parsed `charCount` chars: below the low watermark the pty resumes */
	acknowledgeData(charCount: number): void {
		if (this._flow.ack(charCount)) {
			this._log(`Flow control: Resume (${this._flow.unacknowledgedChars} < ${5_000})`);
			this._pty?.resume();
		}
	}

	write(data: string): void {
		if (this._exited) {
			return;
		}
		this._pty?.write(data);
	}

	resize(cols: number, rows: number): void {
		try {
			this._pty?.resize(Math.max(1, cols), Math.max(1, rows));
		} catch (error) {
			// the pty may have exited between the renderer's fit and this call
			if (!(error as Error).message?.includes('already exited')) {
				this._log(`resize failed: ${(error as Error).message}`);
			}
		}
	}

	/** SIGTERM, then SIGKILL after the grace — node-pty's kill() takes the signal */
	kill(): void {
		if (this._exited || !this._pty) {
			return;
		}
		try {
			this._pty.kill('SIGTERM');
		} catch { /* already gone */ }
		if (this._killTimer === undefined) {
			this._killTimer = setTimeout(() => {
				this._killTimer = undefined;
				if (!this._exited) {
					try {
						this._pty?.kill('SIGKILL');
					} catch { /* already gone */ }
				}
			}, KILL_GRACE_MS);
		}
	}

	/** the lazy child-process check behind confirmOnKill (real: ChildProcessMonitor) */
	hasChildProcesses(): boolean {
		if (this._exited || this._pid <= 0) {
			return false;
		}
		try {
			// shortcut: one synchronous ps scan on demand — the real one monitors continuously
			const output = execFileSync('ps', ['-A', '-o', 'ppid='], { encoding: 'utf8' });
			return output.split(/\s+/).includes(String(this._pid));
		} catch {
			return false;
		}
	}

	override dispose(): void {
		this.kill();
		super.dispose();
	}
}

export { formatMessageForTerminal };
