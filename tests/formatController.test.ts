// tests/formatController.test.ts — Format Document: the 0/1-based conversion, where the cursor
// lands, and every path that must leave the document untouched.
//
// The no-op cases are the point: no provider, a provider that returns nothing, and a formatter
// that returns the document unchanged must all leave the model's version id where it was, because
// a bumped version is what makes the file dirty.

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { Position } from '../src/common/editor/common/core/position.js';
import { Range } from '../src/common/editor/common/core/range.js';
import { TextModel } from '../src/common/editor/common/model/textModel.js';
import { URI } from '../src/common/base/common/uri.js';
import { Selection } from '../src/renderer/editor/browser/core/selection.js';
import type { EditorWidget } from '../src/renderer/editor/browser/editorWidget.js';
import type {
	IDocumentFormattingEditProviderAdapter, ILanguageFeaturesService
} from '../src/renderer/workbench/api/common/mainThreadLanguageFeatures.js';
import type { IWireTextEdit } from '../src/common/platform/extensions/common/extensionHostProtocol.js';
import {
	cursorAfterFormat, formatDocument, IFormatContext, toFormattingEdits
} from '../src/renderer/editor/contrib/format/formatController.js';

function wireEdit(startLine: number, startCharacter: number, endLine: number, endCharacter: number, newText: string): IWireTextEdit {
	return { range: { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } }, newText };
}

/** only the widget members the command uses; the rest of EditorWidget is DOM and not needed here */
function fakeWidget(model: TextModel, selection: Selection, readonly = false): { widget: EditorWidget; selections: Selection[] } {
	const selections: Selection[] = [];
	const widget = {
		getModel: () => model,
		getSelection: () => selection,
		setSelection: (next: Selection) => { selections.push(next); },
		revealPosition: () => { /* view only */ },
		get isReadonly() { return readonly; }
	};
	return { widget: widget as unknown as EditorWidget, selections };
}

function context(
	model: TextModel,
	selection: Selection,
	providers: readonly IDocumentFormattingEditProviderAdapter[],
	readonly = false
): { context: IFormatContext; selections: Selection[] } {
	const { widget, selections } = fakeWidget(model, selection, readonly);
	const languageFeatures = {
		getDocumentFormattingEditProviders: () => providers,
		languageIdForResource: () => 'plaintext'
	} as unknown as ILanguageFeaturesService;
	return {
		context: {
			getActiveWidget: () => widget,
			getResource: () => URI.file('/tmp/a.txt'),
			languageFeatures,
			getFormattingOptions: () => ({ tabSize: 4, insertSpaces: true })
		},
		selections
	};
}

function provider(edits: readonly IWireTextEdit[] | null): IDocumentFormattingEditProviderAdapter {
	return { handle: 1, provideDocumentFormattingEdits: async () => edits };
}

test('wire edits become 1-based editor edits', () => {
	const [edit] = toFormattingEdits([wireEdit(0, 0, 2, 3, 'x')]);
	assert.deepEqual(
		[edit.range.startLineNumber, edit.range.startColumn, edit.range.endLineNumber, edit.range.endColumn, edit.text],
		[1, 1, 3, 4, 'x']
	);
});

test('the cursor is clamped into the reformatted document', () => {
	const model = { getLineCount: () => 2, getLineMaxColumn: (line: number) => line === 1 ? 4 : 2 };
	assert.deepEqual(cursorAfterFormat(new Position(1, 3), model), new Position(1, 3));
	// the formatter shortened the line the cursor was past the end of
	assert.deepEqual(cursorAfterFormat(new Position(2, 9), model), new Position(2, 2));
	// the formatter deleted lines below the cursor
	assert.deepEqual(cursorAfterFormat(new Position(7, 1), model), new Position(2, 1));
});

test('formatting applies the edits as one undo step and keeps the cursor on its line', async () => {
	const model = new TextModel('a   =1\nb=2');
	const { context: ctx, selections } = context(model, new Selection(2, 2, 2, 2), [provider([wireEdit(0, 0, 0, 6, 'a = 1')])]);

	assert.equal(await formatDocument(ctx), true);
	assert.equal(model.getValue(), 'a = 1\nb=2');
	assert.deepEqual([selections[0].activeLineNumber, selections[0].activeColumn], [2, 2]);

	model.undo();
	assert.equal(model.getValue(), 'a   =1\nb=2', 'one undo must take the whole format back');
	assert.equal(model.canUndo(), false, 'and there must be nothing left to undo');
});

test('an already formatted document is a true no-op', async () => {
	const model = new TextModel('a = 1\n');
	const version = model.getVersionId();
	// the provider returns the document, unchanged — the usual shape for a formatter with nothing to do
	const { context: ctx } = context(model, new Selection(1, 1, 1, 1), [provider([wireEdit(0, 0, 0, 5, 'a = 1')])]);

	assert.equal(await formatDocument(ctx), false);
	assert.equal(model.getVersionId(), version, 'no edit pushed, so the file does not become dirty');
	assert.equal(model.canUndo(), false);
});

test('no provider, an empty result and a readonly editor all do nothing', async () => {
	for (const [name, ctx, model] of [
		['no provider', ...make([])],
		['null result', ...make([provider(null)])],
		['empty result', ...make([provider([])])]
	] as [string, IFormatContext, TextModel][]) {
		const version = model.getVersionId();
		assert.equal(await formatDocument(ctx), false, name);
		assert.equal(model.getVersionId(), version, name);
	}

	const model = new TextModel('a   =1');
	const { context: ctx } = context(model, new Selection(1, 1, 1, 1), [provider([wireEdit(0, 0, 0, 6, 'a = 1')])], true);
	assert.equal(await formatDocument(ctx), false, 'readonly');
	assert.equal(model.getValue(), 'a   =1');

	function make(providers: readonly IDocumentFormattingEditProviderAdapter[]): [IFormatContext, TextModel] {
		const target = new TextModel('a   =1');
		return [context(target, new Selection(1, 1, 1, 1), providers).context, target];
	}
});

test('edits computed against text the user has since changed are dropped', async () => {
	const model = new TextModel('a   =1');
	const { context: ctx } = context(model, new Selection(1, 1, 1, 1), [{
		handle: 1,
		provideDocumentFormattingEdits: async () => {
			model.applyEdits([{ range: new Range(1, 1, 1, 1), text: 'x' }]);
			return [wireEdit(0, 0, 0, 6, 'a = 1')];
		}
	}]);

	assert.equal(await formatDocument(ctx), false);
	assert.equal(model.getValue(), 'xa   =1', 'only the user\'s own edit survives');
});
