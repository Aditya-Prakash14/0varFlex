// tests/lineEdits.test.ts — the index arithmetic behind the line operations and comment toggling.
//
// Each test applies the returned edit to a plain string array, so it checks the DOCUMENT that
// results, not the edit's fields. An off-by-one in a column is only a bug if it corrupts text.

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { commentTokensFor } from '../src/common/editor/common/languages/languageConfiguration.js';
import {
	copyLines, deleteLines, firstNonWhitespaceColumn, ILineEdit, ILineSource,
	indentLines, moveLinesDown, moveLinesUp, toggleBlockComment, toggleLineComment
} from '../src/renderer/editor/contrib/linesOperations/lineEdits.js';

function source(text: string): ILineSource {
	const lines = text.split('\n');
	return {
		getLineCount: () => lines.length,
		getLineContent: (lineNumber: number) => {
			assert.ok(lineNumber >= 1 && lineNumber <= lines.length, `line ${lineNumber} out of range`);
			return lines[lineNumber - 1];
		}
	};
}

/** apply an edit the way the model would, so the test asserts on resulting text */
function apply(text: string, edit: ILineEdit | null): string {
	if (!edit) {
		return text;
	}
	const lines = text.split('\n');
	const offsetOf = (lineNumber: number, column: number): number => {
		let offset = 0;
		for (let i = 1; i < lineNumber; i++) {
			offset += lines[i - 1].length + 1;
		}
		return offset + column - 1;
	};
	const start = offsetOf(edit.startLineNumber, edit.startColumn);
	const end = offsetOf(edit.endLineNumber, edit.endColumn);
	return text.slice(0, start) + edit.text + text.slice(end);
}

const SPACES = { tabSize: 4, insertSpaces: true };
const TABS = { tabSize: 4, insertSpaces: false };

// ---- moveLines

test('moveLinesUp swaps a single line with the one above', () => {
	const text = 'a\nb\nc';
	const edit = moveLinesUp(source(text), 2, 2);
	assert.equal(apply(text, edit), 'b\na\nc');
	assert.deepEqual([edit!.selectionStartLine, edit!.selectionEndLine], [1, 1]);
});

test('moveLinesUp moves a block and keeps its internal order', () => {
	const text = 'a\nb\nc\nd';
	assert.equal(apply(text, moveLinesUp(source(text), 3, 4)), 'a\nc\nd\nb');
});

test('moveLinesUp is a no-op on the first line', () => {
	assert.equal(moveLinesUp(source('a\nb'), 1, 1), null);
});

test('moveLinesDown swaps a single line with the one below', () => {
	const text = 'a\nb\nc';
	const edit = moveLinesDown(source(text), 2, 2);
	assert.equal(apply(text, edit), 'a\nc\nb');
	assert.deepEqual([edit!.selectionStartLine, edit!.selectionEndLine], [3, 3]);
});

test('moveLinesDown moves a block onto the last line without losing the break', () => {
	const text = 'a\nb\nc\nd';
	assert.equal(apply(text, moveLinesDown(source(text), 2, 3)), 'a\nd\nb\nc');
});

test('moveLinesDown is a no-op on the last line', () => {
	assert.equal(moveLinesDown(source('a\nb'), 2, 2), null);
});

test('moveLinesUp then moveLinesDown returns the original text', () => {
	const text = 'one\ntwo\nthree\nfour';
	const up = apply(text, moveLinesUp(source(text), 3, 3));
	assert.equal(apply(up, moveLinesDown(source(up), 2, 2)), text);
});

// ---- copyLines

test('copyLines duplicates a line and selects the lower copy going down', () => {
	const text = 'a\nb';
	const edit = copyLines(source(text), 1, 1, 'down');
	assert.equal(apply(text, edit), 'a\na\nb');
	assert.deepEqual([edit.selectionStartLine, edit.selectionEndLine], [2, 2]);
});

