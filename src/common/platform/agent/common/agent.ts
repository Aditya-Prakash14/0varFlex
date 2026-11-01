// src/common/platform/agent/common/agent.ts — the in-editor coding agent's contract.
//
// The agent is the editor's own feature, not an extension: it runs in the MAIN process because
// that is the only place with Node (file writes, child processes) and because the API key must
// never reach the renderer bundle. The renderer gets a chat view and talks over the `agent`
// channel, the same shape the `search` channel uses.
//
// Everything here is JSON-safe: paths are strings, never URIs (see ipc.electron.ts's note).

/** what the user sent and what the assistant said, as the view renders it */
export type ChatRole = 'user' | 'assistant';

export interface IChatTurn {
	readonly role: ChatRole;
	readonly text: string;
}

export interface IWireAgentRequest {
	readonly sessionId: string;
	readonly prompt: string;
	/** absolute path of the folder the agent may touch; no folder → the agent refuses to run */
	readonly workspaceRoot?: string;
	/** running commands is off unless the user turned it on (see agent.allowCommands) */
	readonly allowCommands: boolean;
	/**
	 * What the user is looking at. A chat agent inside an editor that cannot see the open file
	 * makes the user paste paths by hand, so this travels with every message.
	 */
	readonly activeFile?: string;
	readonly selectionText?: string;
}

/**
 * Streamed progress. One event per thing the user should see: assistant text as it arrives, a
 * line per tool call, and exactly one terminal event (`done` or `error`).
 */
export type IWireAgentEvent =
	| { readonly kind: 'text'; readonly sessionId: string; readonly delta: string }
	/** the model decided to call a tool; `summary` is a one-line human description */
	| { readonly kind: 'tool-start'; readonly sessionId: string; readonly tool: string; readonly summary: string }
	| { readonly kind: 'tool-end'; readonly sessionId: string; readonly tool: string; readonly ok: boolean; readonly summary: string }
	| { readonly kind: 'done'; readonly sessionId: string; readonly stopReason: string; readonly inputTokens: number; readonly outputTokens: number }
	| { readonly kind: 'error'; readonly sessionId: string; readonly message: string };

/** files the agent changed in a turn, so the workbench can reload the editors showing them */
export interface IWireAgentFileChange {
	readonly sessionId: string;
	readonly paths: readonly string[];
}

export interface IAgentChannel {
	/** resolves when the turn is finished; progress arrives on the events below */
	send(request: IWireAgentRequest): Promise<void>;
	cancel(sessionId: string): Promise<void>;
	/** true when a credential is available, so the view can explain itself instead of failing */
	isConfigured(): Promise<boolean>;
	readonly onDidEmitEvent: import('../../../base/common/event.js').Event<IWireAgentEvent>;
	readonly onDidChangeFiles: import('../../../base/common/event.js').Event<IWireAgentFileChange>;
}

/** the configuration key the command tool is gated on */
export const ALLOW_COMMANDS_SETTING = 'agent.allowCommands';
