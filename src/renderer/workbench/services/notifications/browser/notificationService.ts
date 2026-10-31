// src/renderer/workbench/services/notifications/browser/notificationService.ts — the toast
// stack the extension API's showInformationMessage family needs (09/10 already left notes that
// "11 adds toasts"). Shaped after the workbench's notification list: severity accent, message,
// action buttons, dismiss; the answer travels back to the caller's promise.

import { append, $ } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../../common/base/common/lifecycle.js';

export type NotificationSeverity = 'info' | 'warning' | 'error';

export interface IToastOptions {
	readonly severity: NotificationSeverity;
	readonly message: string;
	readonly items?: readonly string[];
}

export interface IToastHandle {
	close(): void;
}

export class NotificationService extends Disposable {

	private readonly _element: HTMLElement;

	constructor(container: HTMLElement = document.body) {
		super();
		this._element = append(container, $('.notifications-toasts'));
	}

	/** resolves with the clicked item, or undefined when dismissed */
	show(options: IToastOptions): Promise<string | undefined> & IToastHandle {
		const toast = append(this._element, $('.notification-toast', { 'aria-label': options.message }));
		toast.classList.add(options.severity);
		append(toast, $('.notification-message', {}, options.message));

		let resolvePromise: (value: string | undefined) => void;
		const promise = new Promise<string | undefined>(resolve => { resolvePromise = resolve; }) as Promise<string | undefined> & IToastHandle;

		const finish = (value: string | undefined): void => {
			toast.remove();
			resolvePromise(value);
		};

		const actions = append(toast, $('.notification-actions'));
		for (const item of options.items ?? []) {
			const button = append(actions, $('button.notification-button', {}, item)) as HTMLButtonElement;
			button.addEventListener('click', () => finish(item));
		}
		const close = append(actions, $('button.notification-close', { title: 'Dismiss' }, '✕'));
		close.addEventListener('click', () => finish(undefined));

		promise.close = () => finish(undefined);
		return promise;
	}

	/** the open toast count (acceptance view) */
	get visibleCount(): number {
		return this._element.childElementCount;
	}
}
