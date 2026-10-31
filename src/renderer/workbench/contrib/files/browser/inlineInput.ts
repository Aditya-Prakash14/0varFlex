// src/renderer/workbench/contrib/files/browser/inlineInput.ts — the row input for New
// File/Folder and Rename, ported in shape from explorerViewer.ts's InputBox + the validation
// from fileActions.ts (validateFileName) and base/common/extpath.ts (isValidBasename).
//
// The input is an absolutely positioned input box inside the tree container with a message row
// for errors: Enter accepts, Escape/blur cancels, an `onAccept` rejection keeps it open with
// the error message shown.

import { addDisposableListener, append, $ } from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { Disposable } from '../../../../../common/base/common/lifecycle.js';

// ---- validation (ported)

const UNIX_INVALID_FILE_CHARS = /[/]/;
const WINDOWS_INVALID_FILE_CHARS = /[\\/:*?"<>|]/;
const WINDOWS_FORBIDDEN_NAMES = /^(con|prn|aux|clock\$|nul|lpt[0-9]|com[0-9])(\.(.*?))?$/i;

/** ported verbatim from base/common/extpath.ts; default is NOT windows (our platform) */
export function isValidBasename(name: string | null | undefined, isWindowsOS: boolean = false): boolean {
	const invalidFileChars = isWindowsOS ? WINDOWS_INVALID_FILE_CHARS : UNIX_INVALID_FILE_CHARS;

	if (!name || name.length === 0 || /^\s+$/.test(name)) {
		return false; // require a name that is not just whitespace
	}
	if (invalidFileChars.test(name)) {
		return false; // certain invalid file characters
	}
	if (isWindowsOS && WINDOWS_FORBIDDEN_NAMES.test(name)) {
		return false; // reserved device names
	}
	if (name === '.' || name === '..') {
		return false; // reserved values
	}
	if (isWindowsOS && name[name.length - 1] === '.') {
		return false; // Windows: file cannot end with a "."
	}
	if (isWindowsOS && name.length !== name.trim().length) {
		return false; // Windows: file cannot end with a whitespace
	}
	if (name.length > 255) {
		return false; // most file systems do not allow files > 255 length
	}
	return true;
}

/** ported getWellFormedFileName: trim tabs, strip trailing slashes */
export function getWellFormedFileName(filename: string): string {
	if (!filename) {
		return filename;
	}
	return filename.replace(/^[\t]+/, '').replace(/[\t]+$/, '').replace(/[/\\]+$/, '');
}

export interface IValidateFileNameOptions {
	readonly isWindowsOS?: boolean;
	/** names of the siblings at the target location (exists check) */
	readonly parentChildNames?: readonly string[];
	/** renaming: the current name (no exists-conflict with itself) */
	readonly currentName?: string;
}

/** ported order from fileActions.ts:validateFileName; returns an error message or null */
export function validateFileName(name: string, options: IValidateFileNameOptions = {}): string | null {
	name = getWellFormedFileName(name);

	if (!name || name.length === 0 || /^\s+$/.test(name)) {
		return 'A file or folder name must be provided.';
	}
	if (name[0] === '/' || name[0] === '\\') {
		return 'A file or folder name cannot start with a slash.';
	}

	if (options.parentChildNames && name !== options.currentName && options.parentChildNames.includes(name)) {
		return `A file or folder ${name} already exists at this location. Please choose a different name.`;
	}

	// the whole name is ONE segment here: the course rejects `a/b` in the input rather than
	// silently creating nested folders (the real input supports nested paths — delta)
	if (!isValidBasename(name, options.isWindowsOS ?? false)) {
		return `The name ${name} is not valid as a file or folder name. Please choose a different name.`;
	}
	return null;
}

// ---- the widget

export interface IInlineInputOptions {
	readonly container: HTMLElement;
	readonly top: number;
	readonly left: number;
	readonly width: number;
	readonly initialValue?: string;
	readonly placeholder?: string;
	/** synchronous validation while typing and on Enter */
	readonly validate?: (value: string) => string | null;
	/** may reject: the input stays open and the rejection is shown as the message */
	readonly onAccept: (value: string) => Promise<void> | void;
	readonly onCancel?: () => void;
}

export class InlineInput extends Disposable {

	static show(options: IInlineInputOptions): InlineInput {
		return new InlineInput(options);
	}

	private readonly _onDidDispose = this._register(new Emitter<void>());
	readonly onDidDispose: Event<void> = this._onDidDispose.event;

	private readonly _input: HTMLInputElement;
	private readonly _message: HTMLElement;
	private _closed = false;

	private constructor(private readonly _options: IInlineInputOptions) {
		super();

		const options = _options;
		const widget = append(options.container, $('.inline-input-widget'));
		widget.style.top = `${options.top}px`;
		widget.style.left = `${options.left}px`;
		widget.style.width = `${options.width}px`;
		this._input = append(widget, $('input.inline-input-box', {
			type: 'text',
			value: options.initialValue ?? '',
			placeholder: options.placeholder ?? ''
		})) as HTMLInputElement;
		this._message = append(widget, $('.inline-input-message'));

		this._register(addDisposableListener(this._input, 'keydown', (event: KeyboardEvent) => {
			// the tree's keyboard handler must not see input keystrokes
			event.stopPropagation();
			if (event.key === 'Enter') {
				event.preventDefault();
				void this._accept();
			} else if (event.key === 'Escape') {
				event.preventDefault();
				this.cancel();
			}
		}));
		this._register(addDisposableListener(this._input, 'blur', () => this._onBlur()));

		this._input.focus();
		this._input.select();
		this._disposeWidget = () => widget.remove();
	}

	private _disposeWidget: () => void;
	private _accepting = false;

	private async _accept(): Promise<void> {
		const value = getWellFormedFileName(this._input.value);
		const error = this._options.validate?.(value) ?? null;
		if (error) {
			this._showMessage(error);
			return;
		}
		this._accepting = true;
		try {
			await this._options.onAccept(value);
			this._close();
		} catch (acceptError) {
			this._showMessage((acceptError as Error).message);
			this._input.focus();
		} finally {
			this._accepting = false;
		}
	}

	private _showMessage(message: string): void {
		this._message.textContent = message;
		this._message.style.display = '';
	}

	private _onBlur(): void {
		// an accept in flight owns the widget (its error must stay visible)
		if (this._accepting || this._closed) {
			return;
		}
		this.cancel();
	}

	cancel(): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		this._options.onCancel?.();
		this._remove();
	}

	private _close(): void {
		this._closed = true;
		this._remove();
	}

	private _remove(): void {
		this._disposeWidget();
		this._onDidDispose.fire();
		this.dispose();
	}
}
