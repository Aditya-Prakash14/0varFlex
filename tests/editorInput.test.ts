// The editor service building blocks: basename, the text input's load/dirty/save/revert
// lifecycle against a fake file channel, the model registry's refcounts, and 09's model revert.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { URI } from '../src/common/base/common/uri.js';
import { Range } from '../src/common/editor/common/core/range.js';
import { TextModel } from '../src/common/editor/common/model/textModel.js';
import { TextEditorInput, basename } from '../src/renderer/workbench/common/editor/textEditorInput.js';
import { createTestFileService } from './harness/fileSystem.js';
import type { FileService } from '../src/common/platform/files/common/fileService.js';
import { EditorPane } from '../src/renderer/workbench/common/editor/editorPane.js';
import { CodeEditorService } from '../src/renderer/workbench/services/editor/browser/codeEditorService.js';


class FakePane extends EditorPane {
	override getId(): string { return 'fake'; }
	override get element(): HTMLElement { return null as unknown as HTMLElement; }
	override layout(): void { /* noop */ }
	override setVisible(): void { /* noop */ }
	override focus(): void { /* noop */ }
	override saveViewState() { return null; }
	override restoreViewState(): void { /* noop */ }
}

function makeInput(fileService: FileService, codeEditorService: CodeEditorService, path: string): TextEditorInput {
	return new TextEditorInput(URI.file(path), fileService, codeEditorService, () => new FakePane());
}

test('basename: trailing slashes are safe (labels.ts port)', () => {
	assert.equal(basename('/a/b/file.ts'), 'file.ts');
	assert.equal(basename('/a/b/'), 'b');
	assert.equal(basename('C:\\dir\\file.ts'), 'file.ts');
	assert.equal(basename('file.ts'), 'file.ts');
	assert.equal(basename(''), '');
});

test('text input: resolve loads once, model shared through the registry', async () => {
	const { fileService, fs } = createTestFileService();
	fs.setFile('/w/a.ts', 'const a = 1;\n');
	const registry = new CodeEditorService();
	const input = makeInput(fileService, registry, '/w/a.ts');

	const pane = await input.resolve();
	assert.ok(pane instanceof FakePane);
	assert.equal(input.getModel()?.getValue(), 'const a = 1;\n');
	// a second resolve (another group) reuses the model, not the file read
	fs.setFile('/w/a.ts', 'CHANGED ON DISK');
	await input.resolve();
	assert.equal(input.getModel()?.getValue(), 'const a = 1;\n');
});

test('text input: dirty transitions fire once per crossing', async () => {
	const { fileService } = createTestFileService();
	fileService.writeFile(URI.file('/w/b.ts'), 'hello');
	const registry = new CodeEditorService();
	const input = makeInput(fileService, registry, '/w/b.ts');
	await input.resolve();
	assert.equal(input.isDirty(), false);

	let dirtyEvents = 0;
	input.onDidChangeDirty(() => dirtyEvents++);

	const model = input.getModel()!;
	model.pushEditOperations(null, [{ range: new Range(1, 6, 1, 6), text: ' world' }], () => null);
	assert.equal(input.isDirty(), true);
	assert.equal(dirtyEvents, 1, 'one transition into dirty');

	// more edits while already dirty: no extra events
	model.pushEditOperations(null, [{ range: new Range(1, 12, 1, 12), text: '!' }], () => null);
	assert.equal(dirtyEvents, 1);

	// undo back to the save point: one transition out of dirty (the run merged into one unit)
	model.undo();
	assert.equal(input.isDirty(), false);
	assert.equal(dirtyEvents, 2);
});

test('text input: save writes, anchors the save point and closes the typing unit', async () => {
	const { fileService, fs } = createTestFileService();
	fs.setFile('/w/c.ts', 'a');
	const registry = new CodeEditorService();
	const input = makeInput(fileService, registry, '/w/c.ts');
	await input.resolve();
	const model = input.getModel()!;

	// a typing run, then save
	model.pushEditOperations(null, [{ range: new Range(1, 2, 1, 2), text: 'b' }], () => null);
	const saved = await input.save();
	assert.equal(saved, true);
	assert.equal(fs.getFile('/w/c.ts'), 'ab');
	assert.equal(input.isDirty(), false);

	// the classic pitfall: after save, undo ONE keystroke must not resurrect dirty from before
	model.pushEditOperations(null, [{ range: new Range(1, 3, 1, 3), text: 'c' }], () => null);
	assert.equal(input.isDirty(), true);
	model.undo(); // returns the (null) cursor state by contract; the value tells the story
	assert.equal(model.getValue(), 'ab');
	assert.equal(input.isDirty(), false, 'undo one keystroke after save lands exactly on the save point');
});

test('text input: revert goes back to disk and clears history', async () => {
	const { fileService, fs } = createTestFileService();
	fs.setFile('/w/d.ts', 'disk content');
	const registry = new CodeEditorService();
	const input = makeInput(fileService, registry, '/w/d.ts');
	await input.resolve();
	const model = input.getModel()!;

	model.applyEdits([{ range: new Range(1, 1, 1, 13), text: 'scribbled' }]);
	assert.equal(input.isDirty(), true);

	await input.revert();
	assert.equal(model.getValue(), 'disk content');
	assert.equal(input.isDirty(), false);
	assert.equal(model.canUndo(), false, 'the history does not survive a revert');
});

test('model registry: one model per uri, refcounted, disposed at zero', async () => {
	const registry = new CodeEditorService();
	const uri = URI.file('/w/shared.ts');

	const first = registry.createModel(uri, 'one');
	assert.equal(registry.createModel(uri, 'two'), first, 'get-or-create returns the existing model');
	assert.equal(registry.refCount(uri), 0);

	registry.acquire(uri);
	registry.acquire(uri);
	assert.equal(registry.refCount(uri), 2);

	registry.release(uri);
	assert.equal(registry.modelCount(), 1, 'still referenced');
	assert.equal(registry.findModel(uri), first);

	registry.release(uri);
	assert.equal(registry.modelCount(), 0, 'last pane closed: the model is gone');
	assert.equal(registry.findModel(uri), undefined);
});

test('model revertTo: value reset, history cleared, save point anchored', () => {
	const model = new TextModel('original');
	model.setSavedVersionId();

	model.pushEditOperations(null, [{ range: new Range(1, 1, 1, 9), text: 'edited' }], () => null);
	assert.equal(model.isModified(), true);
	assert.equal(model.canUndo(), true);

	model.revertTo('from disk');

	assert.equal(model.getValue(), 'from disk');
	assert.equal(model.isModified(), false);
	assert.equal(model.canUndo(), false);
});
