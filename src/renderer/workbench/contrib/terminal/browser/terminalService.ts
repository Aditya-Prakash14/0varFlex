// src/renderer/workbench/contrib/terminal/browser/terminalService.ts — instances, the active
// one, the lifecycle events and the channel client to the pty host, ported in shape from
// vs/workbench/contrib/terminal/browser/terminalService.ts +
// services/terminal/browser/terminalService.ts:
//
//   - the port arrives through the preload (the 11 dance); the pty host's service is proxied
//     over 02's channels, events included;
//   - when the pty host dies, every instance is marked dead with the real message; the next
//     `createProcess` lazily respawns the host (real restores sessions — delta).

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { Disposable } from '../../../../../common/base/common/lifecycle.js';
import { ChannelClient, IMessagePassingProtocol, ProxyChannel } from '../../../../../common/base/parts/ipc/ipc.js';
import type { IConfigurationService } from '../../../../../common/platform/configuration/common/configuration.js';
import type { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import type { IWindowChannel } from '../../../../../common/platform/window/common/window.js';
import type { ILogService } from '../../../../../common/platform/log/common/log.js';
import type { URI } from '../../../../../common/base/common/uri.js';
import type { KeybindingService } from '../../../../platform/keybinding/browser/keybindingService.js';
import {
	ICreateProcessResult,
	IProcessExitEvent,
	IPtyHostProcessDataEvent,
	IPtyHostService,
	PTY_HOST_CHANNEL
} from '../../../../../common/platform/terminal/common/terminal.js';
import { TerminalInstance } from './terminalInstance.js';

/** the preload's surface for the pty host port (see src/preload/preload.ts) */
interface IPtyHostPreloadBridge {
	requestPort(): Promise<void>;
	send(message: unknown): void;
	onMessage(handler: (message: unknown) => void): void;
	onExit(handler: (code: number | undefined) => void): void;
}

function bridge(): IPtyHostPreloadBridge {
	return (window as unknown as { host: { ptyHost: IPtyHostPreloadBridge } }).host.ptyHost;
}

class PtyHostProtocol implements IMessagePassingProtocol {

	private readonly _onMessage = new Emitter<unknown>();
	readonly onMessage: Event<unknown> = this._onMessage.event;
	private readonly _bridge = bridge();

	constructor() {
		this._bridge.onMessage(message => this._onMessage.fire(message));
	}

	send(message: unknown): void {
		try {
			this._bridge.send(message);
		} catch {
			// the host is gone — drop silently
		}
	}
}

export interface ITerminalServiceOptions {
	readonly windowChannel: IWindowChannel;
	readonly configuration: IConfigurationService;
	readonly contextKeyService: IContextKeyService;
	readonly logService: ILogService;
	/** the ported key rule asks the resolver whether a command claims a keypress */
	readonly keybindingService: KeybindingService;
	/** the terminal's initial cwd (the workspace folder, like the real workbench) */
	readonly getCwd: () => URI | undefined;
}

export const PTY_HOST_DIED_MESSAGE = `The terminal's pty host process exited, the connection to all terminal processes was lost`;

export class TerminalService extends Disposable {

	private _host: IPtyHostService | undefined;
	private _starting: Promise<void> | undefined;
	private _hostDead = false;

	private readonly _instances: TerminalInstance[] = [];
	private _active: TerminalInstance | null = null;

	private readonly _onDidOpenTerminal = this._register(new Emitter<TerminalInstance>());
	readonly onDidOpenTerminal: Event<TerminalInstance> = this._onDidOpenTerminal.event;
	private readonly _onDidCloseTerminal = this._register(new Emitter<TerminalInstance>());
	readonly onDidCloseTerminal: Event<TerminalInstance> = this._onDidCloseTerminal.event;
	private readonly _onDidChangeActiveTerminal = this._register(new Emitter<TerminalInstance | null>());
	readonly onDidChangeActiveTerminal: Event<TerminalInstance | null> = this._onDidChangeActiveTerminal.event;
	private readonly _onDidChangeInstanceTitle = this._register(new Emitter<TerminalInstance>());
	readonly onDidChangeInstanceTitle: Event<TerminalInstance> = this._onDidChangeInstanceTitle.event;

	/** A2-3: raw pty streams, for consumers without a terminal UI (the task system) */
	private readonly _onProcessData = this._register(new Emitter<IPtyHostProcessDataEvent>());
	readonly onProcessData: Event<IPtyHostProcessDataEvent> = this._onProcessData.event;
	private readonly _onProcessExit = this._register(new Emitter<IProcessExitEvent>());
	readonly onProcessExit: Event<IProcessExitEvent> = this._onProcessExit.event;

	constructor(private readonly _options: ITerminalServiceOptions) {
		super();
		// the exit event tells the renderer all terminals died (the port itself is dead then)
		bridge().onExit(() => this._handleHostExit());
	}

	get instances(): readonly TerminalInstance[] {
		return this._instances;
	}

	get activeInstance(): TerminalInstance | null {
		return this._active;
	}

	setActive(instance: TerminalInstance | null): void {
		if (this._active === instance) {
			return;
		}
		this._active = instance;
		this._onDidChangeActiveTerminal.fire(instance);
	}

	getInstance(id: number): TerminalInstance | undefined {
		return this._instances.find(candidate => candidate.id === id);
	}

	/** fork + port transfer + the proxied service; lazily respawns after a host death */
	private async ensureHost(): Promise<IPtyHostService> {
		if (this._host && !this._hostDead) {
			return this._host;
		}
		if (!this._starting) {
			this._starting = (async () => {
				const portArrived = bridge().requestPort();
				await this._options.windowChannel.startPtyHost();
				await portArrived;

				const client = new ChannelClient(new PtyHostProtocol());
				const host = ProxyChannel.toService<IPtyHostService>(client.getChannel(PTY_HOST_CHANNEL));
				// data routing happens through the collected events (the ported channel shape)
				host.onProcessData(event => {
					this.getInstance(event.id)?.acceptData(event.data, this);
					// A2-3: processes without a UI instance (tasks) listen here. The routing above
					// assumed every process had a terminal attached; a task's output would
					// otherwise be dropped on the floor.
					this._onProcessData.fire(event);
				});
				host.onProcessReady(id => this.getInstance(id)?.acceptReady());
				host.onProcessExit(event => {
					this.getInstance(event.id)?.acceptExit(event.exitCode, this);
					this._onProcessExit.fire(event);
				});
				this._host = host;
				this._hostDead = false;
			})().catch(error => {
				this._starting = undefined;
				throw error;
			});
		}
		await this._starting;
		return this._host!;
	}

	/** the renderer has NOT fitted the terminal yet: the caller passes the fitted size (the
	 * ported order that keeps zsh from swallowing its first prompt) */
	async createProcess(cols: number, rows: number, overrides?: { shell?: string; shellArgs?: readonly string[]; cwd?: string }): Promise<ICreateProcessResult> {
		const host = await this.ensureHost();
		// A2-3: a task spawns its command DIRECTLY instead of a shell, so its exit code is the
		// task's exit code rather than the shell's. ICreateProcessOptions already carried
		// shell/shellArgs/cwd, so the pty host needed no change at all.
		const cwd = overrides?.cwd ?? this._options.getCwd()?.fsPath;
		return host.$createProcess({
			cols,
			rows,
			cwd,
			shell: overrides?.shell,
			shellArgs: overrides?.shellArgs
		});
	}

	async start(id: number): Promise<void> {
		const host = await this.ensureHost();
		await host.$start(id);
	}

	input(id: number, data: string): void {
		void this._host?.$input(id, data).catch(() => { /* host gone */ });
	}

	/** the ack protocol: chars the renderer PARSED (the xterm write callback), batched at 5k */
	ackData(id: number, charCount: number): void {
		void this._host?.$ackData(id, charCount).catch(() => { /* host gone */ });
	}

	resize(id: number, cols: number, rows: number): void {
		void this._host?.$resize(id, cols, rows).catch(() => { /* host gone */ });
	}

	async shutdown(id: number): Promise<void> {
		await this._host?.$shutdown(id).catch(() => { /* host gone */ });
	}

	async hasChildProcesses(id: number): Promise<boolean> {
		return (await this._host?.$hasChildProcesses(id).catch(() => false)) ?? false;
	}

	async createTerminal(): Promise<TerminalInstance> {
		// the id arrives with the first fit; the instance is created (and the tab shown) first
		const instance = new TerminalInstance(this, this._options);
		this._instances.push(instance);
		this._register(instance);
		// the instance re-labels its tab when the shell name resolves (or on exit)
		this._register(instance.onDidChangeTitle(() => this._onDidChangeInstanceTitle.fire(instance)));
		this._onDidOpenTerminal.fire(instance);
		return instance;
	}

	async removeInstance(instance: TerminalInstance): Promise<void> {
		if (instance.id !== undefined) {
			await this.shutdown(instance.id);
		}
		const index = this._instances.indexOf(instance);
		if (index !== -1) {
			this._instances.splice(index, 1);
		}
		if (this._active === instance) {
			// ported neighbor-selection: the next instance, else the previous one
			this.setActive(this._instances[Math.min(index, this._instances.length - 1)] ?? null);
		}
		this._onDidCloseTerminal.fire(instance);
	}

	private _handleHostExit(): void {
		if (this._hostDead) {
			return;
		}
		this._hostDead = true;
		this._host = undefined;
		this._starting = undefined;
		this._options.logService.error(PTY_HOST_DIED_MESSAGE);
		for (const instance of [...this._instances]) {
			instance.acceptHostDied(PTY_HOST_DIED_MESSAGE, this);
		}
	}

	override dispose(): void {
		for (const instance of [...this._instances]) {
			instance.dispose();
		}
		this._instances.length = 0;
		super.dispose();
	}
}
