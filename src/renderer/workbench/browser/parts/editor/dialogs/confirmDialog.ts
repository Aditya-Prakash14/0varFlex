// src/renderer/workbench/browser/parts/editor/dialogs/confirmDialog.ts — the Save/Don't
// Save/Cancel modal, built on the same overlay pattern as 04's quick input (body-appended
// modal, keyboard captured while open, focus returned on close).
//
// Ported decision: Save is the PRIMARY button and gets initial focus (the native macOS sheet
// the real workbench opens defaults to Save); Escape is Cancel. Labels are exactly the
// reference's: `Save` / `Don't Save` / `Cancel`.

import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { IDisposable } from '../../../../../../common/base/common/lifecycle.js';

export type ConfirmDialogResult = 'primary' | 'secondary' | 'cancel';

export interface IConfirmDialogOptions {
	readonly message: string;
	readonly detail?: string;
	/** default: Save */
	readonly primaryLabel?: string;
	/** default: "Don't Save"; pass null to hide the button (two-button dialogs) */
	readonly secondaryLabel?: string | null;
	/** default: Cancel */
	readonly cancelLabel?: string;
}

export function confirmDialog(options: IConfirmDialogOptions): Promise<ConfirmDialogResult> {
	return new Promise<ConfirmDialogResult>(resolve => {
		const restoreFocusTo = document.activeElement as HTMLElement | null;

		const backdrop = document.createElement('div');
		backdrop.className = 'confirm-dialog-backdrop';
		const dialog = document.createElement('div');
		dialog.className = 'confirm-dialog';
		dialog.setAttribute('role', 'dialog');
		backdrop.appendChild(dialog);

		const message = document.createElement('div');
		message.className = 'confirm-dialog-message';
		message.textContent = options.message;
		dialog.appendChild(message);

		if (options.detail) {
			const detail = document.createElement('div');
			detail.className = 'confirm-dialog-detail';
			detail.textContent = options.detail;
			dialog.appendChild(detail);
		}

		const buttons = document.createElement('div');
		buttons.className = 'confirm-dialog-buttons';
		dialog.appendChild(buttons);

		const makeButton = (label: string, className: string, result: ConfirmDialogResult): HTMLButtonElement => {
			const button = document.createElement('button');
			button.className = `confirm-dialog-button ${className}`;
			button.textContent = label;
			button.addEventListener('click', () => finish(result));
			buttons.appendChild(button);
			return button;
		};

		const primary = makeButton(options.primaryLabel ?? 'Save', 'primary', 'primary');
		if (options.secondaryLabel !== null) {
			makeButton(options.secondaryLabel ?? 'Don\'t Save', 'secondary', 'secondary');
		}
		makeButton(options.cancelLabel ?? 'Cancel', 'cancel', 'cancel');

		const disposables: IDisposable[] = [];
		let closed = false;

		const finish = (result: ConfirmDialogResult): void => {
			if (closed) {
				return;
			}
			closed = true;
			for (const disposable of disposables) {
				disposable.dispose();
			}
			backdrop.remove();
			restoreFocusTo?.focus();
			resolve(result);
		};

		// the modal captures the keyboard while open (like the quick input)
		disposables.push(addDisposableListener(backdrop, 'keydown', (e: KeyboardEvent) => {
			e.stopPropagation();
			if (e.key === 'Escape') {
				e.preventDefault();
				finish('cancel');
			}
		}, true));

		document.body.appendChild(backdrop);
		primary.focus();
	});
}

/** the close/revert confirmation, ported from the workbench's confirm-on-close flow */
export function confirmSaveDialog(name: string): Promise<ConfirmDialogResult> {
	return confirmDialog({ message: `Save changes to '${name}'?` });
}
