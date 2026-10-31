// src/renderer/editor/contrib/suggest/suggestWidget.ts — the widget DOM, following the row
// anatomy of vs/editor/contrib/suggest/browser/suggestWidgetRenderer.ts:
//
//   [kind icon] [label — matched characters bolded] [detail, dimmed right]
//
// Layout rules ported: at most 8 visible rows (the list scrolls past that), anchored at the
// cursor cell, flipped above the line when it would overflow the bottom of the editor.

import { append, $ } from '../../../base/browser/dom.js';
import { ISuggestItem } from './suggest.js';

export const ROW_HEIGHT = 22;
export const MAX_VISIBLE_ROWS = 8;

/** kind → glyph + css class (delta: codicon glyphs; the reference uses $('symbol-method') etc.) */
const KIND_ICONS: Record<number, { glyph: string; className: string }> = {
	1: { glyph: 'ab', className: 'kind-text' },
	2: { glyph: 'ƒ', className: 'kind-method' },
	3: { glyph: 'ƒ', className: 'kind-function' },
	4: { glyph: '⌘', className: 'kind-constructor' },
	5: { glyph: '▪', className: 'kind-field' },
	6: { glyph: '𝑥', className: 'kind-variable' },
	7: { glyph: 'C', className: 'kind-class' },
	8: { glyph: 'I', className: 'kind-interface' },
	9: { glyph: 'M', className: 'kind-module' },
	10: { glyph: 'p', className: 'kind-property' },
	11: { glyph: 'u', className: 'kind-unit' },
	12: { glyph: 'v', className: 'kind-value' },
	13: { glyph: 'E', className: 'kind-enum' },
	14: { glyph: 'k', className: 'kind-keyword' },
	15: { glyph: 's', className: 'kind-snippet' },
	16: { glyph: '●', className: 'kind-color' },
	17: { glyph: 'f', className: 'kind-file' },
	18: { glyph: 'r', className: 'kind-reference' },
	19: { glyph: 'd', className: 'kind-folder' },
	20: { glyph: 'e', className: 'kind-enum-member' },
	21: { glyph: 'c', className: 'kind-constant' },
	22: { glyph: 'S', className: 'kind-struct' },
	23: { glyph: '⚡', className: 'kind-event' },
	24: { glyph: '±', className: 'kind-operator' },
	25: { glyph: 'T', className: 'kind-type-parameter' }
};

export interface ISuggestAnchor {
	/** left edge, in .editor viewport coordinates */
	readonly left: number;
	/** top of the cursor's line, in .editor viewport coordinates */
	readonly lineTop: number;
	readonly lineHeight: number;
	readonly editorWidth: number;
	readonly editorHeight: number;
}

export class SuggestWidget {

	readonly element: HTMLElement;

	private readonly _list: HTMLElement;
	private readonly _rows: HTMLElement[] = [];
	private _items: readonly ISuggestItem[] = [];
	private _selected = 0;

	constructor(container: HTMLElement) {
		this.element = append(container, $('.suggest-widget', { style: 'display: none;' }));
		this._list = append(this.element, $('.suggest-list'));
	}

	get isVisible(): boolean {
		return this.element.style.display !== 'none';
	}

	get selectedIndex(): number {
		return this._selected;
	}

	get items(): readonly ISuggestItem[] {
		return this._items;
	}

	show(items: readonly ISuggestItem[], selected: number, anchor: ISuggestAnchor): void {
		this._items = items;
		this._selected = selected;
		this._renderRows();
		this._position(anchor);
		this.element.style.display = '';
	}

	update(items: readonly ISuggestItem[], selected: number): void {
		this._items = items;
		this._selected = selected;
		this._renderRows();
		this._scrollSelectedIntoView();
	}

	setSelected(index: number): void {
		this._selected = index;
		this._updateSelectionClasses();
		this._scrollSelectedIntoView();
	}

