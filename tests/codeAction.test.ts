// tests/codeAction.test.ts — the pure half of Quick Fix: what the provider's wire actions become.
//
// The weight is on the conversion no eye catches: the wire is 0-based LSP, the editor 1-based, so
// a fix for line 1 column 1 must come out as (1,1) and not (0,0). The rest guards the two cases
// that would show an empty or a lying menu: a null/empty result, and an action with neither an
// edit nor a command.

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { URI } from '../src/common/base/common/uri.js';
import type { IWireCodeAction } from '../src/common/platform/extensions/common/extensionHostProtocol.js';
import {
	foreignResources, nextIndex, toCodeActionItems, toWorkspaceTextEdits
} from '../src/renderer/editor/contrib/codeAction/codeActionController.js';

const file = URI.file('/repo/a.ts');

function wireEdit(path: string, line: number, character: number, newText: string) {
	return {
		edits: [{
			resource: { scheme: 'file', path },
			textEdit: { range: { start: { line, character }, end: { line, character: character + 3 } }, newText }
		}]
	};
}

test('wire edits convert from 0-based LSP to 1-based editor ranges', () => {
	const edits = toWorkspaceTextEdits(wireEdit('/repo/a.ts', 0, 0, 'let'));
	assert.strictEqual(edits.length, 1);
	assert.strictEqual(edits[0].resource.toString(), file.toString());
	assert.strictEqual(edits[0].range.startLineNumber, 1);
	assert.strictEqual(edits[0].range.startColumn, 1);
	assert.strictEqual(edits[0].range.endLineNumber, 1);
	assert.strictEqual(edits[0].range.endColumn, 4);
	assert.strictEqual(edits[0].text, 'let');
});

test('no edit at all is an empty edit list, not a crash', () => {
	assert.deepStrictEqual(toWorkspaceTextEdits(undefined), []);
});

test('a null result offers nothing, so the menu never opens empty', () => {
	assert.deepStrictEqual(toCodeActionItems(null), []);
	assert.deepStrictEqual(toCodeActionItems([]), []);
});

test('an action with neither edit nor command is dropped', () => {
	const actions: IWireCodeAction[] = [
		{ title: 'Nothing to do' },
		{ title: '', edit: wireEdit('/repo/a.ts', 0, 0, 'x') },
		{ title: 'Convert to let', edit: wireEdit('/repo/a.ts', 2, 4, 'let') }
	];
	const items = toCodeActionItems(actions);
	assert.deepStrictEqual(items.map(item => item.title), ['Convert to let']);
	assert.strictEqual(items[0].edits[0].range.startLineNumber, 3);
	assert.strictEqual(items[0].edits[0].range.startColumn, 5);
});

test('a command-only action is kept, with no edits and its command id', () => {
	const items = toCodeActionItems([{ title: 'Run fix', command: { id: 'toy.fix', args: [1] } }]);
	assert.strictEqual(items.length, 1);
	assert.deepStrictEqual(items[0].edits, []);
	assert.strictEqual(items[0].commandId, 'toy.fix');
});

test('preferred actions come first, and ties keep provider order', () => {
	const edit = wireEdit('/repo/a.ts', 0, 0, 'x');
	const items = toCodeActionItems([
		{ title: 'a', edit },
		{ title: 'b', edit, isPreferred: true },
		{ title: 'c', edit },
		{ title: 'd', edit, isPreferred: true }
	]);
	assert.deepStrictEqual(items.map(item => item.title), ['b', 'd', 'a', 'c']);
});

test('edits outside the active file are reported, each file once', () => {
	const edits = [
		...toWorkspaceTextEdits(wireEdit('/repo/a.ts', 0, 0, 'x')),
		...toWorkspaceTextEdits(wireEdit('/repo/b.ts', 0, 0, 'y')),
		...toWorkspaceTextEdits(wireEdit('/repo/b.ts', 1, 0, 'z'))
	];
	assert.deepStrictEqual(foreignResources(edits, file), ['b.ts']);
	assert.deepStrictEqual(foreignResources(toWorkspaceTextEdits(wireEdit('/repo/a.ts', 0, 0, 'x')), file), []);
});

test('menu navigation wraps in both directions', () => {
	assert.strictEqual(nextIndex(2, 1, 3), 0);
	assert.strictEqual(nextIndex(0, -1, 3), 2);
	assert.strictEqual(nextIndex(0, 1, 1), 0);
	assert.strictEqual(nextIndex(0, -1, 0), 0);
});
