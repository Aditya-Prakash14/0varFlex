// src/renderer/workbench/services/debug/browser/debugService.ts — the DAP client, ported in
// subset from vs/workbench/contrib/debug/browser/rawDebugSession.ts + debugService.ts:
//
//   - the workbench owns the CONVERSATION: which requests, in which order, and what the answers
//     mean. The adapter process and its byte framing live in the extension host (that is where
//     the stdio is), so requests travel as DTOs over the debug channel;
//   - breakpoints live here, not in a session: they survive a session ending and a window
//     reload (persisted to workspace storage, like the real one keyed per workspace);
//   - a `stopped` event drives the pull: stackTrace → scopes → variables, which is exactly the
//     DAP shape and the reason the view needs no polling.
//
// delta: no launch.json (one hardcoded configuration), no watch expressions, no REPL, no
// conditional/hit-count/exception breakpoints, no multi-session, no inline values.
//
// shortcut: the handshake is linear (initialize → setBreakpoints → configurationDone → launch)
// rather than driven by the `initialized` event. Both ends are ours; a third-party adapter that
// needs the event-driven order would not work until this is upgraded.

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { Disposable } from '../../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../../common/base/common/uri.js';
import type { ILogService } from '../../../../../common/platform/log/common/log.js';
import { IStorageService, StorageScope } from '../../../../../common/platform/storage/common/storage.js';
import type { IWireDebugResponse } from '../../../../../common/platform/extensions/common/extensionHostProtocol.js';

const BREAKPOINTS_STORAGE_KEY = 'debug.breakpoints';

export interface IBreakpoint {
	readonly path: string;
	readonly line: number;
}

export interface IStackFrame {
	readonly id: number;
	readonly name: string;
	readonly line: number;
	readonly column: number;
	readonly path?: string;
}

export interface IVariable {
	readonly name: string;
	readonly value: string;
	readonly variablesReference: number;
}

export interface IScope {
	readonly name: string;
	readonly variablesReference: number;
	variables: IVariable[];
	expanded: boolean;
}

export type DebugState = 'inactive' | 'running' | 'stopped';

export interface IDebugTransport {
	startDebugging(configuration: { type: string; name: string; request: string; [key: string]: unknown }): Promise<string | null>;
	sendRequest(sessionId: string, command: string, args: unknown): Promise<IWireDebugResponse>;
	stopDebugging(sessionId: string): Promise<void>;
}

export class DebugService extends Disposable {

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState: Event<void> = this._onDidChangeState.event;

	/** fired when the session stops, so the workbench can reveal the frame's line */
	private readonly _onDidStopAtFrame = this._register(new Emitter<IStackFrame>());
	readonly onDidStopAtFrame: Event<IStackFrame> = this._onDidStopAtFrame.event;

	private readonly _onDidChangeBreakpoints = this._register(new Emitter<void>());
	readonly onDidChangeBreakpoints: Event<void> = this._onDidChangeBreakpoints.event;

	private _breakpoints: IBreakpoint[] = [];
	private _state: DebugState = 'inactive';
	private _sessionId: string | undefined;
	private _sessionName = '';
	private _frames: IStackFrame[] = [];
	private _scopes: IScope[] = [];
	private _focusedFrameId: number | undefined;
	private _output: string[] = [];

	constructor(
		private readonly _transport: IDebugTransport,
		private readonly _storage: IStorageService,
		private readonly _logService: ILogService
	) {
		super();
		this._breakpoints = this._loadBreakpoints();
	}

	// ---- state the view renders

	get state(): DebugState { return this._state; }
	get sessionName(): string { return this._sessionName; }
	get frames(): readonly IStackFrame[] { return this._frames; }
	get scopes(): readonly IScope[] { return this._scopes; }
	get focusedFrameId(): number | undefined { return this._focusedFrameId; }
	get breakpoints(): readonly IBreakpoint[] { return this._breakpoints; }
	get output(): readonly string[] { return this._output; }
	get isActive(): boolean { return this._sessionId !== undefined; }

	// ---- breakpoints (independent of any session)

	breakpointsFor(resource: URI): readonly IBreakpoint[] {
		const path = resource.fsPath;
		return this._breakpoints.filter(breakpoint => breakpoint.path === path);
	}

	hasBreakpoint(resource: URI, line: number): boolean {
		const path = resource.fsPath;
		return this._breakpoints.some(breakpoint => breakpoint.path === path && breakpoint.line === line);
	}