	hide(): void {
		this.element.style.display = 'none';
		this._items = [];
		this._selected = 0;
	}

	/** keep the widget on the caret when the viewport moves under it */
	reposition(anchor: ISuggestAnchor): void {
		if (this.isVisible) {
			this._position(anchor);
		}
	}

	private _renderRows(): void {
		// rows: reuse the pool (create once, update, hide leftovers) — the viewLayer rule
		for (let i = 0; i < Math.max(this._items.length, this._rows.length); i++) {
			let row = this._rows[i];
			if (!row) {
				row = $('.suggest-row');
				this._rows[i] = row;
				append(this._list, row);
			}
			if (i >= this._items.length) {
				row.style.display = 'none';
				continue;
			}
			this._updateRow(row, this._items[i], i);
		}
		this.element.style.height = '';
		this._list.style.height = `${this._items.length * ROW_HEIGHT}px`;
		this._updateSelectionClasses();
		this._scrollSelectedIntoView();
	}

	private _updateRow(row: HTMLElement, item: ISuggestItem, index: number): void {
		row.style.display = '';
		row.style.top = `${index * ROW_HEIGHT}px`;
		row.innerHTML = '';

		const kind = KIND_ICONS[item.kind] ?? { glyph: '■', className: 'kind-text' };
		const icon = append(row, $('.suggest-icon'));
		icon.classList.add(kind.className);
		icon.textContent = kind.glyph;

		const label = append(row, $('.suggest-label'));
		// bold the matched characters (the reference's `matchedRanges` rendering)
		const matched = new Set(item.matched);
		let run = '';
		let runMatched = matched.has(0);
		const flush = () => {
			if (run.length === 0) {
				return;
			}
			const span = $('span', {}, run);
			if (runMatched) {
				span.classList.add('suggest-match');
			}
			append(label, span);
			run = '';
		};
		for (let i = 0; i < item.label.length; i++) {
			const isMatched = matched.has(i);
			if (isMatched !== runMatched) {
				flush();
				runMatched = isMatched;
			}
			run += item.label[i];
		}
		flush();

		if (item.detail) {
			append(row, $('.suggest-detail', {}, item.detail));
		}
		row.title = item.documentation ?? '';
	}

	private _updateSelectionClasses(): void {
		for (let i = 0; i < this._rows.length; i++) {
			this._rows[i].classList.toggle('selected', i === this._selected && i < this._items.length);
		}
	}

	private _scrollSelectedIntoView(): void {
		const maxHeight = MAX_VISIBLE_ROWS * ROW_HEIGHT;
		const selectedTop = this._selected * ROW_HEIGHT;
		if (selectedTop < this._list.scrollTop) {
			this._list.scrollTop = selectedTop;
		} else if (selectedTop + ROW_HEIGHT > this._list.scrollTop + maxHeight) {
			this._list.scrollTop = selectedTop + ROW_HEIGHT - maxHeight;
		}
	}

	/** anchor below the caret; flip above the line when there is no room (real: fits-or-flips) */
	private _position(anchor: ISuggestAnchor): void {
		const count = Math.min(this._items.length, MAX_VISIBLE_ROWS);
		const height = count * ROW_HEIGHT + 4;
		this._list.style.maxHeight = `${MAX_VISIBLE_ROWS * ROW_HEIGHT}px`;

		const width = 320;
		const left = Math.max(0, Math.min(anchor.left, anchor.editorWidth - width - 10));
		this.element.style.left = `${left}px`;

		const below = anchor.lineTop + anchor.lineHeight;
		if (below + height <= anchor.editorHeight || anchor.lineTop < height) {
			this.element.style.top = `${below}px`;
			this.element.style.bottom = '';
		} else {
			// flip: bottom edge at the line top
			this.element.style.top = '';
			this.element.style.bottom = `${Math.max(0, anchor.editorHeight - anchor.lineTop) + 2}px`;
		}
	}

	dispose(): void {
		this.element.remove();
	}
}
