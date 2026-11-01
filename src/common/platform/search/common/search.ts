// src/common/platform/search/common/search.ts — the search contract, ported in subset from
// vs/workbench/services/search/common/search.ts:
//
//   - ITextQuery: the pattern + its toggles + one folder root + a result ceiling;
//   - IFileMatch: one file with its matches, which is the unit the results tree renders;
//   - ITextSearchMatch: a line preview plus the UTF-16 range the editor will select.
//
// The reference's ISearchService splits textSearch/fileSearch and registers providers per scheme;
// ours is text-only over the local disk, which is the honest subset.
//
// shortcut: single-folder queries — the reference's ITextQuery carries `folderQueries: []` and a
// per-folder results root (folderQuerySearchTree.ts). Upgrade with multi-root workspaces.
// shortcut: no include/exclude globs and no replace. rg's defaults honour .gitignore, which is
// what the course's samples want; upgrade when a "files to include" input is added.

import { URI } from '../../../base/common/uri.js';

/** the real default: DEFAULT_MAX_SEARCH_RESULTS in the reference's search.ts */
export const DEFAULT_MAX_RESULTS = 20000;

/** the real default of `search.searchOnTypeDebouncePeriod` */
export const SEARCH_ON_TYPE_DEBOUNCE = 300;

export interface IPatternInfo {
	readonly pattern: string;
	readonly isRegExp?: boolean;
	readonly isCaseSensitive?: boolean;
	readonly isWordMatch?: boolean;
}

export interface ITextQuery {
	readonly contentPattern: IPatternInfo;
	readonly folder: URI;
	readonly maxResults?: number;
}

/**
 * One match inside one file. `range` is 1-based and in UTF-16 code units, so it can be handed
 * straight to the editor as a selection — the byte→UTF-16 conversion happens in the rg parser.
 */
export interface ITextSearchMatch {
	readonly previewText: string;
	readonly lineNumber: number;
	readonly startColumn: number;
	readonly endColumn: number;
}

export interface IFileMatch {
	readonly resource: URI;
	readonly matches: readonly ITextSearchMatch[];
}

export interface ISearchStats {
	readonly fileCount: number;
	readonly matchCount: number;
}

export interface ISearchComplete {
	readonly limitHit: boolean;
	readonly stats: ISearchStats;
	/** set when the engine itself failed (a bad regex, rg missing and the fallback threw) */
	readonly error?: string;
}

// ---- the wire shapes: JSON-safe only (paths are strings — see ipc.electron.ts's note on why
// URIs do not survive structured clone)

export interface IWireTextQuery {
	readonly searchId: string;
	readonly pattern: string;
	readonly isRegExp: boolean;
	readonly isCaseSensitive: boolean;
	readonly isWordMatch: boolean;
	readonly folderPath: string;
	readonly maxResults: number;
}

export interface IWireFileMatch {
	readonly path: string;
	readonly matches: readonly ITextSearchMatch[];
}

/** a batch of matches for one search; `searchId` is how the renderer demultiplexes */
export interface IWireSearchProgress {
	readonly searchId: string;
	readonly matches: readonly IWireFileMatch[];
}

export interface IWireSearchComplete {
	readonly searchId: string;
	readonly limitHit: boolean;
	readonly stats: ISearchStats;
	readonly error?: string;
}

/**
 * The `search` channel. Cancellation is a request id plus a `cancelSearch` call rather than a
 * CancellationToken threaded through `IChannel.call` — the shape the reference's searchService
 * uses over its own wire, and the cancellation primitive ipc.ts deferred in 02.
 */
export interface ISearchChannel {
	/** starts a search; resolves as soon as the engine is spawned, not when it finishes */
	textSearch(query: IWireTextQuery): Promise<void>;
	cancelSearch(searchId: string): Promise<void>;
	readonly onDidFindMatches: import('../../../base/common/event.js').Event<IWireSearchProgress>;
	readonly onDidCompleteSearch: import('../../../base/common/event.js').Event<IWireSearchComplete>;
}

export function toFileMatch(wire: IWireFileMatch): IFileMatch {
	return { resource: URI.file(wire.path), matches: wire.matches };
}
