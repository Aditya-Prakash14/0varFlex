// src/renderer/platform/quickinput/browser/quickInput.ts — the QuickPick widget, API-lite.
// Keyboard table ported from vs/platform/quickinput/browser/quickInputController.ts:
//   Up/Down move (clamped, no wrap), PageUp/PageDown jump a viewport, Home/End jump,
//   Enter accepts, Esc hides, first item auto-selected, click accepts.
// Pixels are ours; only ~20 rows live in the DOM and get recycled while scrolling.

import { addDisposableListener, append, $ } from '../../../base/browser/dom.js';
import { Disposable, IDisposable } from '../../../../common/base/common/lifecycle.js';

const ROW_HEIGHT = 22;
const MAX_VISIBLE_ROWS = 20;

export interface IQuickPickOptions<T> {
	readonly placeholder: string;
	/** re-queried on every input change; return the list already ordered (best first) */
	readonly items: (value: string) => readonly T[];
	readonly label: (item: T) => string;
	readonly description?: (item: T) => string | undefined;
	readonly onDidChangeValue?: (value: string) => void;
}

export class QuickInputController extends Disposable {

	private _isOpen = false;
	get isOpen(): boolean {
		return this._isOpen;
	}

	pick<T>(options: IQuickPickOptions<T>): Promise<T | undefined> {
		return new Promise<T | undefined>(resolve => {
			this._isOpen = true;

			// focus capture: return focus to whoever had it when we hide
			const restoreFocusTo = document.activeElement as HTMLElement | null;

			let items: readonly T[] = options.items('');
			let active = items.length > 0 ? 0 : -1;
			let scrollTop = 0;
			let closed = false;

			const widget = append(document.body, $('.quick-input-widget'));
			const input = append(widget, $('input.quick-input-box', { type: 'text', placeholder: options.placeholder })) as HTMLInputElement;
			const list = append(widget, $('.quick-input-list'));
			const spacer = append(list, $('.quick-input-spacer'));

			// row pool — recycled, never more than MAX_VISIBLE_ROWS + 1 in the DOM
			const rows: HTMLElement[] = [];
			for (let i = 0; i <= MAX_VISIBLE_ROWS; i++) {
				rows.push(append(list, $('.quick-input-row')));
			}

			const disposes: IDisposable[] = [];

			const listHeight = (): number => Math.min(Math.max(items.length, 1), MAX_VISIBLE_ROWS) * ROW_HEIGHT;

			const clampScroll = (): void => {
				const max = Math.max(0, items.length * ROW_HEIGHT - listHeight());
				scrollTop = Math.max(0, Math.min(max, scrollTop));
			};

			const ensureActiveVisible = (): void => {
				const viewHeight = listHeight();
				if (active * ROW_HEIGHT < scrollTop) {
					scrollTop = active * ROW_HEIGHT;
				} else if ((active + 1) * ROW_HEIGHT > scrollTop + viewHeight) {
					scrollTop = (active + 1) * ROW_HEIGHT - viewHeight;
				}
				clampScroll();
			};

			const render = (): void => {
				list.style.height = `${listHeight()}px`;
				spacer.style.height = `${items.length * ROW_HEIGHT}px`;

				const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
				for (let i = 0; i < rows.length; i++) {
					const row = rows[i];
					const index = firstVisible + i;
					if (index >= items.length) {
						row.style.display = 'none';
						continue;
					}
					const item = items[index];
					row.style.display = '';
					row.style.top = `${index * ROW_HEIGHT - scrollTop}px`;
					row.classList.toggle('active', index === active);
					const label = row.querySelector('.quick-input-row-label') as HTMLElement;
					const description = row.querySelector('.quick-input-row-description') as HTMLElement;
					label.textContent = options.label(item);
					const desc = options.description?.(item);
					description.textContent = desc ?? '';
				}
			};

			const setItems = (value: string): void => {
				items = options.items(value);
				active = items.length > 0 ? 0 : -1;
				scrollTop = 0;
				render();
			};

			const close = (): void => {
				if (closed) {
					return;
				}
				closed = true;
				this._isOpen = false;
				for (const disposable of disposes) {
					disposable.dispose();
				}
				widget.remove();
				restoreFocusTo?.focus();
			};

			const accept = (item: T | undefined): void => {
				close();
				resolve(item);
			};

			const setActive = (index: number): void => {
				active = Math.max(0, Math.min(items.length - 1, index));
				ensureActiveVisible();
				render();
			};

			// wire the rows once (they are pooled, not re-created)
			for (let i = 0; i < rows.length; i++) {
				const row = rows[i];
				append(row, $('span.quick-input-row-label'), $('span.quick-input-row-description'));
				disposes.push(addDisposableListener(row, 'click', () => {
					const index = Math.floor((parseFloat(row.style.top) + scrollTop) / ROW_HEIGHT);
					if (items[index]) {
						accept(items[index]);
					}
				}));
				disposes.push(addDisposableListener(row, 'mousemove', () => {
					const index = Math.floor((parseFloat(row.style.top) + scrollTop) / ROW_HEIGHT);
					if (index !== active && items[index]) {
						active = index;
						render();
					}
				}));
			}

			disposes.push(addDisposableListener(list, 'wheel', (e: WheelEvent) => {
				e.preventDefault();
				scrollTop += e.deltaY;
				clampScroll();
				render();
			}));

			disposes.push(addDisposableListener(input, 'input', () => {
				options.onDidChangeValue?.(input.value);
				setItems(input.value);
			}));

			disposes.push(addDisposableListener(input, 'keydown', (e: KeyboardEvent) => {
				// the widget captures the keyboard while open
				e.stopPropagation();
				switch (e.key) {
					case 'ArrowDown':
						e.preventDefault();
						setActive(active + 1);
						break;
					case 'ArrowUp':
						e.preventDefault();
						setActive(active - 1);
						break;
					case 'PageDown':
						e.preventDefault();
						setActive(active + MAX_VISIBLE_ROWS);
						break;
					case 'PageUp':
						e.preventDefault();
						setActive(active - MAX_VISIBLE_ROWS);
						break;
					case 'Home':
						e.preventDefault();
						setActive(0);
						break;
					case 'End':
						e.preventDefault();
						setActive(items.length - 1);
						break;
					case 'Enter':
						e.preventDefault();
						accept(active >= 0 ? items[active] : undefined);
						break;
					case 'Escape':
						e.preventDefault();
						accept(undefined);
						break;
				}
			}));

			render();
			input.focus();
		});
	}
}