test('copyLines selects the upper copy going up', () => {
	const edit = copyLines(source('a\nb'), 1, 1, 'up');
	assert.deepEqual([edit.selectionStartLine, edit.selectionEndLine], [1, 1]);
});

test('copyLines duplicates a block and shifts the selection by its height', () => {
	const text = 'a\nb\nc';
	const edit = copyLines(source(text), 1, 2, 'down');
	assert.equal(apply(text, edit), 'a\nb\na\nb\nc');
	assert.deepEqual([edit.selectionStartLine, edit.selectionEndLine], [3, 4]);
});

test('copyLines works on the last line, which has no trailing break', () => {
	const text = 'a\nb';
	assert.equal(apply(text, copyLines(source(text), 2, 2, 'down')), 'a\nb\nb');
});

// ---- deleteLines

test('deleteLines removes a middle line and its break', () => {
	const text = 'a\nb\nc';
	assert.equal(apply(text, deleteLines(source(text), 2, 2)), 'a\nc');
});

test('deleteLines removes a block', () => {
	const text = 'a\nb\nc\nd';
	assert.equal(apply(text, deleteLines(source(text), 2, 3)), 'a\nd');
});

test('deleteLines on the last line leaves no trailing blank line', () => {
	const text = 'a\nb\nc';
	const edit = deleteLines(source(text), 3, 3);
	assert.equal(apply(text, edit), 'a\nb');
	assert.equal(edit.selectionStartLine, 2);
});

test('deleteLines on a single-line document empties it', () => {
	assert.equal(apply('only', deleteLines(source('only'), 1, 1)), '');
});

test('deleteLines over the whole document empties it', () => {
	const text = 'a\nb\nc';
	assert.equal(apply(text, deleteLines(source(text), 1, 3)), '');
});

// ---- indentLines

test('indentLines adds one unit of spaces', () => {
	const text = 'a\nb';
	assert.equal(apply(text, indentLines(source(text), 1, 2, 'indent', SPACES)), '    a\n    b');
});

test('indentLines adds a tab when insertSpaces is off', () => {
	assert.equal(apply('a', indentLines(source('a'), 1, 1, 'indent', TABS)), '\ta');
});

test('indentLines leaves blank lines alone rather than adding trailing whitespace', () => {
	const text = 'a\n\nb';
	assert.equal(apply(text, indentLines(source(text), 1, 3, 'indent', SPACES)), '    a\n\n    b');
});

test('outdentLines removes exactly one unit', () => {
	const text = '        a';
	assert.equal(apply(text, indentLines(source(text), 1, 1, 'outdent', SPACES)), '    a');
});

test('outdentLines never eats non-whitespace', () => {
	assert.equal(indentLines(source('a'), 1, 1, 'outdent', SPACES), null);
});

test('outdentLines removes a partial indent without going negative', () => {
	assert.equal(apply('  a', indentLines(source('  a'), 1, 1, 'outdent', SPACES)), 'a');
});

test('outdentLines with tabs set strips up to a tab stop of spaces', () => {
	assert.equal(apply('      a', indentLines(source('      a'), 1, 1, 'outdent', TABS)), '  a');
});

test('outdentLines returns null when no line can be outdented', () => {
	const text = 'a\nb';
	assert.equal(indentLines(source(text), 1, 2, 'outdent', SPACES), null);
});

test('indent then outdent round-trips', () => {
	const text = 'if (x) {\n    y();\n}';
	const indented = apply(text, indentLines(source(text), 1, 3, 'indent', SPACES));
	assert.equal(apply(indented, indentLines(source(indented), 1, 3, 'outdent', SPACES)), text);
});

// ---- comment tokens

test('commentTokensFor maps known extensions and defaults to slashes', () => {
	assert.equal(commentTokensFor('a/b/c.ts').line, '//');
	assert.equal(commentTokensFor('script.PY').line, '#');
	assert.equal(commentTokensFor('page.html').blockStart, '<!--');
	assert.equal(commentTokensFor('style.css').line, undefined);
	assert.equal(commentTokensFor('no-extension').line, '//');
	assert.equal(commentTokensFor('').line, '//');
});

