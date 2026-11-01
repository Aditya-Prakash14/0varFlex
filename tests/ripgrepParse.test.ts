// The search engine's pure logic: the tolerant `rg --json` event parser, the UTF-8 byte offset →
// UTF-16 code-unit conversion (the one true conversion — an emoji line is the fixture), the arg
// builder, plus the engine's batching / limit / cancel behaviour over the JS fallback.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { Event } from '../src/common/base/common/event.js';
import type { ILogService } from '../src/common/platform/log/common/log.js';
import {
	buildRgArgs,
	byteOffsetToUtf16,
	createSearchRegExp,
	escapeRegExp,
	parseRipgrepLine,
	RipgrepSearchEngine
} from '../src/main/search/ripgrepSearch.js';
import type { IWireSearchComplete, IWireSearchProgress, IWireTextQuery } from '../src/common/platform/search/common/search.js';
import { trimPreview } from '../src/renderer/workbench/contrib/search/browser/searchResultsTree.js';

function makeLogService(): ILogService {
	return {
		_serviceBrand: undefined,
		onDidLog: Event.None,
		trace: () => { },
		info: () => { },
		warn: () => { },
		error: () => { }
	} as ILogService;
}

function query(overrides: Partial<IWireTextQuery> = {}): IWireTextQuery {
	return {
		searchId: 's1',
		pattern: 'needle',
		isRegExp: false,
		isCaseSensitive: false,
		isWordMatch: false,
		folderPath: '/folder',
		maxResults: 0,
		...overrides
	};
}

// ---- the byte → UTF-16 conversion

// 'héllo 😀 world' — byte layout: h=0, é=1..2, l=3, l=4, o=5, ' '=6, 😀=7..10, ' '=11, w=12
const EMOJI_LINE = 'héllo 😀 world';

test('byteOffsetToUtf16: ASCII offsets are identity', () => {
	assert.equal(byteOffsetToUtf16('hello', 0), 0);
	assert.equal(byteOffsetToUtf16('hello', 3), 3);
	assert.equal(byteOffsetToUtf16('hello', 5), 5);
});

test('byteOffsetToUtf16: a 2-byte char shifts byte and code-unit offsets apart', () => {
	// after 'hé' there are 3 bytes but 2 code units
	assert.equal(byteOffsetToUtf16(EMOJI_LINE, 3), 2);
});

test('byteOffsetToUtf16: an emoji is 4 bytes and 2 code units', () => {
	assert.equal(byteOffsetToUtf16(EMOJI_LINE, 7), 6);  // emoji starts at code unit 6
	assert.equal(byteOffsetToUtf16(EMOJI_LINE, 11), 8); // and ends at code unit 8
	assert.equal(byteOffsetToUtf16(EMOJI_LINE, 12), 9); // 'w' of world
});

test('byteOffsetToUtf16: the emoji range selects exactly the emoji', () => {
	const start = byteOffsetToUtf16(EMOJI_LINE, 7);
	const end = byteOffsetToUtf16(EMOJI_LINE, 11);
	assert.equal(EMOJI_LINE.slice(start, end), '😀');
});

test('byteOffsetToUtf16: a negative or zero offset is 0, and overshoot clamps to the end', () => {
	assert.equal(byteOffsetToUtf16(EMOJI_LINE, 0), 0);
	assert.equal(byteOffsetToUtf16(EMOJI_LINE, -5), 0);
	assert.equal(byteOffsetToUtf16(EMOJI_LINE, 9999), EMOJI_LINE.length);
});

// ---- the event parser

test('parseRipgrepLine: a match event yields a 1-based UTF-16 range', () => {
	const line = JSON.stringify({
		type: 'match',
		data: {
			path: { text: '/a/b.ts' },
			lines: { text: 'héllo 😀 world\n' },
			line_number: 3,
			absolute_offset: 42,
			submatches: [{ match: { text: '😀' }, start: 7, end: 11 }]
		}
	});

	const parsed = parseRipgrepLine(line);
	assert.ok(parsed);
	assert.equal(parsed.path, '/a/b.ts');
	assert.equal(parsed.lineNumber, 3);
	assert.equal(parsed.previewText, 'héllo 😀 world'); // the trailing newline is stripped
	assert.equal(parsed.matches.length, 1);
	// columns are 1-based: the emoji is code units 6..8, so columns 7..9
	assert.equal(parsed.matches[0].startColumn, 7);
	assert.equal(parsed.matches[0].endColumn, 9);
	// and that range slices the emoji back out of the preview
	assert.equal(parsed.previewText.slice(parsed.matches[0].startColumn - 1, parsed.matches[0].endColumn - 1), '😀');
});

