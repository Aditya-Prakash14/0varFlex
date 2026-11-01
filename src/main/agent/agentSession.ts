// src/main/agent/agentSession.ts — the agentic loop: ask the model, run the tools it asks for,
// feed the results back, repeat until it stops.
//
// Written against the documented streaming manual loop rather than the SDK's beta tool runner,
// because this loop has to forward every event to another process (the renderer's chat view)
// and gate each file tool on a workspace-confinement check before it runs. The runner does not
// expose per-delta events to a caller that needs to re-publish them over IPC, and keeping a beta
// API out of the editor's core feature is worth the extra twenty lines.
//
// Non-obvious rules this loop obeys, all of which are easy to get wrong:
//   - every tool_result for one assistant turn goes back in ONE user message. Splitting them
//     teaches the model to stop making parallel calls;
//   - `refusal` means a tool input may be cut off mid-stream, so that turn's tools never run;
//   - `max_tokens` on a tool-calling turn means the input is truncated — usually still valid
//     JSON — so the call is NOT run; we stop and say so;
//   - `pause_turn` is not an end: append the assistant turn and send it back;
//   - the whole assistant `content` array is appended, not just its text, so thinking blocks
//     travel back unchanged (the API drops what the model cannot read, unbilled);
//   - tool inputs are re-validated locally, because eager input streaming turns off server-side
//     validation and the tolerant parser can hand back a truncated object.

import Anthropic from '@anthropic-ai/sdk';
import * as nodePath from 'node:path';
import { Emitter, Event } from '../../common/base/common/event.js';
import { Disposable } from '../../common/base/common/lifecycle.js';
import type { ILogService } from '../../common/platform/log/common/log.js';
import type { IWireAgentEvent, IWireAgentFileChange, IWireAgentRequest } from '../../common/platform/agent/common/agent.js';
import { agentToolDefinitions, IAgentToolContext, runAgentTool } from './agentTools.js';

/** streaming, so a long edit never hits an HTTP timeout */
const MAX_TOKENS = 64_000;
/** a runaway loop costs money: stop after this many model round trips in one turn */
const MAX_ITERATIONS = 40;
/** re-issue a turn at most twice when a tool input arrives unparseable */
const MAX_JSON_RETRIES = 2;
/** past this the user gets a nudge to start a new chat (history is never trimmed silently) */
const LONG_CONVERSATION_MESSAGES = 60;

const SYSTEM_PROMPT = `You are the coding agent built into 0varflex, a code editor.

You are working inside the user's open workspace folder. Use your tools to read the code before
changing it — never guess at a file's contents.

How to work:
- Prefer search_files over reading many files. Read a file before you edit it.
- Use edit_file for changes to existing files; it replaces one exact unique string. Quote the
  old text exactly, including indentation. Use write_file only for new files or a full rewrite.
- Make the smallest change that fully solves the task, and finish every part of it, including
  the callers and tests your change breaks.
- Match the style of the surrounding code.
- When you are done, say in one or two sentences what you changed and anything the user should
  check. Do not re-print whole files back to the user.

Paths you pass to tools are relative to the workspace folder. A path outside it is refused.`;

/**
 * The three things this loop uses from an SDK stream. Declaring the seam rather than importing
 * the SDK's generic stream type keeps a test fake to three methods instead of a whole class.
 */
export interface IAgentStream {
	on(event: 'text', listener: (delta: string) => void): unknown;
	finalMessage(): Promise<Anthropic.Message>;
	abort(): void;
}

/** the slice of the SDK this loop uses, so a test can stand in for it */
export interface IMessagesClient {
	readonly messages: {
		stream(params: Anthropic.MessageCreateParamsNonStreaming): IAgentStream;
	};
}

export interface IAgentSessionServices {
	readonly logService: ILogService;
	/**
	 * Injected so the loop can be driven by a fake client in tests. Production leaves it unset
	 * and the SDK resolves credentials itself.
	 */
	readonly createClient?: () => IMessagesClient;
	/** reuses the editor's own search engine instead of standing up a second one */
	searchFiles(root: string, pattern: string, isRegExp: boolean): Promise<readonly { path: string; line: number; text: string }[]>;
}

export class AgentService extends Disposable {

	private readonly _onDidEmitEvent = this._register(new Emitter<IWireAgentEvent>());
	readonly onDidEmitEvent: Event<IWireAgentEvent> = this._onDidEmitEvent.event;

