// src/renderer/workbench/contrib/search/browser/searchResultsTree.ts — the results tree:
// file nodes with a match-count badge, expandable into one row per match, ported in spirit from
// vs/workbench/contrib/search/browser/searchResultsView.ts (+ the explorer tree's row recycling
// from 10):
//
//   - ROW_HEIGHT 22, absolute positioning, a windowed render (only the visible rows exist in the
//     DOM) so a 20k-match result set still scrolls;
//   - rows are POOLED: the pool is sized to the viewport and its elements are re-targeted on
//     scroll, never recreated;
//   - the match row shows the line with the matched range highlighted — assembled from TEXT
//     NODES, never innerHTML, because the preview is file content;
//   - keyboard: up/down move, right/left expand/collapse a file, Enter opens the match.
//
// delta: the real tree is a WorkbenchObjectTree with multi-select, context menus and per-match
// "dismiss" actions; ours is single-select with Enter/click to open.
//
// shortcut: per-file collapse state is kept on the node and reset when a new query replaces the
// results — the real view preserves it across refreshes of the same query.

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { Disposable } from '../../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../../common/base/common/uri.js';
import { ITextSearchMatch } from '../../../../../common/platform/search/common/search.js';
import { addDisposableListener, append, $ } from '../../../../base/browser/dom.js';

const ROW_HEIGHT = 22;
/** a long line is clipped so one match cannot blow the row width out */
const MAX_PREVIEW_LENGTH = 300;

export interface ISearchResultFile {
	readonly resource: URI;
	/** basename, for the label */
	readonly name: string;
	/** dirname relative to the search root, dimmed next to the label */
	readonly description: string;
	matches: ITextSearchMatch[];
	expanded: boolean;
}

/** a flattened visible row: either a file header or one match under it */
type IVisibleRow =
	| { readonly kind: 'file'; readonly file: ISearchResultFile }
	| { readonly kind: 'match'; readonly file: ISearchResultFile; readonly match: ITextSearchMatch };

interface IPooledRow {
	readonly element: HTMLElement;
	readonly twisty: HTMLElement;
	readonly label: HTMLElement;
	readonly description: HTMLElement;
	readonly badge: HTMLElement;
	readonly preview: HTMLElement;
}

/**
 * Turn a line plus a 1-based match range into the string to render and the 0-based slice indices
 * of the highlight.
 *
 * Leading whitespace is trimmed like the real view does (indentation would push every match off
 * the row), and the columns shift with it — but only when the match starts at or after the
 * indentation. A query that matches inside the indentation (whitespace, or a regex anchored at
 * the line start) must not have the text under its own highlight trimmed away.
 *
 * A very long line is clipped so one match cannot blow out the row width; the range is clamped
 * into whatever survives.
 */
export function trimPreview(previewText: string, startColumn: number, endColumn: number): { text: string; start: number; end: number } {
	const indent = previewText.length - previewText.trimStart().length;
	const leading = startColumn - 1 >= indent ? indent : 0;
	const shifted = previewText.slice(leading);
	const text = shifted.length > MAX_PREVIEW_LENGTH ? shifted.slice(0, MAX_PREVIEW_LENGTH) : shifted;

	const start = Math.min(Math.max(0, startColumn - 1 - leading), text.length);
	const end = Math.min(Math.max(start, endColumn - 1 - leading), text.length);
	return { text, start, end };
}

export interface ISearchResultsTreeDelegate {
	openMatch(file: ISearchResultFile, match: ITextSearchMatch, options: { preserveFocus: boolean }): void;
}

export class SearchResultsTree extends Disposable {

	private readonly _element: HTMLElement;
	private readonly _rowsContainer: HTMLElement;
	private readonly _pool: IPooledRow[] = [];

	private _files: ISearchResultFile[] = [];
	private _visible: IVisibleRow[] = [];
	private _focusedIndex = -1;

	private readonly _onDidFocusChange = this._register(new Emitter<boolean>());
	readonly onDidFocusChange: Event<boolean> = this._onDidFocusChange.event;

	constructor(container: HTMLElement, private readonly _delegate: ISearchResultsTreeDelegate) {
		super();
		this._element = append(container, $('.search-tree', { tabindex: '0' }));
		this._rowsContainer = append(this._element, $('.search-rows'));

		this._register(addDisposableListener(this._element, 'scroll', () => this._render()));
		this._register(addDisposableListener(this._element, 'keydown', (event: KeyboardEvent) => this._onKeyDown(event)));
		this._register(addDisposableListener(this._element, 'focus', () => {
			this._onDidFocusChange.fire(true);
			this._render();
		}));
		this._register(addDisposableListener(this._element, 'blur', () => {
			this._onDidFocusChange.fire(false);
			this._render();
		}));
	}

