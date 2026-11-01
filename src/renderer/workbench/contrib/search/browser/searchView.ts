// src/renderer/workbench/contrib/search/browser/searchView.ts — the Search composite, ported in
// shape from vs/workbench/contrib/search/browser/searchView.ts (+ searchWidget.ts for the input
// row and patternInputWidget.ts for the toggle buttons):
//
//   - the query row: an input plus the three toggles the real widget carries (match case,
//     whole word, regex), each a button that re-runs the query;
//   - search-on-type with the reference's real debounce (search.searchOnTypeDebouncePeriod,
//     default 300ms); Enter searches immediately, Escape cancels and clears;
//   - streaming results: batches from the engine are merged into the tree as they arrive;
//   - the message line carries the counts, the "no results" state, the result-limit notice and
//     engine errors — the limit is never silently swallowed;
//   - staleness: a save under the search root re-runs that ONE file and patches its node; a
//     delete drops the node.
//
// delta: the real toggles are codicon buttons inside the input; ours are text buttons beside it.
// delta: no replace row, no files-to-include/exclude inputs, no search editor.
//
// shortcut: the single-file re-run on save re-queries the whole root and keeps only that file's
// matches, because the engine takes a folder. Upgrade by letting ITextQuery take a file root.

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { Disposable } from '../../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../../common/base/common/uri.js';
import { FileChangeType, FileChangesEvent } from '../../../../../common/platform/files/common/files.js';
import type { ILogService } from '../../../../../common/platform/log/common/log.js';
import {
	IFileMatch,
	ISearchComplete,
	ITextQuery,
	ITextSearchMatch,
	SEARCH_ON_TYPE_DEBOUNCE
} from '../../../../../common/platform/search/common/search.js';
import type { IWorkspaceFolder } from '../../../../../common/platform/workspace/common/workspace.js';
import { addDisposableListener, append, $ } from '../../../../base/browser/dom.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import type { SearchService } from '../../../services/search/browser/searchService.js';
import { ISearchResultFile, SearchResultsTree } from './searchResultsTree.js';

export const SearchViewFocusContext = new RawContextKey<boolean>('searchViewFocus', false);
export const SearchInputFocusContext = new RawContextKey<boolean>('searchInputFocus', false);

export interface ISearchViewServices {
	readonly searchService: SearchService;
	readonly contextKeyService: IContextKeyService;
	readonly logService: ILogService;
	/** the workspace root to search, read at query time so a folder change is picked up */
	getFolder(): IWorkspaceFolder | undefined;
	openMatch(resource: URI, match: ITextSearchMatch, options: { preserveFocus: boolean }): void;
}

export class SearchView extends Disposable {

	readonly element: HTMLElement;

	private readonly _input: HTMLInputElement;
	private readonly _message: HTMLElement;
	private readonly _tree: SearchResultsTree;
	private readonly _toggles = new Map<'case' | 'word' | 'regex', HTMLElement>();

	private readonly _viewFocusKey: IContextKey<boolean>;
	private readonly _inputFocusKey: IContextKey<boolean>;

	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;

	private _isCaseSensitive = false;
	private _isWordMatch = false;
	private _isRegExp = false;
	private _searching = false;
	/** the query the current results belong to, so a refresh can re-run it */
	private _lastPattern = '';

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState: Event<void> = this._onDidChangeState.event;