	private readonly _onDidChangeFiles = this._register(new Emitter<IWireAgentFileChange>());
	readonly onDidChangeFiles: Event<IWireAgentFileChange> = this._onDidChangeFiles.event;

	private _client: IMessagesClient | undefined;
	/** the in-flight stream per session, so cancel can actually abort the request */
	private readonly _streams = new Map<string, IAgentStream>();
	/** conversation history per session, so a follow-up question keeps the context */
	private readonly _history = new Map<string, Anthropic.MessageParam[]>();
	private readonly _cancelled = new Set<string>();
	private readonly _running = new Set<string>();

	constructor(private readonly _services: IAgentSessionServices) {
		super();
	}

	/**
	 * The SDK resolves credentials itself: ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN, then an
	 * `ant auth login` profile. We never read, store or log a key — an unset env var does not
	 * mean there is no credential.
	 */
	private client(): IMessagesClient {
		if (!this._client) {
			// one narrow cast at the injection seam: the SDK's stream is a superset of IAgentStream
			this._client = this._services.createClient
				? this._services.createClient()
				: (new Anthropic() as unknown as IMessagesClient);
		}
		return this._client;
	}

	async isConfigured(): Promise<boolean> {
		try {
			this.client();
			return true;
		} catch {
			// the constructor throws when it can find no credential at all
			return false;
		}
	}

	async cancel(sessionId: string): Promise<void> {
		if (!this._running.has(sessionId)) {
			return;
		}
		this._cancelled.add(sessionId);
		// Abort the HTTP request too. Setting a flag alone left the model generating — and
		// billing — until the turn finished on its own, which is not what Stop means.
		this._streams.get(sessionId)?.abort();
	}

	async send(request: IWireAgentRequest): Promise<void> {
		const { sessionId, prompt } = request;

		if (this._running.has(sessionId)) {
			this._emitError(sessionId, 'This chat is already working on something. Wait for it to finish or stop it.');
			return;
		}
		if (!request.workspaceRoot) {
			this._emitError(sessionId, 'Open a folder first — the agent works inside your workspace folder.');
			return;
		}
		if (!prompt.trim()) {
			return;
		}

		this._running.add(sessionId);
		this._cancelled.delete(sessionId);
		try {
			await this._runTurn(request, request.workspaceRoot);
		} catch (error) {
			this._emitError(sessionId, describeError(error));
			this._services.logService.error(`agent: ${(error as Error).stack ?? error}`);
		} finally {
			this._running.delete(sessionId);
			this._cancelled.delete(sessionId);
		}
	}