test('firstNonWhitespaceColumn is 1-based and handles an all-whitespace line', () => {
	assert.equal(firstNonWhitespaceColumn('abc'), 1);
	assert.equal(firstNonWhitespaceColumn('  abc'), 3);
	assert.equal(firstNonWhitespaceColumn('\tabc'), 2);
	assert.equal(firstNonWhitespaceColumn('   '), 4);
	assert.equal(firstNonWhitespaceColumn(''), 1);
});

// ---- toggleLineComment

const TS = commentTokensFor('x.ts');

test('toggleLineComment comments a single line', () => {
	assert.equal(apply('a();', toggleLineComment(source('a();'), 1, 1, TS)), '// a();');
});

test('toggleLineComment uncomments a commented line, including its one space', () => {
	assert.equal(apply('// a();', toggleLineComment(source('// a();'), 1, 1, TS)), 'a();');
});

test('toggleLineComment uncomments a line with no space after the token', () => {
	assert.equal(apply('//a();', toggleLineComment(source('//a();'), 1, 1, TS)), 'a();');
});

test('toggleLineComment comments a mixed selection in full rather than flipping each line', () => {
	const text = 'a();\n// b();\nc();';
	assert.equal(
		apply(text, toggleLineComment(source(text), 1, 3, TS)),
		'// a();\n// // b();\n// c();'
	);
});

test('toggleLineComment uncomments only when every non-blank line is commented', () => {
	const text = '// a();\n\n// b();';
	assert.equal(apply(text, toggleLineComment(source(text), 1, 3, TS)), 'a();\n\nb();');
});

test('toggleLineComment inserts at the shallowest indent, so relative indentation survives', () => {
	// the tokens line up at the block's own indent and the deeper line keeps its extra indent —
	// jamming each token against its own line would flatten the block's shape
	const text = '    a();\n        b();';
	assert.equal(
		apply(text, toggleLineComment(source(text), 1, 2, TS)),
		'    // a();\n    //     b();'
	);
});

test('toggleLineComment round-trips an indented block', () => {
	const text = '  a();\n      b();\n  c();';
	const commented = apply(text, toggleLineComment(source(text), 1, 3, TS));
	assert.equal(apply(commented, toggleLineComment(source(commented), 1, 3, TS)), text);
});

test('toggleLineComment leaves a blank-only selection alone', () => {
	assert.equal(toggleLineComment(source('\n\n'), 1, 3, TS), null);
});

test('toggleLineComment returns null for a language with no line comment', () => {
	assert.equal(toggleLineComment(source('a'), 1, 1, commentTokensFor('x.css')), null);
});

// ---- toggleBlockComment

test('toggleBlockComment wraps a single line', () => {
	assert.equal(apply('a();', toggleBlockComment(source('a();'), 1, 1, TS)), '/* a(); */');
});

test('toggleBlockComment unwraps what it wrapped', () => {
	const text = 'a();\nb();';
	const wrapped = apply(text, toggleBlockComment(source(text), 1, 2, TS));
	assert.equal(wrapped, '/* a();\nb(); */');
	assert.equal(apply(wrapped, toggleBlockComment(source(wrapped), 1, 2, TS)), text);
});

test('toggleBlockComment uses the HTML tokens for an html file', () => {
	const tokens = commentTokensFor('page.html');
	assert.equal(apply('<p/>', toggleBlockComment(source('<p/>'), 1, 1, tokens)), '<!-- <p/> -->');
});

test('toggleBlockComment returns null when the language has no block comment', () => {
	assert.equal(toggleBlockComment(source('a'), 1, 1, commentTokensFor('x.py')), null);
});

test('toggleBlockComment does not treat a lone token as a finished comment', () => {
	// `/*` alone starts with the opener and does not end with the closer: it must be wrapped
	assert.equal(apply('/*', toggleBlockComment(source('/*'), 1, 1, TS)), '/* /* */');
});