	async toggleBreakpoint(resource: URI, line: number): Promise<void> {
		const path = resource.fsPath;
		const index = this._breakpoints.findIndex(breakpoint => breakpoint.path === path && breakpoint.line === line);
		if (index >= 0) {
			this._breakpoints.splice(index, 1);
		} else {
			this._breakpoints.push({ path, line });
			this._breakpoints.sort((a, b) => a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path));
		}
		this._saveBreakpoints();
		this._onDidChangeBreakpoints.fire();

		// a live session learns about it immediately (the real service re-sends per source too)
		if (this._sessionId) {
			await this._sendBreakpoints(path);
		}
	}

	private _loadBreakpoints(): IBreakpoint[] {
		const stored = this._storage.getObject<IBreakpoint[]>(BREAKPOINTS_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!Array.isArray(stored)) {
			return [];
		}
		// stored state is untrusted: drop anything malformed rather than crashing the view
		return stored.filter((entry): entry is IBreakpoint =>
			!!entry && typeof entry.path === 'string' && typeof entry.line === 'number' && entry.line >= 1);
	}

	private _saveBreakpoints(): void {
		this._storage.store(BREAKPOINTS_STORAGE_KEY, this._breakpoints, StorageScope.WORKSPACE);
	}

	// ---- the session

	async start(configuration: { type: string; name: string; program?: string;[key: string]: unknown }): Promise<boolean> {
		if (this._sessionId) {
			return false; // one session at a time (documented delta)
		}

		const sessionId = await this._transport.startDebugging({ request: 'launch', ...configuration });
		if (!sessionId) {
			this._logService.warn(`debug: no adapter for type '${configuration.type}'`);
			return false;
		}
		this._sessionId = sessionId;
		this._sessionName = configuration.name;
		this._output = [];
		this._setState('running');

		// the linear handshake (see the shortcut note at the top of this file)
		const initialize = await this._request('initialize', {
			clientID: '0varflex',
			adapterID: configuration.type,
			linesStartAt1: true,
			columnsStartAt1: true,
			pathFormat: 'path'
		});
		if (!initialize.success) {
			this._logService.error(`debug: initialize failed: ${initialize.message ?? 'unknown'}`);
			await this.stop();
			return false;
		}

		// group breakpoints per source: setBreakpoints replaces ALL of a source's breakpoints
		for (const path of new Set(this._breakpoints.map(breakpoint => breakpoint.path))) {
			await this._sendBreakpoints(path);
		}
		await this._request('configurationDone', {});

		const launch = await this._request('launch', configuration);
		if (!launch.success) {
			this._logService.error(`debug: launch failed: ${launch.message ?? 'unknown'}`);
			await this.stop();
			return false;
		}
		return true;
	}

	async stop(): Promise<void> {
		const sessionId = this._sessionId;
		if (!sessionId) {
			return;
		}
		// clear local state first: a slow adapter must not leave a stale call stack on screen
		this._sessionId = undefined;
		this._frames = [];
		this._scopes = [];
		this._focusedFrameId = undefined;
		this._setState('inactive');
		await this._transport.stopDebugging(sessionId);
	}

	async continue(): Promise<void> {
		if (this._state !== 'stopped') {
			return;
		}
		this._frames = [];
		this._scopes = [];
		this._setState('running');
		await this._request('continue', { threadId: 1 });
	}

	async next(): Promise<void> {
		if (this._state !== 'stopped') {
			return;
		}
		this._setState('running');
		await this._request('next', { threadId: 1 });
	}

	/** focus a frame: its scopes and variables are pulled on demand, like the real view */
	async focusFrame(frameId: number): Promise<void> {
		this._focusedFrameId = frameId;
		await this._loadScopes(frameId);
		this._onDidChangeState.fire();
	}

	async toggleScope(variablesReference: number): Promise<void> {
		const scope = this._scopes.find(candidate => candidate.variablesReference === variablesReference);
		if (!scope) {
			return;
		}
		scope.expanded = !scope.expanded;
		if (scope.expanded && scope.variables.length === 0) {
			const response = await this._request('variables', { variablesReference });
			scope.variables = readVariables(response.body);
		}
		this._onDidChangeState.fire();
	}

	// ---- events from the adapter (forwarded by MainThreadDebug)

	acceptSessionTerminated(sessionId: string): void {
		if (sessionId !== this._sessionId) {
			return;
		}
		this._sessionId = undefined;
		this._frames = [];
		this._scopes = [];
		this._focusedFrameId = undefined;
		this._setState('inactive');
	}

	acceptEvent(sessionId: string, event: string, body: unknown): void {
		if (sessionId !== this._sessionId) {
			return; // an event from a session we already abandoned
		}

		switch (event) {
			case 'stopped':
				void this._onStopped();
				break;
			case 'terminated':
			case 'exited':
				void this.stop();
				break;
			case 'output': {
				const text = (body as { output?: unknown })?.output;
				if (typeof text === 'string') {
					this._output.push(text);
					this._onDidChangeState.fire();
				}
				break;
			}
			default:
				break; // unknown events are ignored, not fatal
		}
	}

	private async _onStopped(): Promise<void> {
		this._setState('stopped');

		const stack = await this._request('stackTrace', { threadId: 1 });
		this._frames = readFrames(stack.body);
		this._scopes = [];
		this._focusedFrameId = this._frames[0]?.id;

		if (this._focusedFrameId !== undefined) {
			await this._loadScopes(this._focusedFrameId);
		}
		this._onDidChangeState.fire();

		const top = this._frames[0];
		if (top) {
			this._onDidStopAtFrame.fire(top);
		}
	}

	private async _loadScopes(frameId: number): Promise<void> {
		const response = await this._request('scopes', { frameId });
		const scopes = readScopes(response.body);
		this._scopes = scopes;
		// the first scope is expanded by default, so the counter is visible without a click
		const first = this._scopes[0];
		if (first) {
			first.expanded = true;
			const variables = await this._request('variables', { variablesReference: first.variablesReference });
			first.variables = readVariables(variables.body);
		}
	}

	private async _sendBreakpoints(path: string): Promise<void> {
		const lines = this._breakpoints.filter(breakpoint => breakpoint.path === path).map(breakpoint => ({ line: breakpoint.line }));
		await this._request('setBreakpoints', { source: { path }, breakpoints: lines });
	}

	private async _request(command: string, args: unknown): Promise<IWireDebugResponse> {
		const sessionId = this._sessionId;
		if (!sessionId) {
			return { success: false, message: 'no debug session' };
		}
		try {
			return await this._transport.sendRequest(sessionId, command, args);
		} catch (error) {
			this._logService.error(`debug: '${command}' failed: ${(error as Error).message}`);
			return { success: false, message: (error as Error).message };
		}
	}

	private _setState(state: DebugState): void {
		if (this._state !== state) {
			this._state = state;
			this._onDidChangeState.fire();
		}
	}
}

