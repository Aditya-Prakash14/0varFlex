// src/main/search/ripgrepSearch.ts — the search engine, ported in shape from
// vs/workbench/services/search/node/ripgrepTextSearchEngine.ts (+ ripgrepSearchUtils.ts):
//
//   - the arg builder mirrors the reference's getRgArgs: --hidden --no-require-git, the case
//     flag, --crlf, --regexp vs --fixed-strings, --no-config, --json, then `--` and the folder;
//   - stdout is a stream of newline-delimited JSON events; we parse `match` events tolerantly
//     and ignore the rest (begin/end/summary/context), exactly as the reference's parser does;
//   - rg's submatch offsets are UTF-8 BYTE offsets into the line. Editor ranges are UTF-16 code
//     units, so byteOffsetToUtf16 is the one true conversion in this file (tested);
//   - results are batched, not sent per match (the reference batches too — its
//     rawSearchService.ts uses BATCH_SIZE 512 for file search);
//   - exit code 1 means "no matches" and is NOT an error (rg's contract).
//
// delta: the reference ships a per-platform rg binary inside the app and resolves its path; we
// take rg from PATH and fall back to a plain-JS scanner when it is absent, so the view works on a
// machine without ripgrep.
// delta: the reference routes search through worker processes to keep parse load off the UI host;
// we spawn from the main process directly (the exercise allows it).
//
// shortcut: no persistent rg daemon — one process per query, reaped on cancel/complete.
// shortcut: lines rg reports as `bytes` (not valid UTF-8) are skipped rather than decoded.

import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { Emitter, Event } from '../../common/base/common/event.js';
import { Disposable, toDisposable } from '../../common/base/common/lifecycle.js';
import type { ILogService } from '../../common/platform/log/common/log.js';
import {
	DEFAULT_MAX_RESULTS,
	ISearchStats,
	ITextSearchMatch,
	IWireFileMatch,
	IWireSearchComplete,
	IWireSearchProgress,
	IWireTextQuery
} from '../../common/platform/search/common/search.js';

/** batch every N matches or MS milliseconds, whichever comes first (the exercise's constants) */
const BATCH_SIZE = 25;
const BATCH_DELAY = 100;

/** files larger than this are skipped by the JS fallback (rg has its own --max-filesize) */
const FALLBACK_MAX_FILE_SIZE = 10 * 1024 * 1024;

/** the JS fallback has no .gitignore parser, so it skips the usual suspects by name */
const FALLBACK_SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '.test-out', '.cache']);

// ---- pure helpers (exported for tests)

/**
 * Convert a UTF-8 byte offset into a UTF-16 code-unit index for the same line.
 *
 * rg counts bytes; the editor counts code units, so `é` (2 bytes, 1 unit) and `😀` (4 bytes,
 * 2 units) both shift the two apart. An offset landing mid-codepoint rounds up to the next
 * boundary — rg never emits one, so that case only guards against malformed input.
 */
export function byteOffsetToUtf16(line: string, byteOffset: number): number {
	if (byteOffset <= 0) {
		return 0;
	}
	let bytes = 0;
	let index = 0;
	while (index < line.length && bytes < byteOffset) {
		const code = line.codePointAt(index)!;
		bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
		index += code > 0xFFFF ? 2 : 1;
	}
	return index;
}

export interface IParsedMatch {
	readonly path: string;
	readonly lineNumber: number;
	readonly previewText: string;
	readonly matches: readonly ITextSearchMatch[];
}

/**
 * Parse one line of `rg --json` output. Returns the match it describes, or undefined for every
 * other event kind (begin/end/summary/context) and for anything that does not parse — a search
 * must not die because one stdout line was unexpected.
 */
