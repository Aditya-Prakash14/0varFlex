// src/renderer/workbench/contrib/chat/browser/chatView.ts — the Chat composite: the editor's
// built-in coding agent.
//
// Shaped after vs/workbench/contrib/chat/browser/chatWidget.ts at a fraction of the size: a
// transcript, a prompt box, and a Stop button while the agent works. Tool calls appear as their
// own lines so you can see what the agent is doing to your files rather than only its prose.
//
// All text is set with textContent, never innerHTML: the transcript carries model output and
// file contents.
//
// delta: no inline chat, no slash commands, no @-file references, no code-block Apply buttons,
// no markdown rendering (the hover's markdown-lite could be reused when it earns its place).

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../../common/base/common/uri.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { addDisposableListener, append, $ } from '../../../../base/browser/dom.js';
import type { ChatService } from '../../../services/chat/browser/chatService.js';

export const ChatViewFocusContext = new RawContextKey<boolean>('chatViewFocus', false);

export interface IChatViewServices {
	readonly chatService: ChatService;
	readonly contextKeyService: IContextKeyService;
	getWorkspaceRoot(): URI | undefined;
	/** read from configuration each send, so toggling the setting takes effect at once */
	allowCommands(): boolean;
}

export class ChatView extends Disposable {

	readonly element: HTMLElement;

	private readonly _transcript: HTMLElement;
	private readonly _input: HTMLTextAreaElement;
	private readonly _footer: HTMLElement;
	private readonly _submit: HTMLElement;
	private readonly _focusKey: IContextKey<boolean>;

	/** listeners for the CURRENT transcript; it is rebuilt on every change */
	private readonly _rowDisposables = this._register(new DisposableStore());

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState: Event<void> = this._onDidChangeState.event;

	constructor(container: HTMLElement, private readonly _services: IChatViewServices) {
		super();

		this.element = append(container, $('.chat-view'));
		this._transcript = append(this.element, $('.chat-transcript'));

		const inputRow = append(this.element, $('.chat-input-row'));
		this._input = append(inputRow, $<HTMLTextAreaElement>('textarea.chat-input', {
			rows: '3',
			spellcheck: 'false',
			placeholder: 'Ask the agent to change your code… (Enter to send, Shift+Enter for a new line)',
			'aria-label': 'Message the coding agent'
		}));

		const buttons = append(inputRow, $('.chat-buttons'));
		this._submit = append(buttons, $('span.chat-button.primary', { title: 'Send (Enter)', tabindex: '0' }, 'Send'));
		const clear = append(buttons, $('span.chat-button', { title: 'Start a new chat', tabindex: '0' }, 'New'));

		this._footer = append(this.element, $('.chat-footer'));

		this._focusKey = ChatViewFocusContext.bindTo(_services.contextKeyService);
		this._register(addDisposableListener(this._input, 'focus', () => this._focusKey.set(true)));
		this._register(addDisposableListener(this._input, 'blur', () => this._focusKey.set(false)));

		this._register(addDisposableListener(this._input, 'keydown', (event: KeyboardEvent) => {
			// Enter sends, Shift+Enter makes a new line — the convention every chat box uses
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				void this.submit();
			}
		}));

		this._register(addDisposableListener(this._submit, 'click', () => {
			if (this._services.chatService.isBusy) {
				this._services.chatService.cancel();
			} else {
				void this.submit();
			}
		}));
		this._register(addDisposableListener(clear, 'click', () => this._services.chatService.clear()));

		this._register(this._services.chatService.onDidChange(() => this.render()));
		this.render();
	}

	focusInput(): void {
		this._input.focus();
	}

	async submit(): Promise<void> {
		const chatService = this._services.chatService;
		if (chatService.isBusy) {
			return;
		}
		const prompt = this._input.value.trim();
		if (!prompt) {
			return;
		}

		if (!this._services.getWorkspaceRoot()) {
			this._input.placeholder = 'Open a folder first — the agent works inside your workspace folder.';
			return;
		}

		this._input.value = '';
		await chatService.send(prompt, {
			workspaceRoot: this._services.getWorkspaceRoot(),
			allowCommands: this._services.allowCommands()
		});
	}

	render(): void {
		this._rowDisposables.clear();
		const chatService = this._services.chatService;

		this._transcript.textContent = '';

		if (chatService.entries.length === 0) {
			const empty = append(this._transcript, $('.chat-empty'));
			append(empty, $('.chat-empty-title', {}, 'Built-in coding agent'));
			append(empty, $('.chat-empty-body', {},
				'It can read, search and edit files in your workspace folder. Paths outside the folder are refused.'));
			void this._renderCredentialHint(empty);
		}

		for (const entry of chatService.entries) {
			const row = append(this._transcript, $(`.chat-entry.${entry.kind}`));
			if (entry.kind === 'tool') {
				append(row, $(`span.chat-tool-state.${entry.state}`, {},
					entry.state === 'running' ? '…' : entry.state === 'ok' ? '✓' : '✕'));
				append(row, $('span.chat-tool-text', {}, entry.text));
			} else {
				if (entry.kind === 'user') {
					append(row, $('.chat-entry-label', {}, 'You'));
				} else if (entry.kind === 'assistant') {
					append(row, $('.chat-entry-label', {}, 'Agent'));
				}
				// textContent: this is model output and file text, never markup
				append(row, $('.chat-entry-text', {}, entry.text));
			}
		}

		// the Send button doubles as Stop while the agent works, like the real chat view
		this._submit.textContent = chatService.isBusy ? 'Stop' : 'Send';
		this._submit.classList.toggle('stop', chatService.isBusy);
		this._input.disabled = chatService.isBusy;

		const usage = chatService.lastUsage;
		this._footer.textContent = chatService.isBusy
			? 'Working…'
			: usage
				? `${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out tokens`
				: '';

		// follow the tail
		this._transcript.scrollTop = this._transcript.scrollHeight;
		this._onDidChangeState.fire();
	}

	/** say so up front when there is no credential, instead of failing on the first send */
	private async _renderCredentialHint(parent: HTMLElement): Promise<void> {
		const configured = await this._services.chatService.isConfigured();
		if (!configured) {
			append(parent, $('.chat-empty-warning', {},
				'No API credentials found. Set ANTHROPIC_API_KEY in your environment, or run `ant auth login`, then reload the window.'));
		}
	}
}
