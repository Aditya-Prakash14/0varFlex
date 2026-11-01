// src/renderer/workbench/services/search/browser/searchService.ts — the renderer half of the
// search stack, ported in shape from vs/workbench/services/search/common/searchService.ts:
// it normalizes the query, hands it to the `search` channel, and demultiplexes the channel's
// events back to the caller.
//
// Cancellation is the request id + `cancelSearch` pattern (the primitive ipc.ts deferred in 02):
// each query gets a fresh searchId, and batches whose id is not the active one are dropped — so
// a slow previous query cannot paint results over a newer one.
//
// shortcut: one query at a time, because one Search view is the only consumer. The reference's
// ISearchService supports concurrent queries (and file search alongside text search); upgrade
// when a second consumer (a quick text search picker) appears.

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { Disposable } from '../../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../../common/base/common/uri.js';
import {
	DEFAULT_MAX_RESULTS,
	IFileMatch,
	ISearchChannel,
	ISearchComplete,
	ITextQuery,
	toFileMatch
} from '../../../../../common/platform/search/common/search.js';

export class SearchService extends Disposable {

	private readonly _onDidFindMatches = this._register(new Emitter<readonly IFileMatch[]>());
	readonly onDidFindMatches: Event<readonly IFileMatch[]> = this._onDidFindMatches.event;

	private readonly _onDidComplete = this._register(new Emitter<ISearchComplete>());
	readonly onDidComplete: Event<ISearchComplete> = this._onDidComplete.event;

	private _activeId: string | undefined;
	private _sequence = 0;

	constructor(private readonly _channel: ISearchChannel) {
		super();

		// subscribe BEFORE any textSearch call: the channel does not buffer early emissions
		// (ipc.ts's documented shortcut), so a listener attached after the call would miss the
		// first batches of a fast search.
		this._register(this._channel.onDidFindMatches(event => {
			if (event.searchId !== this._activeId) {
				return; // a batch from a superseded query
			}
			this._onDidFindMatches.fire(event.matches.map(toFileMatch));
		}));

		this._register(this._channel.onDidCompleteSearch(event => {
			if (event.searchId !== this._activeId) {
				return;
			}
			this._activeId = undefined;
			this._onDidComplete.fire({ limitHit: event.limitHit, stats: event.stats, error: event.error });
		}));
	}

	get isSearching(): boolean {
		return this._activeId !== undefined;
	}

	/** starts a query, cancelling whatever was running; resolves once the engine has it */
	async textSearch(query: ITextQuery): Promise<void> {
		this.cancel();

		const searchId = `search-${++this._sequence}`;
		this._activeId = searchId;

		await this._channel.textSearch({
			searchId,
			pattern: query.contentPattern.pattern,
			isRegExp: !!query.contentPattern.isRegExp,
			isCaseSensitive: !!query.contentPattern.isCaseSensitive,
			isWordMatch: !!query.contentPattern.isWordMatch,
			folderPath: query.folder.fsPath,
			maxResults: query.maxResults ?? DEFAULT_MAX_RESULTS
		});
	}

	/**
	 * A one-shot query that does not touch the active slot, used by the staleness refresh to
	 * re-run a single file (`root` may be a file path). Resolves with everything it found.
	 */
	textSearchOnce(query: ITextQuery, root: URI): Promise<IFileMatch[]> {
		const searchId = `search-once-${++this._sequence}`;
		return new Promise<IFileMatch[]>(resolve => {
			const found: IFileMatch[] = [];
			const progress = this._channel.onDidFindMatches(event => {
				if (event.searchId === searchId) {
					found.push(...event.matches.map(toFileMatch));
				}
			});
			const complete = this._channel.onDidCompleteSearch(event => {
				if (event.searchId !== searchId) {
					return;
				}
				progress.dispose();
				complete.dispose();
				resolve(found);
			});

			void this._channel.textSearch({
				searchId,
				pattern: query.contentPattern.pattern,
				isRegExp: !!query.contentPattern.isRegExp,
				isCaseSensitive: !!query.contentPattern.isCaseSensitive,
				isWordMatch: !!query.contentPattern.isWordMatch,
				folderPath: root.fsPath,
				maxResults: query.maxResults ?? DEFAULT_MAX_RESULTS
			}).catch(() => {
				progress.dispose();
				complete.dispose();
				resolve([]);
			});
		});
	}

	cancel(): void {
		const searchId = this._activeId;
		if (searchId === undefined) {
			return;
		}
		this._activeId = undefined;
		void this._channel.cancelSearch(searchId);
	}

	override dispose(): void {
		this.cancel();
		super.dispose();
	}
}
