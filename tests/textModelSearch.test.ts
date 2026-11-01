// In-model search: the matching rules the find widget depends on.
//
// Every one of these is a case a naive implementation gets wrong, and each would show up as
// "find is subtly broken" rather than a crash.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Range } from '../src/common/editor/common/core/range.js';
import { TextModel } from '../src/common/editor/common/model/textModel.js';
import {
	createSearchRegExp,
	escapeRegExpCharacters,
	expandReplacement,
	findMatches,
	indexOfMatchNear,
	isWholeWordMatch,
	type IFindMatch,
	type ISearchableModel
} from '../src/common/editor/common/model/textModelSearch.js';

/** the separators the editor actually uses (the renderer's word helper owns the constant) */
const SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';

function model(...lines: string[]): ISearchableModel {
	return {
		getLineCount: () => lines.length,
		getLineContent: (lineNumber: number) => lines[lineNumber - 1]
	};
}

function ranges(matches: readonly IFindMatch[]): string[] {
	return matches.map(m => `${m.range.startLineNumber}:${m.range.startColumn}-${m.range.endColumn}`);
}

// ---- literal search

test('literal search finds every occurrence, in document order', () => {
	const result = findMatches(model('foo bar foo', 'baz', 'foo'), {
		searchString: 'foo', isRegExp: false, matchCase: false, wholeWord: false
	});
	assert.deepEqual(ranges(result.matches), ['1:1-4', '1:9-12', '3:1-4']);
	assert.equal(result.limitHit, false);
});

test('literal search treats regex metacharacters as literal text', () => {
	// the single most common find bug: searching for `a.b` matching `axb`
	const result = findMatches(model('a.b and axb'), {
		searchString: 'a.b', isRegExp: false, matchCase: false, wholeWord: false
	});
	assert.deepEqual(ranges(result.matches), ['1:1-4']);
});

test('literal search for a string of metacharacters works', () => {
	const result = findMatches(model('cost: $1.00 (approx)'), {
		searchString: '$1.00 (approx)', isRegExp: false, matchCase: false, wholeWord: false
	});
	assert.equal(result.matches.length, 1);
});

test('case sensitivity is honoured both ways', () => {
	const insensitive = findMatches(model('Foo foo FOO'), {
		searchString: 'foo', isRegExp: false, matchCase: false, wholeWord: false
	});
	assert.equal(insensitive.matches.length, 3);

	const sensitive = findMatches(model('Foo foo FOO'), {
		searchString: 'foo', isRegExp: false, matchCase: true, wholeWord: false
	});
	assert.deepEqual(ranges(sensitive.matches), ['1:5-8']);
});

// ---- regex search

test('regex search applies the pattern, and an invalid one finds nothing instead of throwing', () => {
	const found = findMatches(model('a1 b22 c333'), {
		searchString: '[a-z]\\d+', isRegExp: true, matchCase: false, wholeWord: false
	});
	assert.deepEqual(ranges(found.matches), ['1:1-3', '1:4-7', '1:8-12']);

	// the widget calls this on every keystroke, so a half-typed regex must not break anything
	const broken = findMatches(model('anything'), {
		searchString: '(unclosed', isRegExp: true, matchCase: false, wholeWord: false
	});
	assert.deepEqual(broken.matches, []);
	assert.equal(createSearchRegExp({ searchString: '(unclosed', isRegExp: true, matchCase: false, wholeWord: false }), null);
});

test('a zero-width regex does not hang the editor', () => {
	// `^`, `\b` and an empty group all match without consuming — the classic infinite loop
	for (const pattern of ['^', '\\b', 'x*']) {
		const result = findMatches(model('abc', 'def'), {
			searchString: pattern, isRegExp: true, matchCase: false, wholeWord: false
		}, { limit: 50 });
		// it must terminate; whether it reports matches is secondary
		assert.ok(result.matches.length <= 50, `${pattern} must terminate`);
	}
});

test('an empty search string finds nothing', () => {
	const result = findMatches(model('abc'), {
		searchString: '', isRegExp: false, matchCase: false, wholeWord: false
	});
	assert.deepEqual(result.matches, []);
});

// ---- whole word, which is where `\b` would have been wrong

test('whole word matches only standalone words', () => {
	const result = findMatches(model('foo foobar barfoo foo.bar'), {
		searchString: 'foo', isRegExp: false, matchCase: false, wholeWord: true, wordSeparators: SEPARATORS
	});
	// `foo` alone and the `foo` before the dot (a dot is a separator) — not inside foobar/barfoo
	assert.deepEqual(ranges(result.matches), ['1:1-4', '1:19-22']);
});

test('whole word uses the EDITOR separators, not JavaScript word boundaries', () => {
	// `$` is a word character to JS `\b` but a separator to the editor, so `\bfoo\b` would
	// wrongly fail to match `$foo` here. Searching for `foo` must find the one after the `$`.
	const result = findMatches(model('$foo'), {
		searchString: 'foo', isRegExp: false, matchCase: false, wholeWord: true, wordSeparators: SEPARATORS
	});
	assert.deepEqual(ranges(result.matches), ['1:2-5']);
});

test('whole word at the start and end of a line counts as a boundary', () => {
	const result = findMatches(model('foo', 'a foo', 'foo a'), {
		searchString: 'foo', isRegExp: false, matchCase: false, wholeWord: true, wordSeparators: SEPARATORS
	});
	assert.deepEqual(ranges(result.matches), ['1:1-4', '2:3-6', '3:1-4']);
});

