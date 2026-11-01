// A2-1: the readonly, in-memory editor input that backs provider-supplied tabs (a `git diff`
// dump). `EditorInputCapabilities.Readonly` was declared but nothing honoured it, so these
// assertions pin the behaviour that makes such a tab safe: it never reads or writes disk, never
// reports dirty (so closing it cannot prompt), and never saves.
//
// The widget's own edit gate needs a DOM and is not covered here; what is covered is that the
// capability the pane feeds the widget is actually set.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { URI } from '../src/common/base/common/uri.js';
import { EditorInputCapabilities } from '../src/renderer/workbench/common/editor/editorInput.js';
import { TextEditorInput } from '../src/renderer/workbench/common/editor/textEditorInput.js';
import { CodeEditorService } from '../src/renderer/workbench/services/editor/browser/codeEditorService.js';
import type { IFileService } from '../src/common/platform/files/common/files.js';

const DIFF = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n';

/** a file service that fails loudly: a readonly content input must never touch it */
function forbiddenFileService(): IFileService {
	const fail = (): never => {
		throw new Error('the readonly content input must not use the file service');
	};
	return {
		readFile: fail,
		writeFile: fail,
		resolve: fail,
		stat: fail
	} as unknown as IFileService;
}

function makeInput(options?: { content?: string; name?: string; readonly?: boolean }): { input: TextEditorInput; models: CodeEditorService } {
	const models = new CodeEditorService();
	const input = new TextEditorInput(
		URI.parse('readonly-content:/git-lite/x.ts'),
		forbiddenFileService(),
		models,
		() => ({ element: undefined } as never),
		options
	);
	return { input, models };
}

test('readonly input: reports the Readonly capability', () => {
	const { input } = makeInput({ content: DIFF, name: 'x.ts (diff)', readonly: true });
	assert.equal(input.hasCapability(EditorInputCapabilities.Readonly), true);
	assert.equal(input.isReadonlyInput, true);
});

test('a normal file input does NOT report Readonly (the default is unchanged)', () => {
	const { input } = makeInput();
	assert.equal(input.hasCapability(EditorInputCapabilities.Readonly), false);
	assert.equal(input.isReadonlyInput, false);
});

test('readonly input: the tab label is the provider-supplied name', () => {
	const { input } = makeInput({ content: DIFF, name: 'x.ts (diff)', readonly: true });
	assert.equal(input.getName(), 'x.ts (diff)');
});

test('readonly input: without a name it falls back to the basename', () => {
	const { input } = makeInput({ content: DIFF, readonly: true });
	assert.equal(input.getName(), 'x.ts');
});

test('readonly input: the model is built from the content, never from disk', async () => {
	// the file service throws on any call, so resolving proves no read happened
	const { input, models } = makeInput({ content: DIFF, readonly: true });
	await input.resolve();
	const model = input.getModel();
	assert.ok(model, 'resolve must have created a model');
	assert.equal(model.getValue(), DIFF);
	assert.ok(models.findModel(URI.parse('readonly-content:/git-lite/x.ts')), 'the model is in the registry');
});

test('readonly input: never dirty, even after the model is edited programmatically', async () => {
	const { input } = makeInput({ content: DIFF, readonly: true });
	await input.resolve();
	assert.equal(input.isDirty(), false);

	// revertTo goes through the model (that is how a reopened diff refreshes) — still not dirty
	input.getModel()!.revertTo('diff --git a/y b/y\n');
	assert.equal(input.isDirty(), false, 'a readonly tab must never prompt to save on close');
});

test('readonly input: save is a no-op that reports failure rather than writing', async () => {
	const { input } = makeInput({ content: DIFF, readonly: true });
	await input.resolve();
	// the file service throws on write; save must not reach it
	assert.equal(await input.save(), false);
});

test('readonly input: revert is a no-op (there is no disk state to go back to)', async () => {
	const { input } = makeInput({ content: DIFF, readonly: true });
	await input.resolve();
	await input.revert(); // would throw via the file service if it tried to read
	assert.equal(input.getModel()!.getValue(), DIFF);
});

test('readonly input: reopening the same key refreshes content in place', async () => {
	const { input } = makeInput({ content: DIFF, readonly: true });
	await input.resolve();
	const model = input.getModel()!;

	const refreshed = 'diff --git a/x b/x\n+newer\n';
	model.revertTo(refreshed);

	assert.equal(input.getModel()!.getValue(), refreshed);
	assert.equal(input.getModel(), model, 'the same model object is reused, so the tab stays put');
});