test('parseRipgrepLine: several submatches on one line become several matches', () => {
	const line = JSON.stringify({
		type: 'match',
		data: {
			path: { text: '/a/b.ts' },
			lines: { text: 'needle and needle\n' },
			line_number: 1,
			submatches: [{ start: 0, end: 6 }, { start: 11, end: 17 }]
		}
	});
	const parsed = parseRipgrepLine(line);
	assert.ok(parsed);
	assert.equal(parsed.matches.length, 2);
	assert.deepEqual(parsed.matches.map(m => [m.startColumn, m.endColumn]), [[1, 7], [12, 18]]);
});

test('parseRipgrepLine: a CRLF line keeps no trailing \\r', () => {
	const line = JSON.stringify({
		type: 'match',
		data: { path: { text: '/a/b.ts' }, lines: { text: 'needle\r\n' }, line_number: 1, submatches: [{ start: 0, end: 6 }] }
	});
	assert.equal(parseRipgrepLine(line)!.previewText, 'needle');
});

test('parseRipgrepLine is tolerant: non-match events and junk are skipped, never thrown', () => {
	assert.equal(parseRipgrepLine(''), undefined);
	assert.equal(parseRipgrepLine('   '), undefined);
	assert.equal(parseRipgrepLine('not json at all'), undefined);
	assert.equal(parseRipgrepLine('{"type":"begin","data":{"path":{"text":"/a/b.ts"}}}'), undefined);
	assert.equal(parseRipgrepLine('{"type":"end","data":{"stats":{"matches":2}}}'), undefined);
	assert.equal(parseRipgrepLine('{"type":"summary","data":{}}'), undefined);
	// a match with no submatches carries no range, so there is nothing to render
	assert.equal(parseRipgrepLine('{"type":"match","data":{"path":{"text":"/a"},"lines":{"text":"x"},"line_number":1,"submatches":[]}}'), undefined);
	// a line rg could only give as bytes (invalid UTF-8) is skipped
	assert.equal(parseRipgrepLine('{"type":"match","data":{"path":{"text":"/a"},"lines":{"bytes":"//8="},"line_number":1,"submatches":[{"start":0,"end":1}]}}'), undefined);
	// a missing/!=number line_number is not renderable
	assert.equal(parseRipgrepLine('{"type":"match","data":{"path":{"text":"/a"},"lines":{"text":"x"},"submatches":[{"start":0,"end":1}]}}'), undefined);
});

// ---- the arg builder

test('buildRgArgs mirrors the reference flags, and puts the folder after --', () => {
	const args = buildRgArgs(query({ pattern: 'foo' }));
	assert.ok(args.includes('--hidden'));
	assert.ok(args.includes('--no-require-git'));
	assert.ok(args.includes('--ignore-case'));
	assert.ok(args.includes('--crlf'));
	assert.ok(args.includes('--no-config'));
	assert.ok(args.includes('--json'));
	assert.ok(args.includes('--fixed-strings'));
	// the folder is the last arg, immediately after the -- separator
	assert.equal(args[args.length - 1], '/folder');
	assert.equal(args[args.length - 2], '--');
	// no --no-ignore: rg's defaults honour .gitignore, which is what users want
	assert.ok(!args.includes('--no-ignore'));
});

test('buildRgArgs: case sensitivity, regex and whole-word change the pattern flags', () => {
	assert.ok(buildRgArgs(query({ isCaseSensitive: true })).includes('--case-sensitive'));

	const regex = buildRgArgs(query({ pattern: 'a+b', isRegExp: true }));
	assert.ok(regex.includes('--regexp'));
	assert.ok(!regex.includes('--fixed-strings'));
	assert.equal(regex[regex.indexOf('--regexp') + 1], 'a+b');

	// whole-word wraps in \b, escaping the pattern when it is not already a regex
	const word = buildRgArgs(query({ pattern: 'a.b', isWordMatch: true }));
	assert.equal(word[word.indexOf('--regexp') + 1], '\\b(?:a\\.b)\\b');
});

test('escapeRegExp neutralizes the metacharacters a literal search must not interpret', () => {
	assert.equal(escapeRegExp('a.b*c'), 'a\\.b\\*c');
	assert.ok(new RegExp(escapeRegExp('a.b')).test('a.b'));
	assert.ok(!new RegExp(escapeRegExp('a.b')).test('axb'));
});

