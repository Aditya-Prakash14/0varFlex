// tests/snippetParser.test.ts — snippet templates in, literal text and tab stop offsets out.
//
// The case worth guarding is the unsupported one: a variable or a transform must come out as
// literal text, because the alternative is dropping characters from the user's file.

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { Position } from '../src/common/editor/common/core/position.js';
import { Range } from '../src/common/editor/common/core/range.js';
import {
	hasTabStops, nextTabStop, offsetToPosition, parseSnippet, previousTabStop, tabStopRanges
} from '../src/common/editor/common/model/snippetParser.js';

test('ordered tab stops, with $0 walked last', () => {
	const result = parseSnippet('if ($1) { $0 } else { $2 }');
	assert.equal(result.text, 'if () {  } else {  }');
	assert.deepEqual(result.tabStops.map(s => s.index), [1, 2, 0]);
	assert.deepEqual(result.tabStops[0].occurrences, [{ offset: 4, length: 0 }]);
});

test('placeholder default text is inserted and selected', () => {
	const result = parseSnippet('for (const ${1:item} of ${2:items})');
	assert.equal(result.text, 'for (const item of items)');
	assert.deepEqual(result.tabStops[0].occurrences, [{ offset: 11, length: 4 }]);
	assert.deepEqual(result.tabStops[1].occurrences, [{ offset: 19, length: 5 }]);
});

test('${1} is the same as $1', () => {
	assert.deepEqual(parseSnippet('a${1}b'), parseSnippet('a$1b'));
});

test('the same tab stop twice: both get the text, the first is first', () => {
	const result = parseSnippet('<${1:div}>text</$1>');
	assert.equal(result.text, '<div>text</div>');
	assert.equal(result.tabStops.length, 1);
	assert.deepEqual(result.tabStops[0].occurrences, [{ offset: 1, length: 3 }, { offset: 11, length: 3 }]);
});

test('escapes: \\$, \\\\ and \\} are literal', () => {
	assert.equal(parseSnippet('cost: \\$1').text, 'cost: $1');
	assert.equal(parseSnippet('\\\\$1').text, '\\');
	assert.equal(parseSnippet('${1:a\\}b}').text, 'a}b');
	assert.equal(parseSnippet('cost: \\$1').tabStops.length, 0);
});

test('no tab stops at all is visible to the caller', () => {
	const plain = parseSnippet('console.log()');
	assert.equal(plain.text, 'console.log()');
	assert.equal(hasTabStops(plain), false);
	assert.equal(hasTabStops(parseSnippet('$0')), true);
});

// These two tests used to assert the LIMITATIONS of a hand-written parser: that choices,
// variables, transforms and nesting all survived as literal text because none of them were
// supported. The parser is now VS Code's own (see src/vendor/vscode/README.md), so they assert
// the real behaviour instead. Keeping them pointed at the same templates is deliberate — it is
// the record of what vendoring actually bought.

test('choices resolve to their first option, and nesting yields both stops', () => {
	// `${1|a,b|}` — a choice the old parser left as literal text
	const choice = parseSnippet('${1|a,b|}');
	assert.equal(choice.text, 'a');
	assert.deepEqual(choice.tabStops.map(stop => stop.index), [1]);

	// `${1:${2:nested}}` — a nested placeholder, which the old parser could not see into
	const nested = parseSnippet('${1:${2:nested}}');
	assert.equal(nested.text, 'nested');
	assert.deepEqual(nested.tabStops.map(stop => stop.index), [1, 2]);
});

test('genuinely malformed templates are still left alone', () => {
	for (const template of ['${1:unterminated', '100% $ off']) {
		const result = parseSnippet(template);
		assert.equal(result.text, template, template);
		assert.equal(result.tabStops.length, 0, template);
	}
});

test('an unresolved variable renders empty — the documented cost of vendoring', () => {
	// No variable resolver is wired up yet, so a variable has no value and contributes no text.
	// This is the one way the vendored parser is WORSE than the hand-written one, which left
	// `$TM_FILENAME` as literal text. It is pinned here so the day a resolver lands, this test
	// fails and tells whoever wrote it to update the `shortcut:` note in snippetParser.ts.
	assert.equal(parseSnippet('$TM_FILENAME').text, '');
	const withStop = parseSnippet('// $TM_FILENAME\n${1:body}');
	assert.equal(withStop.text, '// \nbody');
	assert.deepEqual(withStop.tabStops[0].occurrences, [{ offset: 4, length: 4 }]);
});

test('offsets become model positions relative to the insert point', () => {
	assert.deepEqual(offsetToPosition('ab\ncd', 1, { lineNumber: 5, column: 3 }), new Position(5, 4));
	assert.deepEqual(offsetToPosition('ab\ncd', 3, { lineNumber: 5, column: 3 }), new Position(6, 1));
	assert.deepEqual(offsetToPosition('ab\ncd', 5, { lineNumber: 5, column: 3 }), new Position(6, 3));
});

test('tab stop ranges for a multi-line snippet', () => {
	const result = parseSnippet('function ${1:name}() {\n\t$0\n}');
	const ranges = tabStopRanges(result, { lineNumber: 10, column: 1 });
	assert.deepEqual(ranges[0], [new Range(10, 10, 10, 14)]);
	assert.deepEqual(ranges[1], [new Range(11, 2, 11, 2)]);
});

test('walking forward and backward stops at the ends', () => {
	const result = parseSnippet('$1 $2 $0');
	assert.equal(nextTabStop(result, 0), 1);
	assert.equal(nextTabStop(result, 1), 2);
	assert.equal(nextTabStop(result, 2), undefined);
	assert.equal(previousTabStop(result, 2), 1);
	assert.equal(previousTabStop(result, 0), undefined);
});

test('indexes above 9 sort numerically, not as strings', () => {
	assert.deepEqual(parseSnippet('$10 $2 $1').tabStops.map(s => s.index), [1, 2, 10]);
});