export function parseRipgrepLine(line: string): IParsedMatch | undefined {
	const trimmed = line.trim();
	if (!trimmed) {
		return undefined;
	}

	let event: any;
	try {
		event = JSON.parse(trimmed);
	} catch {
		return undefined; // tolerant: a partial or non-JSON line is skipped
	}

	if (!event || event.type !== 'match' || !event.data) {
		return undefined;
	}

	const data = event.data;
	const filePath: unknown = data.path?.text;
	const lineText: unknown = data.lines?.text;
	// a path or line rg could only give us as bytes is not valid UTF-8 — skip it
	if (typeof filePath !== 'string' || typeof lineText !== 'string') {
		return undefined;
	}

	const lineNumber: unknown = data.line_number;
	if (typeof lineNumber !== 'number' || lineNumber < 1) {
		return undefined;
	}

	// strip the trailing newline rg includes in the line text
	const previewText = lineText.replace(/\r?\n$/, '');

	const submatches: unknown = data.submatches;
	if (!Array.isArray(submatches) || submatches.length === 0) {
		return undefined;
	}

	const matches: ITextSearchMatch[] = [];
	for (const submatch of submatches) {
		const start: unknown = submatch?.start;
		const end: unknown = submatch?.end;
		if (typeof start !== 'number' || typeof end !== 'number') {
			continue;
		}
		matches.push({
			previewText,
			lineNumber,
			// +1: the editor's columns are 1-based
			startColumn: byteOffsetToUtf16(previewText, start) + 1,
			endColumn: byteOffsetToUtf16(previewText, end) + 1
		});
	}

	return matches.length > 0 ? { path: filePath, lineNumber, previewText, matches } : undefined;
}

/** mirrors the reference's getRgArgs for the subset of options we expose */
export function buildRgArgs(query: IWireTextQuery): string[] {
	const args = ['--hidden', '--no-require-git'];
	args.push(query.isCaseSensitive ? '--case-sensitive' : '--ignore-case');
	args.push('--crlf');

	if (query.isWordMatch) {
		const body = query.isRegExp ? query.pattern : escapeRegExp(query.pattern);
		args.push('--regexp', `\\b(?:${body})\\b`);
	} else if (query.isRegExp) {
		args.push('--regexp', query.pattern);
	} else {
		args.push('--fixed-strings', '--regexp', query.pattern);
	}

	args.push('--no-config', '--json');
	args.push('--', query.folderPath);
	return args;
}

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** the pattern the JS fallback matches with; throws on a bad user regex (reported as an error) */
export function createSearchRegExp(query: IWireTextQuery): RegExp {
	let source = query.isRegExp ? query.pattern : escapeRegExp(query.pattern);
	if (query.isWordMatch) {
		source = `\\b(?:${source})\\b`;
	}
	return new RegExp(source, query.isCaseSensitive ? 'g' : 'gi');
}

// ---- the engine

interface IActiveSearch {
	child?: ChildProcessWithoutNullStreams;
	cancelled: boolean;
	matchCount: number;
	readonly files: Set<string>;
	limitHit: boolean;
	/** pending matches grouped per file, flushed as one batch */
	pending: IWireFileMatch[];
	pendingCount: number;
	timer?: ReturnType<typeof setTimeout>;
}

export class RipgrepSearchEngine extends Disposable {

	private readonly _onDidFindMatches = this._register(new Emitter<IWireSearchProgress>());
	readonly onDidFindMatches: Event<IWireSearchProgress> = this._onDidFindMatches.event;

	private readonly _onDidCompleteSearch = this._register(new Emitter<IWireSearchComplete>());
	readonly onDidCompleteSearch: Event<IWireSearchComplete> = this._onDidCompleteSearch.event;

	private readonly _active = new Map<string, IActiveSearch>();

	/**
	 * `_useRipgrep` false forces the JS fallback. Production passes true and degrades to the
	 * fallback when rg is missing; tests pass false so their results do not depend on whether
	 * the machine happens to have ripgrep (and on rg's .gitignore/--hidden behaviour).
	 */
	constructor(private readonly _logService: ILogService, private readonly _useRipgrep: boolean = true) {
		super();
		// a window reload must not leave rg processes behind
		this._register(toDisposable(() => {
			for (const searchId of [...this._active.keys()]) {
				this.cancelSearch(searchId);
			}
		}));
	}

