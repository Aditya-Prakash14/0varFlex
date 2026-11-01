// src/renderer/workbench/services/chat/browser/chatService.ts — the renderer half of the agent.
//
// It owns the transcript the view renders and demultiplexes the channel's events by session id.
// The agent itself runs in main; nothing here touches the model or a credential.

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { Disposable } from '../../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../../common/base/common/uri.js';
import type { IAgentChannel, IWireAgentEvent } from '../../../../../common/platform/agent/common/agent.js';

/** one entry in the transcript the view draws */
export type IChatEntry =
	| { readonly kind: 'user'; text: string }
	| { readonly kind: 'assistant'; text: string }
	| { readonly kind: 'tool'; text: string; state: 'running' | 'ok' | 'failed' }
	| { readonly kind: 'error'; text: string };

export class ChatService extends Disposable {

	/** one session per window is enough; a second chat would need tabs first */
	private static readonly SESSION_ID = 'chat-1';

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	/** fired with the files the agent wrote, so open editors can reload from disk */
	private readonly _onDidChangeFiles = this._register(new Emitter<readonly URI[]>());
	readonly onDidChangeFiles: Event<readonly URI[]> = this._onDidChangeFiles.event;

	private _entries: IChatEntry[] = [];
	private _busy = false;
	private _lastUsage: { inputTokens: number; outputTokens: number } | undefined;

	constructor(private readonly _channel: IAgentChannel) {
		super();

		// subscribe BEFORE any send: the channel does not buffer early emissions
		this._register(this._channel.onDidEmitEvent(event => this._accept(event)));
		this._register(this._channel.onDidChangeFiles(event => {
			if (event.sessionId === ChatService.SESSION_ID) {
				this._onDidChangeFiles.fire(event.paths.map(path => URI.file(path)));
			}
		}));
	}

	get entries(): readonly IChatEntry[] { return this._entries; }
	get isBusy(): boolean { return this._busy; }
	get lastUsage(): { inputTokens: number; outputTokens: number } | undefined { return this._lastUsage; }

	isConfigured(): Promise<boolean> {
		return this._channel.isConfigured();
	}

	async send(prompt: string, options: {
		workspaceRoot: URI | undefined;
		allowCommands: boolean;
		activeFile?: URI;
		selectionText?: string;
	}): Promise<void> {
		if (this._busy || !prompt.trim()) {
			return;
		}
		this._entries.push({ kind: 'user', text: prompt });
		this._busy = true;
		this._onDidChange.fire();

		await this._channel.send({
			sessionId: ChatService.SESSION_ID,
			prompt,
			workspaceRoot: options.workspaceRoot?.fsPath,
			allowCommands: options.allowCommands,
			activeFile: options.activeFile?.fsPath,
			selectionText: options.selectionText
		});
	}

	cancel(): void {
		if (this._busy) {
			void this._channel.cancel(ChatService.SESSION_ID);
		}
	}

	clear(): void {
		if (this._busy) {
			return;
		}
		this._entries = [];
		this._lastUsage = undefined;
		this._onDidChange.fire();
	}

	private _accept(event: IWireAgentEvent): void {
		if (event.sessionId !== ChatService.SESSION_ID) {
			return;
		}

		switch (event.kind) {
			case 'text': {
				// append into the open assistant entry so the text grows in place
				const last = this._entries[this._entries.length - 1];
				if (last?.kind === 'assistant') {
					last.text += event.delta;
				} else {
					this._entries.push({ kind: 'assistant', text: event.delta });
				}
				break;
			}
			case 'tool-start':
				this._entries.push({ kind: 'tool', text: event.summary, state: 'running' });
				break;
			case 'tool-end': {
				// settle the matching running entry rather than adding a second line
				const running = [...this._entries].reverse().find(
					(entry): entry is IChatEntry & { kind: 'tool' } => entry.kind === 'tool' && entry.state === 'running'
				);
				if (running) {
					running.state = event.ok ? 'ok' : 'failed';
					running.text = event.summary;
				} else {
					this._entries.push({ kind: 'tool', text: event.summary, state: event.ok ? 'ok' : 'failed' });
				}
				break;
			}
			case 'done':
				this._busy = false;
				this._lastUsage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
				break;
			case 'error':
				this._entries.push({ kind: 'error', text: event.message });
				this._busy = false;
				break;
		}

		this._onDidChange.fire();
	}
}
