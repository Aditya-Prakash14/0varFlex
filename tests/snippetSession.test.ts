// tests/snippetSession.test.ts — the live part of a snippet session: where the tab stops sit in
// the model after the insert, and which content change is allowed to keep the session alive.
//
// This is the logic that decides whether Tab walks the stops or inserts a tab, so the cases that
// matter are the ones that must END the session: an edit outside the current stop, and an edit
// that straddles it.

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { Range } from '../src/common/editor/common/core/range.js';
import { parseSnippet } from '../src/common/editor/common/model/snippetParser.js';
import {
	isAtLastStop, sessionAfterChange, snippetSessionAt
} from '../src/renderer/editor/contrib/snippet/snippetController.js';

/** a content change as the model reports it; the range is unused by the session logic */
function change(rangeOffset: number, rangeLength: number, text: string) {
	return { range: new Range(1, 1, 1, 1), rangeOffset, rangeLength, text };
}

test('stops land at model offsets, shifted by the insert point', () => {
	const session = snippetSessionAt(parseSnippet('for (const ${1:item} of ${2:items}) {\n\t$0\n}'), 100);
	assert.deepEqual(session.stops[0], [{ offset: 111, length: 4 }]);
	assert.deepEqual(session.stops[1], [{ offset: 119, length: 5 }]);
	// after "…) {\n\t": one line break before it
	assert.deepEqual(session.stops[2], [{ offset: 129, length: 0 }]);
	assert.equal(session.ordinal, 0);
});

test('a CRLF model pushes every stop along by one per preceding line break', () => {
	const result = parseSnippet('a$1\nb$2\nc$0');
	const lf = snippetSessionAt(result, 0, 1);
	const crlf = snippetSessionAt(result, 0, 2);
	assert.deepEqual(lf.stops.map(group => group[0].offset), [1, 3, 5]);
	assert.deepEqual(crlf.stops.map(group => group[0].offset), [1, 4, 7]);
});

test('a placeholder spanning a line break measures with the model EOL', () => {
	const session = snippetSessionAt(parseSnippet('${1:a\nb}$2'), 0, 2);
	assert.deepEqual(session.stops[0], [{ offset: 0, length: 4 }]);
	assert.deepEqual(session.stops[1], [{ offset: 4, length: 0 }]);
});

test('isAtLastStop: the final stop ends the walk', () => {
	assert.equal(isAtLastStop(snippetSessionAt(parseSnippet('a$1b'), 0)), true);
	const two = snippetSessionAt(parseSnippet('a$1b$0'), 0);
	assert.equal(isAtLastStop(two), false);
	assert.equal(isAtLastStop({ stops: two.stops, ordinal: 1 }), true);
});

test('typing inside the current stop grows it and shifts the later ones', () => {
	const session = snippetSessionAt(parseSnippet('${1:a}-${2:b}-$0'), 10);
	// replace the one-character placeholder with three characters
	const next = sessionAfterChange(session, change(10, 1, 'xyz'));
	assert.ok(next);
	assert.deepEqual(next.stops[0], [{ offset: 10, length: 3 }]);
	assert.deepEqual(next.stops[1], [{ offset: 14, length: 1 }]);
	assert.deepEqual(next.stops[2], [{ offset: 16, length: 0 }]);
	assert.equal(next.ordinal, 0);
});

test('an insert into an empty stop keeps the session', () => {
	const session = snippetSessionAt(parseSnippet('a$1b$0'), 0);
	const next = sessionAfterChange(session, change(1, 0, 'q'));
	assert.ok(next);
	assert.deepEqual(next.stops[0], [{ offset: 1, length: 1 }]);
	assert.deepEqual(next.stops[1], [{ offset: 3, length: 0 }]);
});

test('an edit outside the snippet ends the session', () => {
	const session = snippetSessionAt(parseSnippet('${1:a}-${2:b}'), 10);
	assert.equal(sessionAfterChange(session, change(0, 0, 'x')), null);
	assert.equal(sessionAfterChange(session, change(30, 0, 'x')), null);
});

test('an edit in a different stop ends the session', () => {
	const session = snippetSessionAt(parseSnippet('${1:a}-${2:b}'), 0);
	// the $2 placeholder sits at offset 2 and this session is still on $1
	assert.equal(sessionAfterChange(session, change(2, 1, 'z')), null);
});

test('an edit straddling the current stop ends the session', () => {
	const session = snippetSessionAt(parseSnippet('x${1:ab}y'), 0);
	// selects the placeholder plus the character before it
	assert.equal(sessionAfterChange(session, change(0, 3, '')), null);
	// and the character after it
	assert.equal(sessionAfterChange(session, change(1, 3, '')), null);
});

test('deleting the whole placeholder leaves an empty stop, still live', () => {
	const session = snippetSessionAt(parseSnippet('x${1:ab}y$0'), 0);
	const next = sessionAfterChange(session, change(1, 2, ''));
	assert.ok(next);
	assert.deepEqual(next.stops[0], [{ offset: 1, length: 0 }]);
	assert.deepEqual(next.stops[1], [{ offset: 2, length: 0 }]);
});

test('a repeated stop: the later occurrence tracks position, and the walk stays correct', () => {
	const session = snippetSessionAt(parseSnippet('<${1:div}>$2</$1>$0'), 0);
	assert.deepEqual(session.stops[0], [{ offset: 1, length: 3 }, { offset: 7, length: 3 }]);
	const next = sessionAfterChange(session, change(1, 3, 'span'));
	assert.ok(next);
	assert.deepEqual(next.stops[0], [{ offset: 1, length: 4 }, { offset: 8, length: 3 }]);
	assert.deepEqual(next.stops[1], [{ offset: 6, length: 0 }]);
});