	get element(): HTMLElement {
		return this._element;
	}

	focus(): void {
		this._element.focus();
	}

	hasFocus(): boolean {
		return document.activeElement === this._element || this._element.contains(document.activeElement);
	}

	get fileCount(): number {
		return this._files.length;
	}

	get matchCount(): number {
		let total = 0;
		for (const file of this._files) {
			total += file.matches.length;
		}
		return total;
	}

	/** replace everything (a new query) */
	setFiles(files: ISearchResultFile[]): void {
		this._files = files;
		this._focusedIndex = -1;
		this._element.scrollTop = 0;
		this._rebuild();
	}

	/**
	 * Merge a batch into the existing results: matches for a file already shown are appended,
	 * which is what streaming results need (the engine delivers in batches, not all at once).
	 */
	addFiles(files: readonly ISearchResultFile[]): void {
		for (const incoming of files) {
			const existing = this._files.find(file => file.resource.fsPath === incoming.resource.fsPath);
			if (existing) {
				existing.matches = [...existing.matches, ...incoming.matches];
			} else {
				this._files.push(incoming);
			}
		}
		this._rebuild();
	}

	/** drop one file's node entirely (it was deleted, or no longer matches) */
	removeFile(resource: URI): void {
		const before = this._files.length;
		this._files = this._files.filter(file => file.resource.fsPath !== resource.fsPath);
		if (this._files.length !== before) {
			this._rebuild();
		}
	}

	/** replace one file's matches (it was edited and re-searched); [] removes the node */
	replaceFileMatches(resource: URI, matches: ITextSearchMatch[]): void {
		if (matches.length === 0) {
			this.removeFile(resource);
			return;
		}
		const existing = this._files.find(file => file.resource.fsPath === resource.fsPath);
		if (existing) {
			existing.matches = matches;
			this._rebuild();
		}
	}

	hasFile(resource: URI): boolean {
		return this._files.some(file => file.resource.fsPath === resource.fsPath);
	}

	clear(): void {
		this.setFiles([]);
	}

	// ---- rendering

	private _rebuild(): void {
		this._visible = [];
		for (const file of this._files) {
			this._visible.push({ kind: 'file', file });
			if (file.expanded) {
				for (const match of file.matches) {
					this._visible.push({ kind: 'match', file, match });
				}
			}
		}
		// the spacer gives the scroll container its height
		this._rowsContainer.style.height = `${this._visible.length * ROW_HEIGHT}px`;
		if (this._focusedIndex >= this._visible.length) {
			this._focusedIndex = this._visible.length - 1;
		}
		this._render();
	}

	private _render(): void {
		const viewportHeight = this._element.clientHeight || ROW_HEIGHT * 20;
		const first = Math.max(0, Math.floor(this._element.scrollTop / ROW_HEIGHT) - 1);
		const count = Math.min(this._visible.length - first, Math.ceil(viewportHeight / ROW_HEIGHT) + 3);

		// grow the pool to the window size; it never shrinks (the viewport does not either)
		while (this._pool.length < Math.max(0, count)) {
			this._pool.push(this._createRow());
		}

		for (let i = 0; i < this._pool.length; i++) {
			const row = this._pool[i];
			const index = first + i;
			if (i >= count || index >= this._visible.length) {
				row.element.style.display = 'none';
				continue;
			}
			row.element.style.display = '';
			row.element.style.top = `${index * ROW_HEIGHT}px`;
			this._fillRow(row, this._visible[index], index);
		}
	}

	private _createRow(): IPooledRow {
		const element = append(this._rowsContainer, $('.search-row'));
		const twisty = append(element, $('.search-twisty'));
		const label = append(element, $('span.search-label'));
		const description = append(element, $('span.search-description'));
		const badge = append(element, $('span.search-badge'));
		const preview = append(element, $('span.search-preview'));

		const row: IPooledRow = { element, twisty, label, description, badge, preview };

		this._register(addDisposableListener(element, 'click', () => {
			const index = Number(element.dataset.index);
			if (!Number.isInteger(index) || index < 0 || index >= this._visible.length) {
				return;
			}
			this._focusedIndex = index;
			const target = this._visible[index];
			if (target.kind === 'file') {
				target.file.expanded = !target.file.expanded;
				this._rebuild();
			} else {
				// clicking a match keeps focus in the tree, like the real view's single click
				this._delegate.openMatch(target.file, target.match, { preserveFocus: true });
				this._render();
			}
		}));

		this._register(addDisposableListener(element, 'dblclick', () => {
			const index = Number(element.dataset.index);
			const target = this._visible[index];
			if (target?.kind === 'match') {
				this._delegate.openMatch(target.file, target.match, { preserveFocus: false });
			}
		}));

		return row;
	}

