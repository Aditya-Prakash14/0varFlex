// The view geometry (the 5 asserts the exercise asks for) and the toy tokenizer.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { expandTabs, ViewModel } from '../src/renderer/editor/browser/viewModel.js';
import { tokenizeLine, TokenType } from '../src/renderer/editor/browser/tokenizer.js';

test('view geometry: line height, tops, total height', () => {
	const viewModel = new ViewModel({ lineHeight: 19, charWidth: 7, tabSize: 4, lineCount: 100 });
	assert.equal(viewModel.getLineTop(1), 0);
	assert.equal(viewModel.getLineTop(50), 49 * 19);
	assert.equal(viewModel.getTotalHeight(), 100 * 19);
});

test('view geometry: visible range from scroll with one line of overscan', () => {
	const viewModel = new ViewModel({ lineHeight: 20, charWidth: 7, tabSize: 4, lineCount: 1000 });

	let viewport = viewModel.getViewport(0, 400);
	assert.equal(viewport.startLineNumber, 1);
	assert.equal(viewport.endLineNumber, 21, '20 visible + 1 overscan');

	viewport = viewModel.getViewport(2000, 400);
	assert.equal(viewport.startLineNumber, 100, 'floor(top/lineHeight) + 1 − overscan');
	assert.equal(viewport.endLineNumber, 121);
});

test('view geometry: tab expansion keeps a model-column map', () => {
	const line = expandTabs('\tfoo\tx', 4);
	assert.equal(line.rendered, '    foo x');
	// model column (1-based) → rendered column
	assert.deepEqual(line.columns, [0, 4, 5, 6, 7, 8, 9]);
});

test('view geometry: x ↔ column round trips with tabs, nearest boundary on ties', () => {
	const viewModel = new ViewModel({ lineHeight: 19, charWidth: 10, tabSize: 4, lineCount: 1 });

	// x inside the tab region rounds to the nearest boundary (the tab stop)
	assert.equal(viewModel.getColumnForX('\tfoo', 35), 2);
	assert.equal(viewModel.getColumnForX('\tfoo', 20), 1);
	assert.equal(viewModel.getColumnForX('\tfoo', 40), 2);
	assert.equal(viewModel.getColumnForX('\tfoo', 100), 5, 'clamped to line length + 1');

	// column → x uses the expanded grid
	assert.equal(viewModel.getXForColumn('\tfoo', 2), 40);
	assert.equal(viewModel.getXForColumn('\tfoo', 5), 70);
});

test('view geometry: visible columns count full tab stops', () => {
	const viewModel = new ViewModel({ lineHeight: 19, charWidth: 7, tabSize: 4, lineCount: 1 });
	assert.equal(viewModel.visibleColumnFromColumn('ab\tc', 3), 2);
	assert.equal(viewModel.visibleColumnFromColumn('ab\tc', 4), 4);
	assert.equal(viewModel.visibleColumnFromColumn('ab\tc', 5), 5);
	assert.equal(viewModel.columnFromVisibleColumn('ab\tc', 4), 4);
	assert.equal(viewModel.columnFromVisibleColumn('ab\tc', 3), 3, 'nearest boundary wins');
});

test('tokenizer: keywords, numbers, strings, comments, operators', () => {
	const result = tokenizeLine('const x = "hi"; // note 42', false);
	const typed = result.tokens.map(token => [token.type, 'const x = "hi"; // note 42'.substring(token.start, token.end)]);

	assert.deepEqual(typed, [
		[TokenType.Keyword, 'const'],
		[TokenType.Operator, '='],
		[TokenType.String, '"hi"'],
		[TokenType.Operator, ';'],
		[TokenType.Comment, '// note 42']
	]);
	assert.equal(result.inBlockComment, false);
});

test('tokenizer: block comments carry state across lines', () => {
	const first = tokenizeLine('code /* open', false);
	assert.equal(first.inBlockComment, true);
	assert.equal(first.tokens.at(-1)?.type, TokenType.Comment);

	const middle = tokenizeLine('still comment', true);
	assert.equal(middle.tokens.length, 1);
	assert.equal(middle.tokens[0].type, TokenType.Comment);

	const last = tokenizeLine('done */ const x', true);
	assert.equal(last.inBlockComment, false);
	const kinds = last.tokens.map(token => token.type);
	assert.deepEqual(kinds, [TokenType.Comment, TokenType.Keyword]);
});

test('tokenizer: string escapes do not end the string', () => {
	const result = tokenizeLine('const s = "a\\"b";', false);
	const stringToken = result.tokens.find(token => token.type === TokenType.String);
	assert.equal(stringToken && 'const s = "a\\"b";'.substring(stringToken.start, stringToken.end), '"a\\"b"');
});