test('isWholeWordMatch: a match that itself starts with a separator is not a word', () => {
	// searching for `.foo` with whole-word on must not match everywhere
	assert.equal(isWholeWordMatch('a.foo b', 1, 5, SEPARATORS), false);
	assert.equal(isWholeWordMatch('foo', 0, 3, SEPARATORS), true);
	assert.equal(isWholeWordMatch('foo', 0, 0, SEPARATORS), false, 'an empty span is not a word');
	assert.equal(isWholeWordMatch('a foo b', 2, 5, SEPARATORS), true);
	assert.equal(isWholeWordMatch('afoo b', 1, 4, SEPARATORS), false);
});

// ---- limits and ranges

test('the match limit is respected and reported', () => {
	const lines = Array.from({ length: 100 }, () => 'x x x');
	const result = findMatches(model(...lines), {
		searchString: 'x', isRegExp: false, matchCase: false, wholeWord: false
	}, { limit: 10 });
	assert.equal(result.matches.length, 10);
	assert.equal(result.limitHit, true, 'the widget says "more than N" from this');
});

test('a search range restricts matching, including mid-line', () => {
	const target = model('foo foo', 'foo foo', 'foo foo');
	// only the second line, from column 5 on
	const result = findMatches(target, {
		searchString: 'foo', isRegExp: false, matchCase: false, wholeWord: false
	}, { searchRange: new Range(2, 5, 2, 8) });
	assert.deepEqual(ranges(result.matches), ['2:5-8']);
});

test('captureMatches returns the groups only when asked', () => {
	const params = { searchString: '(\\w+)@(\\w+)', isRegExp: true, matchCase: false, wholeWord: false };
	const without = findMatches(model('me@here'), params);
	assert.equal(without.matches[0].matches, null);

	const withGroups = findMatches(model('me@here'), params, { captureMatches: true });
	assert.deepEqual(withGroups.matches[0].matches, ['me@here', 'me', 'here']);
});

// ---- navigation

test('indexOfMatchNear: Enter goes to the next match and wraps', () => {
	const matches = findMatches(model('foo', 'foo', 'foo'), {
		searchString: 'foo', isRegExp: false, matchCase: false, wholeWord: false
	}).matches;

	assert.equal(indexOfMatchNear(matches, { lineNumber: 1, column: 1 }), 0);
	assert.equal(indexOfMatchNear(matches, { lineNumber: 1, column: 2 }), 1);
	assert.equal(indexOfMatchNear(matches, { lineNumber: 3, column: 2 }), 0, 'wraps to the top');
	assert.equal(indexOfMatchNear([], { lineNumber: 1, column: 1 }), -1);
});

test('indexOfMatchNear: Shift+Enter goes backwards and wraps the other way', () => {
	const matches = findMatches(model('foo', 'foo', 'foo'), {
		searchString: 'foo', isRegExp: false, matchCase: false, wholeWord: false
	}).matches;

	assert.equal(indexOfMatchNear(matches, { lineNumber: 3, column: 1 }, false), 1);
	assert.equal(indexOfMatchNear(matches, { lineNumber: 1, column: 1 }, false), 2, 'wraps to the bottom');
});

// ---- replacement

test('expandReplacement: $1 works for a regex search and is literal otherwise', () => {
	const match = findMatches(model('name: Ada'), {
		searchString: '(\\w+): (\\w+)', isRegExp: true, matchCase: false, wholeWord: false
	}, { captureMatches: true }).matches[0];

	assert.equal(expandReplacement('$2 <- $1', match, true), 'Ada <- name');
	assert.equal(expandReplacement('$&!', match, true), 'name: Ada!');
	assert.equal(expandReplacement('$$1', match, true), '$1', 'an escaped dollar is literal');
	// in a literal search a dollar is a dollar — replacing a price must not eat it
	assert.equal(expandReplacement('$1', match, false), '$1');
});

test('expandReplacement: a reference to a group that did not participate becomes empty', () => {
	const match = findMatches(model('abc'), {
		searchString: '(a)(z)?', isRegExp: true, matchCase: false, wholeWord: false
	}, { captureMatches: true }).matches[0];
	assert.equal(expandReplacement('[$1][$2]', match, true), '[a][]');
});

test('escapeRegExpCharacters neutralizes what a literal search must not interpret', () => {
	assert.equal(escapeRegExpCharacters('a.b*c'), 'a\\.b\\*c');
	assert.ok(new RegExp(escapeRegExpCharacters('a+b')).test('a+b'));
	assert.ok(!new RegExp(escapeRegExpCharacters('a+b')).test('aab'));
});

// ---- through the real model

test('TextModel.findMatches searches the live buffer and follows edits', () => {
	const textModel = new TextModel('alpha\nbeta\nalpha\n');

	const before = textModel.findMatches({ searchString: 'alpha', isRegExp: false, matchCase: false, wholeWord: false });
	assert.deepEqual(ranges(before.matches), ['1:1-6', '3:1-6']);

	// an edit must be visible to the next search — this is why it lives on the model
	textModel.applyEdits([{ range: new Range(1, 1, 1, 6), text: 'gamma' }]);
	const after = textModel.findMatches({ searchString: 'alpha', isRegExp: false, matchCase: false, wholeWord: false });
	assert.deepEqual(ranges(after.matches), ['3:1-6']);
});
