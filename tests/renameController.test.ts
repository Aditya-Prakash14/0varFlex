// tests/renameController.test.ts — the pure logic the rename box adds on top of
// renameValidation.ts and workspaceEdit.ts: the 0-based wire → 1-based editor conversion of a
// WorkspaceEdit, and which range/text the box seeds itself from. An off-by-one here renames the
// wrong characters, which is the one failure a rename must never have.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renameSeed, resourceFromWire, toWorkspaceTextEdits } from '../src/renderer/editor/contrib/rename/renameController.js';

function wireRange(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
	return { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } };
}

test('toWorkspaceTextEdits converts 0-based wire ranges to 1-based editor ranges', () => {
	const result = toWorkspaceTextEdits({
		edits: [{ resource: { scheme: 'file', path: '/a.ts' }, textEdit: { range: wireRange(0, 4, 0, 7), newText: 'bar' } }]
	});
	assert.ok(result.ok);
	const edit = result.edits[0];
	assert.equal(edit.range.startLineNumber, 1);
	assert.equal(edit.range.startColumn, 5);
	assert.equal(edit.range.endColumn, 8);
	assert.equal(edit.text, 'bar');
});

test('toWorkspaceTextEdits keeps every edit of a multi-file answer', () => {
	const result = toWorkspaceTextEdits({
		edits: [
			{ resource: { scheme: 'file', path: '/a.ts' }, textEdit: { range: wireRange(0, 0, 0, 3), newText: 'x' } },
			{ resource: { scheme: 'file', path: '/b.ts' }, textEdit: { range: wireRange(2, 1, 2, 4), newText: 'x' } }
		]
	});
	assert.ok(result.ok);
	assert.equal(result.edits.length, 2);
});

test('toWorkspaceTextEdits rejects an impossible range instead of throwing', () => {
	const result = toWorkspaceTextEdits({
		edits: [{ resource: { scheme: 'file', path: '/a.ts' }, textEdit: { range: wireRange(5, 2, 1, 0), newText: 'x' } }]
	});
	assert.ok(!result.ok);
	assert.match(result.rejectReason, /Invalid range/);
});

test('resourceFromWire keeps a non-file scheme', () => {
	assert.equal(resourceFromWire({ scheme: 'file', path: '/a.ts' }).scheme, 'file');
	assert.equal(resourceFromWire({ scheme: 'untitled', path: 'Untitled-1' }).scheme, 'untitled');
});

test('renameSeed prefers the provider placeholder, converted to 1-based', () => {
	const seed = renameSeed({ range: wireRange(0, 4, 0, 7), text: 'foo' }, 'let foo = 1', { lineNumber: 1, column: 6 });
	assert.deepEqual(seed, {
		range: { startLineNumber: 1, startColumn: 5, endLineNumber: 1, endColumn: 8 },
		text: 'foo'
	});
});

test('renameSeed falls back to the word at the cursor when the provider has no prepareRename', () => {
	const seed = renameSeed(null, 'let foo = 1', { lineNumber: 3, column: 6 });
	assert.equal(seed?.text, 'foo');
	assert.equal(seed?.range.startLineNumber, 3);
	assert.equal(seed?.range.startColumn, 5);
	assert.equal(seed?.range.endColumn, 8);
});

test('renameSeed is null off a word, so the box does not open', () => {
	assert.equal(renameSeed(null, '   ', { lineNumber: 1, column: 2 }), null);
});