	private _fillRow(row: IPooledRow, target: IVisibleRow, index: number): void {
		row.element.dataset.index = String(index);
		row.element.classList.toggle('focused', index === this._focusedIndex && this.hasFocus());
		row.element.classList.toggle('is-file', target.kind === 'file');
		row.element.classList.toggle('is-match', target.kind === 'match');

		if (target.kind === 'file') {
			row.twisty.style.display = '';
			row.twisty.classList.toggle('expanded', target.file.expanded);
			row.label.textContent = target.file.name;
			row.description.textContent = target.file.description;
			row.badge.textContent = String(target.file.matches.length);
			row.badge.style.display = '';
			row.preview.textContent = '';
			row.preview.style.display = 'none';
		} else {
			row.twisty.style.display = 'none';
			row.label.textContent = '';
			row.description.textContent = '';
			row.badge.textContent = '';
			row.badge.style.display = 'none';
			row.preview.style.display = '';
			this._fillPreview(row.preview, target.match);
		}
	}

	/** the line, with the matched range wrapped in a highlight span — text nodes only */
	private _fillPreview(container: HTMLElement, match: ITextSearchMatch): void {
		container.textContent = '';
		const { text, start, end } = trimPreview(match.previewText, match.startColumn, match.endColumn);
		append(container, document.createTextNode(text.slice(0, start)));
		append(container, $('span.search-match-highlight', {}, text.slice(start, end)));
		append(container, document.createTextNode(text.slice(end)));
	}

	// ---- keyboard

	private _onKeyDown(event: KeyboardEvent): void {
		if (this._visible.length === 0) {
			return;
		}

		switch (event.key) {
			case 'ArrowDown':
				this._moveFocus(1);
				break;
			case 'ArrowUp':
				this._moveFocus(-1);
				break;
			case 'ArrowRight': {
				const target = this._visible[this._focusedIndex];
				if (target?.kind === 'file' && !target.file.expanded) {
					target.file.expanded = true;
					this._rebuild();
				} else {
					this._moveFocus(1);
				}
				break;
			}
			case 'ArrowLeft': {
				const target = this._visible[this._focusedIndex];
				if (target?.kind === 'file' && target.file.expanded) {
					target.file.expanded = false;
					this._rebuild();
				} else if (target?.kind === 'match') {
					// jump to the owning file row
					const fileIndex = this._visible.findIndex(row => row.kind === 'file' && row.file === target.file);
					if (fileIndex >= 0) {
						this._focusedIndex = fileIndex;
						this._reveal(fileIndex);
						this._render();
					}
				}
				break;
			}
			case 'Enter': {
				const target = this._visible[this._focusedIndex];
				if (target?.kind === 'match') {
					this._delegate.openMatch(target.file, target.match, { preserveFocus: false });
				} else if (target?.kind === 'file') {
					target.file.expanded = !target.file.expanded;
					this._rebuild();
				}
				break;
			}
			default:
				return; // not ours: let it bubble (Escape is the view's)
		}

		event.preventDefault();
		event.stopPropagation();
	}

	private _moveFocus(delta: number): void {
		const next = this._focusedIndex < 0
			? (delta > 0 ? 0 : this._visible.length - 1)
			: this._focusedIndex + delta;
		if (next < 0 || next >= this._visible.length) {
			return;
		}
		this._focusedIndex = next;
		this._reveal(next);
		this._render();
	}

	private _reveal(index: number): void {
		const top = index * ROW_HEIGHT;
		const bottom = top + ROW_HEIGHT;
		const viewTop = this._element.scrollTop;
		const viewBottom = viewTop + this._element.clientHeight;
		if (top < viewTop) {
			this._element.scrollTop = top;
		} else if (bottom > viewBottom) {
			this._element.scrollTop = bottom - this._element.clientHeight;
		}
	}
}
