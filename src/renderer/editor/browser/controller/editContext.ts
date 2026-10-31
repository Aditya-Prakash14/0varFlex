// src/renderer/editor/browser/controller/editContext.ts — the hidden textarea, ported in spirit
// from vs/editor/browser/controller/editContext/textArea/textAreaEditContext.ts:
//
//   - ONE invisible textarea captures typing/paste/IME (that is how a browser gives us text);
//   - the textarea is positioned AT the cursor cell — the real code explains why: IME
//     candidate windows and OS text services anchor to the element, so if it stays at 0,0 the
//     composition popup appears at the window corner;
//   - composition is deferred: no model edits during composition, ONE commit on compositionend
//     (the widget wraps it in a single undo unit);
//   - clipboard goes through the textarea's clipboard events;
//   - the `input` path is SYNCHRONOUS — reading and clearing the textarea before any await is
//     what stops fast typing from dropping characters.
//
// delta: real VS Code mirrors composition text into a dedicated overlay widget; we mirror it on
// the cursor cell via the widget's positionCompositionText hook.

import { Disposable } from '../../../../common/base/common/lifecycle.js';
import { addDisposableListener } from '../../../base/browser/dom.js';

export interface IEditContextHost {
	/** pull the text out of the caret and apply it as one edit */
	type(text: string, isCompositionCommit?: boolean): void;
	/** the current selection serialized for clipboard copy */
	getSelectedText(): string;
	hasSelection(): boolean;
	deleteSelection(): void;
	/** true when the widget wants keystrokes routed here (always, while focus is in the editor) */
	onDidFocusChange(focused: boolean): void;
	/** mirror the composition text on the cursor cell (null hides it) */
	positionCompositionText(text: string | null): void;
}

export function normalizeEol(text: string): string {
	// the paste path normalizes to \n: the buffer stores lines and joins them with the file's
	// EOL on read, so a CRLF paste into an LF file stays an LF file
	return text.replace(/\r\n|\r/g, '\n');
}

export class EditContext extends Disposable {

	readonly textarea: HTMLTextAreaElement;

	private _isComposing = false;

	/** 12: the suggest controller suppresses fetches during composition (real: isComposing) */
	get isComposing(): boolean {
		return this._isComposing;
	}
	/** the last composition commit: the OS fires a trailing `input` carrying the same text */
	private _pendingCompositionText: string | null = null;

	constructor(container: HTMLElement, private readonly _host: IEditContextHost) {
		super();

		this.textarea = document.createElement('textarea');
		this.textarea.className = 'editor-textarea';
		this.textarea.autocapitalize = 'off';
		this.textarea.autocomplete = 'off';
		this.textarea.spellcheck = false;
		this.textarea.setAttribute('wrap', 'off');
		this.textarea.setAttribute('aria-label', 'Editor text input');
		container.appendChild(this.textarea);

		this._register(addDisposableListener(this.textarea, 'input', (e: InputEvent) => this._onInput(e)));
		this._register(addDisposableListener(this.textarea, 'compositionstart', () => this._onCompositionStart()));
		this._register(addDisposableListener(this.textarea, 'compositionupdate', (e: CompositionEvent) => this._onCompositionUpdate(e)));
		this._register(addDisposableListener(this.textarea, 'compositionend', (e: CompositionEvent) => this._onCompositionEnd(e)));
		this._register(addDisposableListener(this.textarea, 'paste', (e: ClipboardEvent) => this._onPaste(e)));
		this._register(addDisposableListener(this.textarea, 'copy', (e: ClipboardEvent) => this._onCopy(e)));
		this._register(addDisposableListener(this.textarea, 'cut', (e: ClipboardEvent) => this._onCut(e)));
		this._register(addDisposableListener(this.textarea, 'focus', () => this._host.onDidFocusChange(true)));
		this._register(addDisposableListener(this.textarea, 'blur', () => this._host.onDidFocusChange(false)));
	}

	get hasFocus(): boolean {
		return document.activeElement === this.textarea;
	}

	focus(): void {
		this.textarea.focus();
	}

	/** keep the caret (and any IME popup) at the cursor cell; called on every render */
	setPosition(left: number, top: number, lineHeight: number): void {
		this.textarea.style.left = `${left}px`;
		this.textarea.style.top = `${top}px`;
		this.textarea.style.height = `${lineHeight}px`;
	}

	private _onInput(event: InputEvent): void {
		if (this._isComposing || event.isComposing) {
			return; // composition commits once, on compositionend
		}
		const text = this.textarea.value;
		if (!text) {
			return;
		}
		if (this._pendingCompositionText !== null) {
			// the OS re-populates the textarea after compositionend; that trailing input is
			// NOT a new edit (the real controller dedups the same way, by state comparison)
			const pending = this._pendingCompositionText;
			this._pendingCompositionText = null;
			this.textarea.value = '';
			if (text === pending) {
				return;
			}
			this._host.type(text);
			return;
		}
		// synchronous: read then clear before the edit, so the next keystroke lands in an empty field
		this.textarea.value = '';
		this._host.type(text);
	}

	private _onCompositionStart(): void {
		this._isComposing = true;
	}

	private _onCompositionUpdate(event: CompositionEvent): void {
		this._host.positionCompositionText(event.data ?? '');
	}

	private _onCompositionEnd(event: CompositionEvent): void {
		this._isComposing = false;
		this._host.positionCompositionText(null);
		const text = event.data ?? '';
		// clear now; a trailing `input` that re-populates the field is swallowed above
		this.textarea.value = '';
		this._pendingCompositionText = text || null;
		if (text) {
			this._host.type(text, true);
		}
	}

	private _onPaste(event: ClipboardEvent): void {
		const text = event.clipboardData?.getData('text/plain');
		if (!text) {
			return;
		}
		event.preventDefault();
		this._host.type(normalizeEol(text));
	}

	private _onCopy(event: ClipboardEvent): void {
		if (!this._host.hasSelection()) {
			return; // default mac behavior: nothing without a selection
		}
		event.preventDefault();
		event.clipboardData?.setData('text/plain', this._host.getSelectedText());
	}

	private _onCut(event: ClipboardEvent): void {
		if (!this._host.hasSelection()) {
			return;
		}
		event.preventDefault();
		event.clipboardData?.setData('text/plain', this._host.getSelectedText());
		this._host.deleteSelection();
	}
}
