// src/extHost/extHostDebug.ts — the host half of the debug API, ported in subset from
// vs/workbench/api/common/extHostDebugService.ts:
//
//   - `registerDebugAdapterDescriptorFactory(type, factory)` is the only way an adapter gets
//     into the system, exactly as in the real API: the workbench knows no debugger;
//   - starting a session asks the factory for an executable descriptor, spawns it, and speaks
//     the DAP base protocol over its stdio using the SHARED framing module (the same reader the
//     LSP client uses — see messageFraming.ts);
//   - requests are correlated by DAP `seq`; `event` messages are forwarded to the workbench,
//     which owns the conversation.
//
// delta: no DebugAdapterServer/InlineImplementation descriptors (executable only), no
// `registerDebugConfigurationProvider` / launch.json resolution, no `onDidReceiveDebugSessionCustomEvent`
// beyond the plain event forward, no multi-root config resolution.
//
// shortcut: one adapter process per session with no restart; a dead adapter terminates the
// session rather than being respawned.

import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { encodeMessage, MessageReader } from '../common/base/parts/protocol/common/messageFraming.js';
import type { IWireDebugConfiguration, IWireDebugResponse } from '../common/platform/extensions/common/extensionHostProtocol.js';
import type { IMainThreadDebug } from './mainThreadTypes.js';
import { Disposable, EventEmitter } from './extHostTypes.js';

/** what a factory returns: how to launch the adapter */
export interface IDebugAdapterExecutable {
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
}

export interface IDebugAdapterDescriptorFactory {
	createDebugAdapterDescriptor(session: { id: string; type: string; name: string; configuration: unknown }): IDebugAdapterExecutable | undefined | Promise<IDebugAdapterExecutable | undefined>;
}

interface IPendingRequest {
	resolve(response: IWireDebugResponse): void;
	reject(error: Error): void;
}

class DebugAdapterSession {

	private readonly _reader = new MessageReader();
	private readonly _pending = new Map<number, IPendingRequest>();
	private _seq = 1;
	private _closed = false;

	constructor(
		readonly sessionId: string,
		readonly type: string,
		readonly name: string,
		private readonly _child: ChildProcessWithoutNullStreams,
		private readonly _onEvent: (event: string, body: unknown) => void,
		private readonly _onClosed: () => void,
		private readonly _onLog: (message: string) => void
	) {
		this._child.stdout.on('data', (chunk: Buffer) => this._onData(chunk));
		this._child.stderr.setEncoding('utf8');
		this._child.stderr.on('data', (chunk: string) => this._onLog(`debug adapter stderr: ${chunk.trim()}`));
		this._child.on('error', error => {
			this._onLog(`debug adapter failed: ${(error as Error).message}`);
			this._close();
		});
		this._child.on('close', () => this._close());
	}

	private _onData(chunk: Buffer): void {
		let messages: unknown[];
		try {
			messages = this._reader.append(chunk);
		} catch (error) {
			// a malformed header desynchronises the stream: the session cannot continue
			this._onLog(`debug adapter framing error: ${(error as Error).message}`);
			this._close();
			return;
		}

		for (const message of messages) {
			const dap = message as { type?: string; request_seq?: number; success?: boolean; body?: unknown; message?: string; event?: string };
			if (dap.type === 'response' && typeof dap.request_seq === 'number') {
				const pending = this._pending.get(dap.request_seq);
				if (pending) {
					this._pending.delete(dap.request_seq);
					pending.resolve({ success: !!dap.success, body: dap.body, message: dap.message });
				}
			} else if (dap.type === 'event' && typeof dap.event === 'string') {
				this._onEvent(dap.event, dap.body);
			}
		}
	}

	sendRequest(command: string, args: unknown): Promise<IWireDebugResponse> {
		if (this._closed) {
			return Promise.resolve({ success: false, message: 'the debug adapter is not running' });
		}
		const seq = this._seq++;
		const message = { seq, type: 'request', command, arguments: args };
		return new Promise<IWireDebugResponse>((resolve, reject) => {
			this._pending.set(seq, { resolve, reject });
			try {
				this._child.stdin.write(encodeMessage(message));
			} catch (error) {
				this._pending.delete(seq);
				resolve({ success: false, message: (error as Error).message });
			}
		});
	}