// ---- tolerant DAP body readers (exported for tests: an adapter may omit anything)

export function readFrames(body: unknown): IStackFrame[] {
	const frames = (body as { stackFrames?: unknown })?.stackFrames;
	if (!Array.isArray(frames)) {
		return [];
	}
	return frames
		.filter(frame => frame && typeof frame.id === 'number' && typeof frame.line === 'number')
		.map(frame => ({
			id: frame.id as number,
			name: typeof frame.name === 'string' ? frame.name : `frame ${frame.id}`,
			line: frame.line as number,
			column: typeof frame.column === 'number' ? frame.column : 1,
			path: typeof frame.source?.path === 'string' ? frame.source.path : undefined
		}));
}

export function readScopes(body: unknown): IScope[] {
	const scopes = (body as { scopes?: unknown })?.scopes;
	if (!Array.isArray(scopes)) {
		return [];
	}
	return scopes
		.filter(scope => scope && typeof scope.variablesReference === 'number')
		.map(scope => ({
			name: typeof scope.name === 'string' ? scope.name : 'Scope',
			variablesReference: scope.variablesReference as number,
			variables: [],
			expanded: false
		}));
}

export function readVariables(body: unknown): IVariable[] {
	const variables = (body as { variables?: unknown })?.variables;
	if (!Array.isArray(variables)) {
		return [];
	}
	return variables
		.filter(variable => variable && typeof variable.name === 'string')
		.map(variable => ({
			name: variable.name as string,
			value: variable.value === undefined ? '' : String(variable.value),
			variablesReference: typeof variable.variablesReference === 'number' ? variable.variablesReference : 0
		}));
}
