// src/renderer/workbench/contrib/shipping/browser/aboutDialog.ts — the About dialog (14),
// ported in content from the real `dialogService.about()`: app name/version/commit/date plus the
// runtime versions, and a Copy button that puts the whole block on the clipboard.
//
// The real About is a native dialog on macOS and a webview elsewhere; ours is one HTML modal
// built on the 09 confirm-dialog styling (delta noted in the README).

import { addDisposableListener } from '../../../../base/browser/dom.js';
import { IDisposable } from '../../../../../common/base/common/lifecycle.js';
import type { IVersionInfo } from '../../../../../common/platform/window/common/window.js';

export function showAboutDialog(info: IVersionInfo, writeClipboard: (text: string) => Promise<void>): Promise<void> {
	return new Promise<void>(resolve => {
		const restoreFocusTo = document.activeElement as HTMLElement | null;

		const backdrop = document.createElement('div');
		backdrop.className = 'confirm-dialog-backdrop';
		const dialog = document.createElement('div');
		dialog.className = 'confirm-dialog about-dialog';
		dialog.setAttribute('role', 'dialog');
		backdrop.appendChild(dialog);

		const title = document.createElement('div');
		title.className = 'about-title';
		title.textContent = info.nameShort;
		dialog.appendChild(title);

		const rows: [string, string][] = [
			['Version', `${info.version}${info.commit && info.commit !== 'unknown' ? ` (${info.commit})` : ''}`],
			['Date', info.date],
			['Electron', info.electron],
			['Chromium', info.chromium],
			['Node.js', info.node],
			['V8', info.v8],
			['OS', info.os]
		];
		const table = document.createElement('div');
		table.className = 'about-table';
		for (const [label, value] of rows) {
			const row = document.createElement('div');
			row.className = 'about-row';
			const key = document.createElement('span');
			key.className = 'about-key';
			key.textContent = label;
			const text = document.createElement('span');
			text.className = 'about-value';
			text.textContent = value;
			row.append(key, text);
			table.appendChild(row);
		}
		dialog.appendChild(table);

		// the real dialog's Copy button copies the whole block
		const copyText = [
			`${info.nameShort} ${info.version}${info.commit && info.commit !== 'unknown' ? ` (${info.commit})` : ''}`,
			`Date: ${info.date}`,
			`Electron: ${info.electron}`,
			`Chromium: ${info.chromium}`,
			`Node.js: ${info.node}`,
			`V8: ${info.v8}`,
			`OS: ${info.os}`
		].join('\n');

		const copyToClipboard = (): void => {
			// the main process owns the clipboard: a synthetic click (and some sandboxed
			// renderer states) has no trusted user gesture, so navigator.clipboard refuses
			void writeClipboard(copyText).catch(() => fallbackCopy(copyText));
		};

		const buttons = document.createElement('div');
		buttons.className = 'confirm-dialog-buttons';
		const copy = document.createElement('button');
		copy.className = 'confirm-dialog-button';
		copy.textContent = 'Copy';
		const close = document.createElement('button');
		close.className = 'confirm-dialog-button';
		close.textContent = 'Close';
		buttons.append(copy, close);
		dialog.appendChild(buttons);

		const disposables: IDisposable[] = [];
		const finish = (): void => {
			for (const disposable of disposables) {
				disposable.dispose();
			}
			backdrop.remove();
			restoreFocusTo?.focus();
			resolve();
		};
		disposables.push(addDisposableListener(copy, 'click', () => {
			copyToClipboard();
			copy.textContent = 'Copied';
		}));
		disposables.push(addDisposableListener(close, 'click', finish));
		disposables.push(addDisposableListener(backdrop, 'mousedown', (event: MouseEvent) => {
			if (event.target === backdrop) {
				finish();
			}
		}));
		disposables.push(addDisposableListener(window, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				finish();
			}
		}));

		document.body.appendChild(backdrop);
		close.focus();
	});
}

function fallbackCopy(text: string): void {
	const textarea = document.createElement('textarea');
	textarea.value = text;
	textarea.style.position = 'fixed';
	textarea.style.opacity = '0';
	document.body.appendChild(textarea);
	textarea.select();
	try {
		document.execCommand('copy');
	} catch {
		// nothing else to try
	}
	textarea.remove();
}
