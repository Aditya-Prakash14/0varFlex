// extensions/toy-lang/client/src/lsp-client.ts — the hand-rolled 15% of vscode-languageclient:
// spawn, Content-Length framing, request/notification dispatch, `$/cancelRequest` on provider
// cancellation, stderr forwarding and a dispose that reaps the child. The real package adds
// document selectors, middleware, restart logic and output channels — this is the part you
// need to actually understand LSP.

import { spawn, type ChildProcess } from 'child_process';
import { encodeMessage, MessageReader } from './lsp-framing.js';

export interface ICancellationToken {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface ILspClientOptions {
	readonly serverPath: string;
	/** every complete stderr line, no prefix (the extension adds its own) */
	readonly onStderrLine: (line: string) => void;
	readonly onLog?: (message: string) => void;
}

interface IPendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

interface IJsonRpcMessage {
	readonly id?: number | string;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: { readonly message?: string };
}

export class LspClient {

	private _child: ChildProcess | null = null;
	private readonly _reader = new MessageReader();
	private _sequence = 0;
	private readonly _pending = new Map<number, IPendingRequest>();
	private readonly _notifications = new Map<string, (params: Record<string, unknown>) => void>();
	private _stderrRest = '';
	private _disposed = false;

	constructor(private readonly _options: ILspClientOptions) { }

	get isRunning(): boolean {
		return this._child !== null && !this._disposed;
	}

	async start(): Promise<void> {
		if (this._child) {
			return;
		}
		// the extension host runs inside Electron's utility process: process.execPath is the
		// Electron binary. ELECTRON_RUN_AS_NODE=1 makes it behave as plain node — exactly what
		// the real VS Code clients do to spawn their bundled servers.
		const child = spawn(process.execPath, [this._options.serverPath], {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
		});
		this._child = child;
		child.stdout?.on('data', (chunk: Buffer) => this._onData(chunk));
		child.stderr?.on('data', (chunk: Buffer) => this._onStderr(chunk));
		child.on('exit', (code, signal) => this._onExit(`server exited (code ${code ?? 'unknown'}, signal ${signal ?? 'none'})`));
		child.on('error', error => this._onExit(`server failed to start: ${error.message}`));

		await this.request('initialize', {
			processId: process.pid,
			rootUri: null,
			capabilities: {
				textDocument: {
					synchronization: { dynamicRegistration: false },
					completion: { completionItem: { snippetSupport: false } },
					hover: { contentFormat: ['markdown', 'plaintext'] },
					publishDiagnostics: { relatedInformation: false }
				},
				workspace: { configuration: true }
			}
		});
		this.notify('initialized', {});
	}

	request(method: string, params: unknown, cancellation?: ICancellationToken): Promise<unknown> {
		const id = ++this._sequence;
		return new Promise<unknown>((resolve, reject) => {
			if (!this._child || this._disposed) {
				reject(new Error('the language server is not running'));
				return;
			}
			let cancellationListener: { dispose(): void } | null = null;
			if (cancellation) {
				// the protocol cancels by request ID — that is the whole point of the ids
				cancellationListener = cancellation.onCancellationRequested(() => {
					this.notify('$/cancelRequest', { id });
				});
			}
			this._pending.set(id, {
				resolve: value => {
					cancellationListener?.dispose();
					resolve(value);
				},
				reject: error => {
					cancellationListener?.dispose();
					reject(error);
				}
			});
			this._send({ jsonrpc: '2.0', id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		this._send({ jsonrpc: '2.0', method, params });
	}

	onNotification(method: string, handler: (params: Record<string, unknown>) => void): void {
		this._notifications.set(method, handler);
	}

	private _send(message: unknown): void {
		if (!this._child || this._disposed) {
			return;
		}
		this._child.stdin?.write(encodeMessage(message));
	}

	private _onData(chunk: Buffer): void {
		let messages: unknown[];
		try {
			messages = this._reader.append(chunk);
		} catch (error) {
			this._options.onLog?.(`framing error: ${(error as Error).message}`);
			return;
		}
		for (const message of messages) {
			this._dispatch(message as IJsonRpcMessage);
		}
	}

	private _dispatch(message: IJsonRpcMessage): void {
		if (message.id !== undefined && message.method === undefined) {
			// a response
			const pending = this._pending.get(Number(message.id));
			if (!pending) {
				return;
			}
			this._pending.delete(Number(message.id));
			if (message.error) {
				pending.reject(new Error(message.error.message ?? 'server error'));
			} else {
				pending.resolve(message.result ?? null);
			}
			return;
		}
		if (message.method !== undefined) {
			if (message.id !== undefined) {
				// a server → client REQUEST: we declared no capabilities for one
				this._send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `not supported: ${message.method}` } });
				return;
			}
			const handler = this._notifications.get(message.method);
			if (handler) {
				try {
					handler((message.params as Record<string, unknown>) ?? {});
				} catch (error) {
					this._options.onLog?.(`notification ${message.method} handler failed: ${(error as Error).message}`);
				}
			}
		}
	}

	private _onStderr(chunk: Buffer): void {
		this._stderrRest += chunk.toString('utf8');
		for (;;) {
			const newline = this._stderrRest.indexOf('\n');
			if (newline === -1) {
				break;
			}
			const line = this._stderrRest.slice(0, newline).replace(/\r$/, '');
			this._stderrRest = this._stderrRest.slice(newline + 1);
			if (line.length > 0) {
				this._options.onStderrLine(line);
			}
		}
	}

	private _onExit(reason: string): void {
		for (const pending of this._pending.values()) {
			pending.reject(new Error(reason));
		}
		this._pending.clear();
		if (!this._disposed) {
			this._options.onLog?.(reason);
		}
	}

	/** shutdown/exit, then reap the child (SIGKILL after a grace period) */
	async dispose(): Promise<void> {
		const child = this._child;
		if (!child) {
			this._disposed = true;
			return;
		}
		try {
			this._send({ jsonrpc: '2.0', id: ++this._sequence, method: 'shutdown', params: null });
			this._send({ jsonrpc: '2.0', method: 'exit', params: null });
		} catch { /* the pipe may already be gone */ }
		this._disposed = true;
		this._child = null;
		await new Promise<void>(resolve => {
			const timer = setTimeout(() => {
				try {
					child.kill('SIGKILL');
				} catch { /* already gone */ }
				resolve();
			}, 500);
			child.once('exit', () => {
				clearTimeout(timer);
				resolve();
			});
		});
		try {
			child.kill();
		} catch { /* already gone */ }
	}
}