	private async _runTurn(request: IWireAgentRequest, workspaceRoot: string): Promise<void> {
		const { sessionId } = request;
		const messages = this._history.get(sessionId) ?? [];
		messages.push({ role: 'user', content: buildUserMessage(request, workspaceRoot) });
		this._history.set(sessionId, messages);

		if (messages.length > LONG_CONVERSATION_MESSAGES) {
			// no silent trimming: dropping messages would split a tool_use from its tool_result
			// and the API would reject the next request. Tell the user instead.
			this._emit({
				kind: 'tool-end', sessionId, tool: 'context', ok: true,
				summary: 'This chat is getting long — "New" starts a fresh one if replies slow down.'
			});
		}

		const toolContext: IAgentToolContext = {
			workspaceRoot,
			allowCommands: request.allowCommands,
			searchFiles: (pattern, isRegExp) => this._services.searchFiles(workspaceRoot, pattern, isRegExp)
		};
		const tools = agentToolDefinitions(request.allowCommands);

		let inputTokens = 0;
		let outputTokens = 0;
		let jsonRetries = 0;
		const changedPaths = new Set<string>();

		for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
			if (this._cancelled.has(sessionId)) {
				// an earlier iteration may already have written files: the editors showing them
				// must still reload, or they would keep stale text on screen
				this._publishChanges(sessionId, changedPaths);
				this._emit({ kind: 'done', sessionId, stopReason: 'cancelled', inputTokens, outputTokens });
				return;
			}

			const stream = this.client().messages.stream({
				model: 'claude-opus-5-5',
				max_tokens: MAX_TOKENS,
				// thinking is always on for this model; medium is its default, and agentic
				// coding wants more than that
				output_config: { effort: 'high' },
				// the system prompt and tool list are the stable prefix, so cache them
				system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
				tools,
				messages
			});

			this._streams.set(sessionId, stream);

			stream.on('text', (delta: string) => {
				if (!this._cancelled.has(sessionId)) {
					this._emit({ kind: 'text', sessionId, delta });
				}
			});

			let message: Anthropic.Message;
			try {
				message = await stream.finalMessage();
				jsonRetries = 0; // the cap is on consecutive failures of one turn
			} catch (error) {
				// an abort is the user pressing Stop, not a failure
				if (error instanceof Anthropic.APIUserAbortError || this._cancelled.has(sessionId)) {
					this._publishChanges(sessionId, changedPaths);
					this._emit({ kind: 'done', sessionId, stopReason: 'cancelled', inputTokens, outputTokens });
					return;
				}
				// eager input streaming means the SDK rejects when a tool input will not parse
				// at all. Only that is retried; a real API error is rethrown.
				if (error instanceof Anthropic.APIError || jsonRetries++ >= MAX_JSON_RETRIES) {
					throw error;
				}
				this._services.logService.warn('agent: a tool input was not parseable JSON, re-issuing the turn');
				continue;
			} finally {
				this._streams.delete(sessionId);
			}

			inputTokens += message.usage.input_tokens;
			outputTokens += message.usage.output_tokens;

			if (message.stop_reason === 'end_turn') {
				messages.push({ role: 'assistant', content: message.content });
				this._publishChanges(sessionId, changedPaths);
				this._emit({ kind: 'done', sessionId, stopReason: 'end_turn', inputTokens, outputTokens });
				return;
			}

			// a refusal can cut a tool input off mid-stream: never run that turn's tools
			if (message.stop_reason === 'refusal') {
				messages.push({ role: 'assistant', content: message.content });
				this._emitError(sessionId, 'The model declined this request.');
				return;
			}

			// a server-side tool hit its iteration limit — send the turn back to continue it
			if (message.stop_reason === 'pause_turn') {
				messages.push({ role: 'assistant', content: message.content });
				continue;
			}

			const toolUses = message.content.filter(
				(block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
			);

			if (toolUses.length === 0) {
				// some other terminal stop with nothing to run
				messages.push({ role: 'assistant', content: message.content });
				this._publishChanges(sessionId, changedPaths);
				this._emit({ kind: 'done', sessionId, stopReason: message.stop_reason ?? 'unknown', inputTokens, outputTokens });
				return;
			}

			// a tool input cut off at max_tokens usually still parses as a valid partial object,
			// so running it would act on truncated arguments
			if (message.stop_reason === 'max_tokens') {
				messages.push({ role: 'assistant', content: message.content });
				this._emitError(sessionId, 'The reply hit the output limit while describing a tool call, so it was not run. Try a smaller step.');
				return;
			}

			messages.push({ role: 'assistant', content: message.content });

			// every result for this turn goes back in ONE user message
			const results: Anthropic.ToolResultBlockParam[] = [];
			for (const toolUse of toolUses) {
				if (this._cancelled.has(sessionId)) {
					break;
				}

				const summaryIn = describeToolCall(toolUse.name, toolUse.input);
				this._emit({ kind: 'tool-start', sessionId, tool: toolUse.name, summary: summaryIn });

				const result = await runAgentTool(toolUse.name, toolUse.input, toolContext);
				if (result.changedPath) {
					changedPaths.add(result.changedPath);
				}

				this._emit({ kind: 'tool-end', sessionId, tool: toolUse.name, ok: !result.isError, summary: result.summary });

				results.push({
					type: 'tool_result',
					tool_use_id: toolUse.id,
					content: result.content,
					// a failed tool still returns a result; dropping it breaks the conversation
					...(result.isError ? { is_error: true } : {})
				});
			}

			if (this._cancelled.has(sessionId)) {
				// the history now ends on an assistant turn with unanswered tool calls, which the
				// API rejects on the next request — drop the turn so the session stays usable
				messages.pop();
				// tools already ran before the cancel landed, so their edits are real
				this._publishChanges(sessionId, changedPaths);
				this._emit({ kind: 'done', sessionId, stopReason: 'cancelled', inputTokens, outputTokens });
				return;
			}

			messages.push({ role: 'user', content: results });
		}

		this._publishChanges(sessionId, changedPaths);
		this._emitError(sessionId, `Stopped after ${MAX_ITERATIONS} steps without finishing. Ask for a smaller step.`);
	}