	async textSearch(query: IWireTextQuery): Promise<void> {
		this.cancelSearch(query.searchId); // a new query replaces the previous one

		const search: IActiveSearch = {
			cancelled: false,
			matchCount: 0,
			files: new Set<string>(),
			limitHit: false,
			pending: [],
			pendingCount: 0
		};
		this._active.set(query.searchId, search);

		if (!query.pattern) {
			this._complete(query.searchId, undefined);
			return;
		}

		// validate the regex up front: a bad one is a user error, not a crash
		try {
			createSearchRegExp(query);
		} catch (error) {
			this._complete(query.searchId, (error as Error).message);
			return;
		}

		const maxResults = query.maxResults > 0 ? query.maxResults : DEFAULT_MAX_RESULTS;

		if (!this._useRipgrep) {
			void this._runFallback(query, maxResults);
			return;
		}

		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn('rg', buildRgArgs(query), { cwd: query.folderPath });
		} catch (error) {
			this._logService.info(`search: rg unavailable (${(error as Error).message}), using the JS fallback`);
			void this._runFallback(query, maxResults);
			return;
		}
		search.child = child;

		let spawnFailed = false;
		child.on('error', (error: NodeJS.ErrnoException) => {
			// ENOENT: no rg on PATH. Anything else is also unrecoverable for this child.
			spawnFailed = true;
			this._logService.info(`search: rg unavailable (${error.code ?? error.message}), using the JS fallback`);
			search.child = undefined;
			void this._runFallback(query, maxResults);
		});