test('createSearchRegExp: literal by default, case-insensitive unless asked', () => {
	assert.ok(createSearchRegExp(query({ pattern: 'NEEDLE' })).test('needle'));
	assert.ok(!createSearchRegExp(query({ pattern: 'NEEDLE', isCaseSensitive: true })).test('needle'));
	assert.ok(createSearchRegExp(query({ pattern: 'a.c', isRegExp: true })).test('abc'));
	assert.ok(!createSearchRegExp(query({ pattern: 'a.c' })).test('abc')); // literal: the dot is a dot
});

test('createSearchRegExp: an invalid regex throws so the engine can report it', () => {
	assert.throws(() => createSearchRegExp(query({ pattern: '(unclosed', isRegExp: true })));
});

// ---- the engine, over the JS fallback (no rg needed)

async function withTempTree(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), '0varflex-search-'));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** drive the engine with rg forced to be unavailable, so the fallback runs deterministically */
function runFallbackSearch(engine: RipgrepSearchEngine, wireQuery: IWireTextQuery): Promise<{ progress: IWireSearchProgress[]; complete: IWireSearchComplete }> {
	return new Promise(resolve => {
		const progress: IWireSearchProgress[] = [];
		const p = engine.onDidFindMatches(event => progress.push(event));
		const c = engine.onDidCompleteSearch(complete => {
			p.dispose();
			c.dispose();
			resolve({ progress, complete });
		});
		void engine.textSearch(wireQuery);
	});
}

test('engine: an empty pattern completes immediately with no matches', async () => {
	const engine = new RipgrepSearchEngine(makeLogService(), false);
	const { progress, complete } = await runFallbackSearch(engine, query({ pattern: '', folderPath: tmpdir() }));
	assert.equal(progress.length, 0);
	assert.equal(complete.stats.matchCount, 0);
	assert.equal(complete.limitHit, false);
	assert.equal(complete.error, undefined);
	engine.dispose();
});

test('engine: an invalid regex completes with an error, not a throw', async () => {
	const engine = new RipgrepSearchEngine(makeLogService(), false);
	const { complete } = await runFallbackSearch(engine, query({ pattern: '(unclosed', isRegExp: true, folderPath: tmpdir() }));
	assert.ok(complete.error, 'expected an error on the completion event');
	assert.equal(complete.stats.matchCount, 0);
	engine.dispose();
});

test('engine: no matches is a clean completion, not an error (rg exit code 1)', async () => {
	await withTempTree(async dir => {
		await writeFile(path.join(dir, 'a.txt'), 'nothing here\n');
		const engine = new RipgrepSearchEngine(makeLogService(), false);
		const { progress, complete } = await runFallbackSearch(engine, query({ pattern: 'zzz-absent', folderPath: dir }));
		assert.equal(progress.length, 0);
		assert.equal(complete.error, undefined);
		assert.equal(complete.stats.matchCount, 0);
		assert.equal(complete.stats.fileCount, 0);
		engine.dispose();
	});
});

test('engine: matches are grouped per file and counted in the stats', async () => {
	await withTempTree(async dir => {
		await writeFile(path.join(dir, 'a.txt'), 'needle one\nplain\nneedle two\n');
		await writeFile(path.join(dir, 'b.txt'), 'needle three\n');
		await mkdir(path.join(dir, 'node_modules'));
		await writeFile(path.join(dir, 'node_modules', 'skipped.txt'), 'needle in node_modules\n');

		const engine = new RipgrepSearchEngine(makeLogService(), false);
		const { progress, complete } = await runFallbackSearch(engine, query({ pattern: 'needle', folderPath: dir }));

		const files = new Map<string, number>();
		for (const batch of progress) {
			for (const file of batch.matches) {
				files.set(file.path, (files.get(file.path) ?? 0) + file.matches.length);
			}
		}
		assert.equal(complete.stats.matchCount, 3);
		assert.equal(complete.stats.fileCount, 2, 'node_modules must be skipped by the fallback');
		assert.equal(files.get(path.join(dir, 'a.txt')), 2);
		assert.equal(files.get(path.join(dir, 'b.txt')), 1);
		// the line numbers and columns point at the real text
		assert.ok([...files.keys()].every(p => !p.includes('node_modules')));
		engine.dispose();
	});
});