	stop(): void {
		if (this._closed) {
			return;
		}
		// ask politely, then make sure the process is actually reaped
		void this.sendRequest('disconnect', { terminateDebuggee: true });
		setTimeout(() => {
			if (!this._child.killed) {
				try {
					this._child.kill();
				} catch {
					// already gone
				}
			}
		}, 200);
	}

	private _close(): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		// never leave a caller hanging on a request the adapter will not answer
		for (const [, pending] of this._pending) {
			pending.resolve({ success: false, message: 'the debug adapter exited' });
		}
		this._pending.clear();
		this._onClosed();
	}

	get isClosed(): boolean {
		return this._closed;
	}
}

export class ExtHostDebug {

	private readonly _onDidStartDebugSession = new EventEmitter<{ id: string; type: string; name: string }>();
	readonly onDidStartDebugSession = this._onDidStartDebugSession.event;
	private readonly _onDidTerminateDebugSession = new EventEmitter<{ id: string; type: string; name: string }>();
	readonly onDidTerminateDebugSession = this._onDidTerminateDebugSession.event;

	private readonly _factories = new Map<string, IDebugAdapterDescriptorFactory>();
	private readonly _sessions = new Map<string, DebugAdapterSession>();
	private _sessionPool = 0;

	constructor(
		private readonly _proxy: IMainThreadDebug,
		private readonly _onLog: (message: string) => void
	) { }

	registerDebugAdapterDescriptorFactory(type: string, factory: IDebugAdapterDescriptorFactory): Disposable {
		if (this._factories.has(type)) {
			throw new Error(`a debug adapter descriptor factory for '${type}' is already registered`);
		}
		this._factories.set(type, factory);
		return new Disposable(() => this._factories.delete(type));
	}

	/** `vscode.debug.startDebugging` and the workbench's F5 both land here */
	async $startDebugging(configuration: IWireDebugConfiguration): Promise<string | null> {
		const factory = this._factories.get(configuration.type);
		if (!factory) {
			this._onLog(`no debug adapter descriptor factory for type '${configuration.type}'`);
			return null;
		}

		const sessionId = `debug-${++this._sessionPool}`;
		let descriptor: IDebugAdapterExecutable | undefined;
		try {
			descriptor = await factory.createDebugAdapterDescriptor({
				id: sessionId,
				type: configuration.type,
				name: configuration.name,
				configuration
			});
		} catch (error) {
			this._onLog(`the descriptor factory for '${configuration.type}' threw: ${(error as Error).message}`);
			return null;
		}
		if (!descriptor) {
			return null;
		}

		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(descriptor.command, [...(descriptor.args ?? [])], { cwd: descriptor.cwd });
		} catch (error) {
			this._onLog(`spawning the debug adapter failed: ${(error as Error).message}`);
			return null;
		}

		const session = new DebugAdapterSession(
			sessionId,
			configuration.type,
			configuration.name,
			child,
			(event, body) => void this._proxy.$acceptDebugEvent(sessionId, event, body).catch(() => { /* renderer gone */ }),
			() => {
				this._sessions.delete(sessionId);
				this._onDidTerminateDebugSession.fire({ id: sessionId, type: configuration.type, name: configuration.name });
				void this._proxy.$acceptDebugSessionTerminated(sessionId).catch(() => { /* renderer gone */ });
			},
			this._onLog
		);
		this._sessions.set(sessionId, session);

		this._onDidStartDebugSession.fire({ id: sessionId, type: configuration.type, name: configuration.name });
		void this._proxy.$acceptDebugSessionStarted(sessionId, configuration.type, configuration.name)
			.catch(() => { /* renderer gone */ });

		return sessionId;
	}

	async $sendDebugRequest(sessionId: string, command: string, args: unknown): Promise<IWireDebugResponse> {
		const session = this._sessions.get(sessionId);
		if (!session) {
			return { success: false, message: `no debug session '${sessionId}'` };
		}
		return session.sendRequest(command, args);
	}

	async $stopDebugging(sessionId: string): Promise<void> {
		this._sessions.get(sessionId)?.stop();
	}

	/** the host is shutting down: no adapter may outlive it */
	disposeAll(): void {
		for (const session of this._sessions.values()) {
			session.stop();
		}
		this._sessions.clear();
		this._factories.clear();
	}
}