		let buffer = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			if (search.cancelled || search.limitHit) {
				return;
			}
			buffer += chunk;
			// keep the trailing partial line in the buffer
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				const parsed = parseRipgrepLine(line);
				if (parsed) {
					this._addMatch(query.searchId, parsed, maxResults);
					if (search.limitHit) {
						this.cancelChildOnly(search);
						break;
					}
				}
			}
		});

		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => this._logService.info(`search: rg stderr: ${chunk.trim()}`));

		child.on('close', (code: number | null) => {
			if (spawnFailed || search.cancelled) {
				return; // the fallback owns completion, or the caller already cancelled
			}
			if (buffer.trim()) {
				const parsed = parseRipgrepLine(buffer);
				if (parsed) {
					this._addMatch(query.searchId, parsed, maxResults);
				}
			}
			// 0 = matches found, 1 = no matches (not an error), 2 = real error
			const error = code !== null && code > 1 ? `ripgrep exited with code ${code}` : undefined;
			this._complete(query.searchId, error);
		});
	}

	cancelSearch(searchId: string): void {
		const search = this._active.get(searchId);
		if (!search) {
			return;
		}
		search.cancelled = true;
		if (search.timer !== undefined) {
			clearTimeout(search.timer);
			search.timer = undefined;
		}
		this.cancelChildOnly(search);
		this._active.delete(searchId);
	}

	/** kill the child but keep the search registered (used when the result limit is reached) */
	private cancelChildOnly(search: IActiveSearch): void {
		const child = search.child;
		search.child = undefined;
		if (!child || child.killed) {
			return;
		}
		try {
			child.kill();
		} catch (error) {
			this._logService.info(`search: killing rg failed: ${(error as Error).message}`);
		}
	}

	// ---- batching

	private _addMatch(searchId: string, parsed: IParsedMatch, maxResults: number): void {
		const search = this._active.get(searchId);
		if (!search || search.cancelled || search.limitHit) {
			return;
		}

		// respect the ceiling exactly: take only as many as still fit, then stop
		const room = maxResults - search.matchCount;
		if (room <= 0) {
			search.limitHit = true;
			return;
		}
		const taken = parsed.matches.slice(0, room);
		search.matchCount += taken.length;
		search.files.add(parsed.path);
		if (taken.length < parsed.matches.length || search.matchCount >= maxResults) {
			search.limitHit = true;
		}

		// group consecutive matches for the same file into one wire entry
		const last = search.pending[search.pending.length - 1];
		if (last && last.path === parsed.path) {
			search.pending[search.pending.length - 1] = { path: last.path, matches: [...last.matches, ...taken] };
		} else {
			search.pending.push({ path: parsed.path, matches: taken });
		}
		search.pendingCount += taken.length;

		if (search.pendingCount >= BATCH_SIZE || search.limitHit) {
			this._flush(searchId);
		} else if (search.timer === undefined) {
			search.timer = setTimeout(() => this._flush(searchId), BATCH_DELAY);
		}
	}

	private _flush(searchId: string): void {
		const search = this._active.get(searchId);
		if (!search) {
			return;
		}
		if (search.timer !== undefined) {
			clearTimeout(search.timer);
			search.timer = undefined;
		}
		if (search.pending.length === 0) {
			return;
		}
		const matches = search.pending;
		search.pending = [];
		search.pendingCount = 0;
		if (!search.cancelled) {
			this._onDidFindMatches.fire({ searchId, matches });
		}
	}

	private _complete(searchId: string, error: string | undefined): void {
		const search = this._active.get(searchId);
		if (!search || search.cancelled) {
			return;
		}
		this._flush(searchId);
		const stats: ISearchStats = { fileCount: search.files.size, matchCount: search.matchCount };
		const limitHit = search.limitHit;
		this._active.delete(searchId);
		this._onDidCompleteSearch.fire({ searchId, limitHit, stats, error });
	}

	// ---- the no-rg fallback: a plain-JS recursive scan

	private async _runFallback(query: IWireTextQuery, maxResults: number): Promise<void> {
		const search = this._active.get(query.searchId);
		if (!search || search.cancelled) {
			return;
		}

		let regexp: RegExp;
		try {
			regexp = createSearchRegExp(query);
		} catch (error) {
			this._complete(query.searchId, (error as Error).message);
			return;
		}

		try {
			// the root may be a single file: that is how the staleness refresh re-runs one file
			// (rg accepts a file path too, so the rg path needs no special case)
			const info = await stat(query.folderPath).catch(() => undefined);
			if (info?.isFile()) {
				await this._scanFile(query.searchId, query.folderPath, regexp, maxResults);
			} else {
				await this._scanDirectory(query.searchId, query.folderPath, regexp, maxResults);
			}
		} catch (error) {
			this._complete(query.searchId, (error as Error).message);
			return;
		}
		this._complete(query.searchId, undefined);
	}

	private async _scanDirectory(searchId: string, dir: string, regexp: RegExp, maxResults: number): Promise<void> {
		const search = this._active.get(searchId);
		if (!search || search.cancelled || search.limitHit) {
			return;
		}

		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return; // unreadable directory: skip it, like rg does
		}

		for (const entry of entries) {
			const current = this._active.get(searchId);
			if (!current || current.cancelled || current.limitHit) {
				return;
			}
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!FALLBACK_SKIP_DIRS.has(entry.name)) {
					await this._scanDirectory(searchId, full, regexp, maxResults);
				}
			} else if (entry.isFile()) {
				await this._scanFile(searchId, full, regexp, maxResults);
			}
		}
	}

	private async _scanFile(searchId: string, file: string, regexp: RegExp, maxResults: number): Promise<void> {
		try {
			const info = await stat(file);
			if (info.size > FALLBACK_MAX_FILE_SIZE) {
				return;
			}
			const buffer = await readFile(file);
			// rg skips binaries; a NUL in the first 8KB is the cheap version of that test
			if (buffer.subarray(0, 8192).includes(0)) {
				return;
			}
			const text = buffer.toString('utf8');
			const lines = text.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const search = this._active.get(searchId);
				if (!search || search.cancelled || search.limitHit) {
					return;
				}
				const previewText = lines[i].replace(/\r$/, '');
				regexp.lastIndex = 0;
				const matches: ITextSearchMatch[] = [];
				let found: RegExpExecArray | null;
				while ((found = regexp.exec(previewText)) !== null) {
					matches.push({
						previewText,
						lineNumber: i + 1,
						startColumn: found.index + 1,
						endColumn: found.index + found[0].length + 1
					});
					if (found[0].length === 0) {
						regexp.lastIndex++; // a zero-width match would loop forever
					}
				}
				if (matches.length > 0) {
					this._addMatch(searchId, { path: file, lineNumber: i + 1, previewText, matches }, maxResults);
				}
			}
		} catch {
			return; // unreadable file: skip
		}
	}
}
