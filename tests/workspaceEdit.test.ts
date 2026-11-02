// tests/workspaceEdit.test.ts — grouping, ordering and overlap rejection for a multi-file edit.
//
// All pure, so a rename across three files is tested as data: no models, no widget. Two files are
// given a line source to prove the out-of-bounds guard fires before anything would be applied.

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { URI } from '../src/common/base/common/uri.js';
import { Range } from '../src/common/editor/common/core/range.js';
import {
	groupWorkspaceTextEdits, IWorkspaceEditSource, IWorkspaceTextEdit, prepareWorkspaceEdit,
	resourceTextEdits, workspaceEditAriaMessage
} from '../src/common/editor/common/model/workspaceEdit.js';

const a = URI.file('/repo/a.ts');
const b = URI.file('/repo/b.ts');

function edit(resource: URI, startLine: number, startColumn: number, endColumn: number, text: string): IWorkspaceTextEdit {
	return { resource, range: new Range(startLine, startColumn, startLine, endColumn), text };
}

function source(text: string): IWorkspaceEditSource {
	const lines = text.split('\n');
	return {
		getLineCount: () => lines.length,
		getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? ''
	};
}

test('grouping keeps first-seen resource order and all edits', () => {
	const groups = groupWorkspaceTextEdits([
		edit(b, 1, 1, 4, 'x'),
		edit(a, 1, 1, 4, 'x'),
		edit(b, 2, 1, 4, 'x')
	]);
	assert.equal(groups.length, 2);
	assert.deepEqual(groups.map(group => group[0].resource.toString()), [b.toString(), a.toString()]);
	assert.equal(groups[0].length, 2);
	assert.equal(groups[1].length, 1);
});

test('one resource is sorted ascending regardless of input order', () => {
	const result = resourceTextEdits([
		edit(a, 3, 5, 8, 'new'),
		edit(a, 1, 1, 4, 'new'),
		edit(a, 3, 1, 3, 'new')
	]);
	assert.ok(result.ok);
	assert.deepEqual(
		result.edits.map(e => [e.range.startLineNumber, e.range.startColumn]),
		[[1, 1], [3, 1], [3, 5]]
	);
});

test('overlapping edits are rejected, not silently applied', () => {
	const result = resourceTextEdits([
		edit(a, 1, 1, 6, 'new'),
		edit(a, 1, 4, 9, 'new')
	]);
	assert.equal(result.ok, false);
	assert.ok(!result.ok && result.rejectReason.includes('Overlapping'));
});

test('touching edits are not an overlap', () => {
	const result = resourceTextEdits([
		edit(a, 1, 1, 4, 'x'),
		edit(a, 1, 4, 7, 'y')
	]);
	assert.ok(result.ok);
	assert.equal(result.edits.length, 2);
});

test('two insertions at the same position are allowed', () => {
	const result = resourceTextEdits([
		edit(a, 1, 3, 3, 'x'),
		edit(a, 1, 3, 3, 'y')
	]);
	assert.ok(result.ok);
	assert.equal(result.edits.length, 2);
});

test('a range past the end of the document is rejected before anything is applied', () => {
	const ok = resourceTextEdits([edit(a, 2, 1, 4, 'x')], source('one\ntwo\n'));
	assert.ok(ok.ok);
	const pastLines = resourceTextEdits([edit(a, 9, 1, 2, 'x')], source('one\ntwo\n'));
	assert.equal(pastLines.ok, false);
	const pastColumn = resourceTextEdits([edit(a, 1, 1, 40, 'x')], source('one\ntwo\n'));
	assert.equal(pastColumn.ok, false);
});

test('multi-file edit: one ordered group per resource, counted per file', () => {
	const prepared = prepareWorkspaceEdit([
		edit(a, 5, 1, 4, 'new'),
		edit(b, 1, 1, 4, 'new'),
		edit(a, 1, 1, 4, 'new'),
		edit(b, 2, 3, 6, 'new')
	]);
	assert.equal(prepared.isApplied, true);
	assert.equal(prepared.rejectReason, undefined);
	assert.deepEqual(prepared.groups.map(group => group.resource.toString()), [a.toString(), b.toString()]);
	assert.deepEqual(prepared.groups[0].edits.map(e => e.range.startLineNumber), [1, 5]);
	assert.equal(prepared.editCountByResource.get(a.toString()), 2);
	assert.equal(prepared.editCountByResource.get(b.toString()), 2);
	assert.equal(prepared.ariaSummary, 'Made 4 text edits in 2 files');
});

test('a bad resource rejects the whole workspace edit, naming the resource', () => {
	const prepared = prepareWorkspaceEdit([
		edit(a, 1, 1, 4, 'new'),
		edit(b, 1, 1, 6, 'new'),
		edit(b, 1, 4, 9, 'new')
	]);
	assert.equal(prepared.isApplied, false);
	assert.equal(prepared.groups.length, 0);
	assert.ok(prepared.rejectReason?.includes(b.toString()));
	assert.ok(prepared.rejectReason?.includes('Overlapping'));
	assert.equal(prepared.ariaSummary, 'Made no edits');
});

test('the model source is picked per resource', () => {
	const prepared = prepareWorkspaceEdit(
		[edit(a, 1, 1, 4, 'new'), edit(b, 7, 1, 4, 'new')],
		resource => source(resource.toString() === a.toString() ? 'abc' : 'abc')
	);
	assert.equal(prepared.isApplied, false);
	assert.ok(prepared.rejectReason?.includes(b.toString()));
});

test('an empty edit is not applied and reports no edits', () => {
	const prepared = prepareWorkspaceEdit([]);
	assert.equal(prepared.isApplied, false);
	assert.equal(prepared.rejectReason, undefined);
	assert.equal(prepared.groups.length, 0);
	assert.equal(prepared.ariaSummary, 'Made no edits');
});

test('aria summary wording follows the edit and file counts', () => {
	assert.equal(workspaceEditAriaMessage(new Map()), 'Made no edits');
	assert.equal(workspaceEditAriaMessage(new Map([['a', 1]])), 'Made 1 text edits in one file');
	assert.equal(workspaceEditAriaMessage(new Map([['a', 3]])), 'Made 3 text edits in one file');
	assert.equal(workspaceEditAriaMessage(new Map([['a', 1], ['b', 1]])), 'Made 2 text edits in 2 files');
});