test('engine: maxResults is respected exactly and reported as limitHit', async () => {
	await withTempTree(async dir => {
		await writeFile(path.join(dir, 'many.txt'), 'needle\n'.repeat(50));
		const engine = new RipgrepSearchEngine(makeLogService(), false);
		const { progress, complete } = await runFallbackSearch(engine, query({ pattern: 'needle', folderPath: dir, maxResults: 10 }));
		const total = progress.reduce((sum, batch) => sum + batch.matches.reduce((n, f) => n + f.matches.length, 0), 0);
		assert.equal(total, 10, 'must not deliver more than maxResults');
		assert.equal(complete.stats.matchCount, 10);
		assert.equal(complete.limitHit, true, 'hitting the ceiling must be reported, not silently truncated');
		engine.dispose();
	});
});

test('engine: a binary file is skipped', async () => {
	await withTempTree(async dir => {
		await writeFile(path.join(dir, 'bin.dat'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]));
		const engine = new RipgrepSearchEngine(makeLogService(), false);
		const { complete } = await runFallbackSearch(engine, query({ pattern: 'needle', folderPath: dir }));
		assert.equal(complete.stats.matchCount, 0, 'a NUL byte marks the file binary');
		engine.dispose();
	});
});

test('engine: cancel mid-stream stops delivery and emits no completion', async () => {
	await withTempTree(async dir => {
		// enough files that the scan cannot finish before cancelSearch lands
		for (let i = 0; i < 40; i++) {
			await writeFile(path.join(dir, `f${i}.txt`), 'needle\n'.repeat(80));
		}
		const engine = new RipgrepSearchEngine(makeLogService(), false);
		let completed = false;
		const batches: IWireSearchProgress[] = [];
		const p = engine.onDidFindMatches(event => batches.push(event));
		const c = engine.onDidCompleteSearch(() => { completed = true; });

		void engine.textSearch(query({ pattern: 'needle', folderPath: dir }));
		engine.cancelSearch('s1');
		const countAtCancel = batches.length;

		await new Promise(resolve => setTimeout(resolve, 150));

		assert.equal(completed, false, 'a cancelled search must not complete');
		assert.equal(batches.length, countAtCancel, 'no batches may arrive after cancel');
		p.dispose();
		c.dispose();
		engine.dispose();
	});
});

test('engine: a new query for the same id replaces the previous one', async () => {
	await withTempTree(async dir => {
		await writeFile(path.join(dir, 'a.txt'), 'alpha\nbeta\n');
		const engine = new RipgrepSearchEngine(makeLogService(), false);
		const completions: IWireSearchComplete[] = [];
		const c = engine.onDidCompleteSearch(event => completions.push(event));

		void engine.textSearch(query({ pattern: 'alpha', folderPath: dir }));
		const second = runFallbackSearch(engine, query({ pattern: 'beta', folderPath: dir }));
		const { complete } = await second;

		assert.equal(complete.stats.matchCount, 1);
		// the replaced search was cancelled, so only the second one completed
		assert.equal(completions.filter(e => e.searchId === 's1').length, 1);
		c.dispose();
		engine.dispose();
	});
});

// ---- the results tree's preview trimming (pure column math; the DOM part is not unit tested)

test('trimPreview: indentation is trimmed and the columns shift with it', () => {
	// '\t\tconst needle = 1' — the match starts at column 9 (0-based index 8)
	const line = '\t\tconst needle = 1';
	const { text, start, end } = trimPreview(line, 9, 15);
	assert.equal(text, 'const needle = 1');
	assert.equal(text.slice(start, end), 'needle');
});

test('trimPreview: a match INSIDE the indentation is not trimmed away', () => {
	// searching for a tab: the match is at column 1, inside the leading whitespace
	const line = '\t\tconst x = 1';
	const { text, start, end } = trimPreview(line, 1, 2);
	assert.equal(text, line, 'the line must not be trimmed past the match');
	assert.equal(text.slice(start, end), '\t');
});

test('trimPreview: a line with no indentation is unchanged', () => {
	const { text, start, end } = trimPreview('needle here', 1, 7);
	assert.equal(text, 'needle here');
	assert.equal(text.slice(start, end), 'needle');
});

test('trimPreview: an over-long line is clipped and the range clamped into it', () => {
	const line = 'x'.repeat(500) + 'needle';
	const { text, start, end } = trimPreview(line, 501, 507);
	assert.ok(text.length <= 300, 'the preview must be clipped');
	assert.equal(start, text.length, 'a match past the clip point collapses to the end');
	assert.equal(end, text.length);
	assert.equal(text.slice(start, end), '');
});

test('trimPreview: the highlight never extends past the text', () => {
	// a bogus end column (longer than the line) must still slice safely
	const { text, start, end } = trimPreview('short', 1, 999);
	assert.equal(end, text.length);
	assert.equal(text.slice(start, end), 'short');
});