	private _publishChanges(sessionId: string, paths: Set<string>): void {
		if (paths.size > 0) {
			this._onDidChangeFiles.fire({ sessionId, paths: [...paths] });
		}
	}

	private _emit(event: IWireAgentEvent): void {
		this._onDidEmitEvent.fire(event);
	}

	private _emitError(sessionId: string, message: string): void {
		this._emit({ kind: 'error', sessionId, message });
	}

	/** forget a conversation (the view's "New chat") */
	clearHistory(sessionId: string): void {
		this._history.delete(sessionId);
	}
}

/** a one-line description of what the model is about to do, for the chat view */
export function describeToolCall(name: string, input: unknown): string {
	const args = (input ?? {}) as Record<string, unknown>;
	const path = typeof args.path === 'string' ? args.path : undefined;
	switch (name) {
		case 'read_file': return `Reading ${path ?? 'a file'}`;
		case 'list_directory': return `Listing ${path ?? '.'}`;
		case 'search_files': return `Searching for "${typeof args.pattern === 'string' ? args.pattern : ''}"`;
		case 'write_file': return `Writing ${path ?? 'a file'}`;
		case 'edit_file': return `Editing ${path ?? 'a file'}`;
		case 'run_command': {
			const command = typeof args.command === 'string' ? args.command : '';
			const commandArgs = Array.isArray(args.args) ? args.args.filter(entry => typeof entry === 'string').join(' ') : '';
			return `Running ${command} ${commandArgs}`.trim();
		}
		default: return name;
	}
}

/**
 * Turn an SDK error into something a user can act on. Checked most specific first, as the SDK's
 * error classes are a hierarchy — one broad catch would lose the difference between "your key is
 * wrong" and "slow down".
 */
export function describeError(error: unknown): string {
	if (error instanceof Anthropic.AuthenticationError) {
		return 'The API rejected the credentials. Set ANTHROPIC_API_KEY, or sign in with `ant auth login`.';
	}
	if (error instanceof Anthropic.PermissionDeniedError) {
		return 'These credentials are not allowed to use this model.';
	}
	if (error instanceof Anthropic.RateLimitError) {
		return 'Rate limited by the API. Wait a moment and try again.';
	}
	if (error instanceof Anthropic.BadRequestError) {
		return `The API rejected the request: ${error.message}`;
	}
	if (error instanceof Anthropic.APIConnectionError) {
		return 'Could not reach the API. Check your network connection.';
	}
	if (error instanceof Anthropic.APIError) {
		return `API error ${error.status ?? ''}: ${error.message}`.trim();
	}
	return (error as Error)?.message ?? String(error);
}

/**
 * Build the user turn, with the editor context the agent would otherwise have to ask for.
 *
 * The active file is given as a workspace-relative path, because that is the only form the tools
 * accept — handing the model an absolute path would teach it to send one back and every tool
 * call would be refused.
 */
export function buildUserMessage(
	request: { prompt: string; activeFile?: string; selectionText?: string },
	workspaceRoot: string
): string {
	const context: string[] = [];

	if (request.activeFile) {
		const relative = toWorkspaceRelative(workspaceRoot, request.activeFile);
		if (relative) {
			context.push(`Active editor: ${relative}`);
		}
	}
	if (request.selectionText && request.selectionText.trim()) {
		// a long selection is clipped: it is context, not the task
		const clipped = request.selectionText.length > 4000
			? `${request.selectionText.slice(0, 4000)}\n… selection truncated …`
			: request.selectionText;
		context.push(`Selected text:\n\`\`\`\n${clipped}\n\`\`\``);
	}

	return context.length > 0
		? `${context.join('\n')}\n\n${request.prompt}`
		: request.prompt;
}

/** a workspace-relative path, or undefined when the file is outside the folder */
export function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string | undefined {
	const relative = nodePath.relative(workspaceRoot, absolutePath);
	if (!relative || relative.startsWith('..') || nodePath.isAbsolute(relative)) {
		return undefined;
	}
	// the tools take forward slashes on every platform
	return relative.split(nodePath.sep).join('/');
}