	constructor(container: HTMLElement, private readonly _services: ISearchViewServices) {
		super();

		this.element = append(container, $('.search-view'));

		// ---- the query row
		const queryRow = append(this.element, $('.search-query-row'));
		this._input = append(queryRow, $<HTMLInputElement>('input.search-input', {
			type: 'text',
			placeholder: 'Search',
			spellcheck: 'false',
			'aria-label': 'Search across files'
		}));

		const toggleRow = append(queryRow, $('.search-toggles'));
		this._addToggle(toggleRow, 'case', 'Aa', 'Match Case');
		this._addToggle(toggleRow, 'word', 'ab', 'Match Whole Word');
		this._addToggle(toggleRow, 'regex', '.*', 'Use Regular Expression');

		// ---- the actions row
		const actionsRow = append(this.element, $('.search-actions-row'));
		this._addAction(actionsRow, 'Refresh', () => void this.refresh());
		this._addAction(actionsRow, 'Clear', () => this.clear());

		this._message = append(this.element, $('.search-message'));

		// ---- the results
		this._tree = this._register(new SearchResultsTree(this.element, {
			openMatch: (file, match, options) => this._services.openMatch(file.resource, match, options)
		}));

		// ---- context keys the keybindings are scoped on
		this._viewFocusKey = SearchViewFocusContext.bindTo(_services.contextKeyService);
		this._inputFocusKey = SearchInputFocusContext.bindTo(_services.contextKeyService);
		this._register(this._tree.onDidFocusChange(() => this._updateFocusKeys()));

		this._register(addDisposableListener(this._input, 'focus', () => this._updateFocusKeys()));
		this._register(addDisposableListener(this._input, 'blur', () => this._updateFocusKeys()));

		this._register(addDisposableListener(this._input, 'input', () => this._scheduleSearch()));
		this._register(addDisposableListener(this._input, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				this._cancelDebounce();
				void this._runSearch();
			} else if (event.key === 'Escape') {
				event.preventDefault();
				this.clear();
			} else if (event.key === 'ArrowDown') {
				event.preventDefault();
				this._tree.focus();
			}
		}));

		// ---- engine events
		this._register(this._services.searchService.onDidFindMatches(matches => this._onMatches(matches)));
		this._register(this._services.searchService.onDidComplete(complete => this._onComplete(complete)));

		this._renderMessage('');
	}

	// ---- public surface used by the commands and the composite host

	focusInput(): void {
		this._input.focus();
		this._input.select();
	}

	focusResults(): void {
		this._tree.focus();
	}

	get pattern(): string {
		return this._input.value;
	}

	setPattern(pattern: string): void {
		this._input.value = pattern;
	}

	toggleCaseSensitive(): void {
		this._isCaseSensitive = !this._isCaseSensitive;
		this._updateToggles();
		this._cancelDebounce();
		void this._runSearch();
	}

	toggleWordMatch(): void {
		this._isWordMatch = !this._isWordMatch;
		this._updateToggles();
		this._cancelDebounce();
		void this._runSearch();
	}

	toggleRegExp(): void {
		this._isRegExp = !this._isRegExp;
		this._updateToggles();
		this._cancelDebounce();
		void this._runSearch();
	}

	/** re-run the current query from scratch */
	async refresh(): Promise<void> {
		this._cancelDebounce();
		await this._runSearch();
	}

	/** cancel anything running and drop the results (the real view's Clear action) */
	clear(): void {
		this._cancelDebounce();
		this._services.searchService.cancel();
		this._searching = false;
		this._input.value = '';
		this._lastPattern = '';
		this._tree.clear();
		this._renderMessage('');
		this._onDidChangeState.fire();
	}

	/** Escape in the tree cancels a running search without wiping the input */
	cancelSearch(): void {
		this._cancelDebounce();
		this._services.searchService.cancel();
		if (this._searching) {
			this._searching = false;
			this._renderMessage('Search cancelled.');
			this._onDidChangeState.fire();
		}
	}

	// ---- staleness (6): re-run one file on save, drop it on delete

	handleFileChanges(event: FileChangesEvent): void {
		if (!this._lastPattern) {
			return;
		}

		for (const change of event.changes) {
			if (!this._tree.hasFile(change.resource)) {
				continue;
			}
			if (change.type === FileChangeType.DELETED) {
				this._tree.removeFile(change.resource);
				this._renderCounts();
			} else {
				void this._refreshFile(change.resource);
			}
		}
	}

	// ---- internals

	private _addToggle(parent: HTMLElement, id: 'case' | 'word' | 'regex', label: string, title: string): void {
		const element = append(parent, $('span.search-toggle', { title, role: 'checkbox', tabindex: '0' }, label));
		this._toggles.set(id, element);
		const toggle = () => {
			if (id === 'case') {
				this.toggleCaseSensitive();
			} else if (id === 'word') {
				this.toggleWordMatch();
			} else {
				this.toggleRegExp();
			}
		};
		this._register(addDisposableListener(element, 'click', toggle));
		this._register(addDisposableListener(element, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				toggle();
			}
		}));
	}

	private _addAction(parent: HTMLElement, label: string, run: () => void): void {
		const element = append(parent, $('span.search-action', { title: label, tabindex: '0' }, label));
		this._register(addDisposableListener(element, 'click', run));
		this._register(addDisposableListener(element, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				run();
			}
		}));
	}

	private _updateToggles(): void {
		this._toggles.get('case')?.classList.toggle('checked', this._isCaseSensitive);
		this._toggles.get('word')?.classList.toggle('checked', this._isWordMatch);
		this._toggles.get('regex')?.classList.toggle('checked', this._isRegExp);
		this._toggles.get('case')?.setAttribute('aria-checked', String(this._isCaseSensitive));
		this._toggles.get('word')?.setAttribute('aria-checked', String(this._isWordMatch));
		this._toggles.get('regex')?.setAttribute('aria-checked', String(this._isRegExp));
	}

	private _updateFocusKeys(): void {
		const inputFocused = document.activeElement === this._input;
		this._inputFocusKey.set(inputFocused);
		this._viewFocusKey.set(inputFocused || this._tree.hasFocus());
	}

	private _scheduleSearch(): void {
		this._cancelDebounce();
		// the reference's search.searchOnTypeDebouncePeriod default
		this._debounceTimer = setTimeout(() => {
			this._debounceTimer = undefined;
			void this._runSearch();
		}, SEARCH_ON_TYPE_DEBOUNCE);
	}

	private _cancelDebounce(): void {
		if (this._debounceTimer !== undefined) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = undefined;
		}
	}

	private async _runSearch(): Promise<void> {
		const pattern = this._input.value;
		const folder = this._services.getFolder();

		this._tree.clear();

		if (!pattern) {
			this._services.searchService.cancel();
			this._searching = false;
			this._lastPattern = '';
			this._renderMessage('');
			this._onDidChangeState.fire();
			return;
		}

		if (!folder) {
			this._services.searchService.cancel();
			this._searching = false;
			this._lastPattern = '';
			this._renderMessage('Open a folder to search across files.');
			this._onDidChangeState.fire();
			return;
		}

		this._lastPattern = pattern;
		this._searching = true;
		this._renderMessage('Searching…');
		this._onDidChangeState.fire();

		const query: ITextQuery = {
			contentPattern: {
				pattern,
				isRegExp: this._isRegExp,
				isCaseSensitive: this._isCaseSensitive,
				isWordMatch: this._isWordMatch
			},
			folder: folder.uri
		};

		try {
			await this._services.searchService.textSearch(query);
		} catch (error) {
			this._searching = false;
			this._renderMessage(`Search failed: ${(error as Error).message}`);
			this._services.logService.error(error as Error);
			this._onDidChangeState.fire();
		}
	}

	private _onMatches(matches: readonly IFileMatch[]): void {
		const folder = this._services.getFolder();
		this._tree.addFiles(matches.map(match => this._toResultFile(match, folder)));
		this._renderCounts();
	}

	private _onComplete(complete: ISearchComplete): void {
		this._searching = false;

		if (complete.error) {
			this._renderMessage(`Search failed: ${complete.error}`, 'error');
			this._onDidChangeState.fire();
			return;
		}

		if (this._tree.matchCount === 0) {
			this._renderMessage(`No results found for "${this._lastPattern}".`);
			this._onDidChangeState.fire();
			return;
		}

		this._renderCounts(complete.limitHit);
		this._onDidChangeState.fire();
	}

	private _toResultFile(match: IFileMatch, folder: IWorkspaceFolder | undefined): ISearchResultFile {
		const fsPath = match.resource.fsPath;
		const separator = fsPath.includes('\\') ? '\\' : '/';
		const segments = fsPath.split(/[\\/]/);
		const name = segments[segments.length - 1] || fsPath;

		// the dimmed description is the containing directory relative to the search root
		let description = segments.slice(0, -1).join(separator);
		const rootPath = folder?.uri.fsPath;
		if (rootPath && description.startsWith(rootPath)) {
			description = description.slice(rootPath.length).replace(/^[\\/]+/, '');
		}

		return {
			resource: match.resource,
			name,
			description,
			matches: [...match.matches],
			expanded: true // the real view expands files by default
		};
	}

	/** re-run the query against ONE file and patch its node (task 6's incremental update) */
	private async _refreshFile(resource: URI): Promise<void> {
		if (!this._lastPattern) {
			return;
		}

		const query: ITextQuery = {
			contentPattern: {
				pattern: this._lastPattern,
				isRegExp: this._isRegExp,
				isCaseSensitive: this._isCaseSensitive,
				isWordMatch: this._isWordMatch
			},
			folder: resource // the engine accepts a file root
		};

		const found = await this._services.searchService.textSearchOnce(query, resource);

		// the results may have been cleared or replaced while we were awaiting
		if (!this._tree.hasFile(resource)) {
			return;
		}

		const matches = found.find(file => file.resource.fsPath === resource.fsPath)?.matches ?? [];
		this._tree.replaceFileMatches(resource, [...matches]);
		this._renderCounts();
	}

	private _renderCounts(limitHit = false): void {
		const matches = this._tree.matchCount;
		const files = this._tree.fileCount;
		if (matches === 0) {
			this._renderMessage(this._searching ? 'Searching…' : '');
			return;
		}
		const base = `${matches} result${matches === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}`;
		if (limitHit) {
			// never truncate silently — the reference shows the limit notice too
			this._renderMessage(`${base} — Result limit reached. Narrow the query to see the rest.`, 'warning');
		} else {
			this._renderMessage(this._searching ? `${base}…` : base);
		}
	}

	private _renderMessage(text: string, kind?: 'warning' | 'error'): void {
		this._message.textContent = text;
		this._message.classList.toggle('warning', kind === 'warning');
		this._message.classList.toggle('error', kind === 'error');
		this._message.classList.toggle('empty', !text);
	}

	override dispose(): void {
		this._cancelDebounce();
		super.dispose();
	}
}
