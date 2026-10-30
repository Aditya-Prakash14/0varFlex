// TextModel: edits, event ordering, undo grouping, save points, version bookkeeping, EOL.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Position } from '../src/common/editor/common/core/position.js';
import { Range } from '../src/common/editor/common/core/range.js';
import { IModelContentChangedEvent } from '../src/common/editor/common/core/textChange.js';
import { TextModel } from '../src/common/editor/common/model/textModel.js';
import { CONTINUATION_TIME } from '../src/common/editor/common/model/editStack.js';

function typedInsert(model: TextModel, offset: number, text: string, beforeState: unknown = null): unknown {
	const position = model.getPositionAt(offset);
	return model.pushEditOperations(beforeState, [{ range: Range.fromPositions(position), text }], () => null);
}

test('applyEdits: one event, changes sorted descending by offset, UTF-16 rangeLength (emoji = 2)', () => {
	const model = new TextModel('hello 😀 world');

	const events: IModelContentChangedEvent[] = [];
	model.onDidChangeContent(event => events.push(event));

	// replace 'hello' (offset 0) and 'world' (offset 9)
	model.applyEdits([
		{ range: new Range(1, 1, 1, 6), text: 'goodbye' },
		{ range: new Range(1, 10, 1, 15), text: 'moon' }
	]);

	assert.equal(events.length, 1);
	const changes = events[0].changes;
	assert.equal(changes.length, 2);
	assert.ok(changes[0].rangeOffset > changes[1].rangeOffset, 'changes are descending by offset');

	const worldChange = changes.find(change => change.text === 'moon')!;
	assert.equal(worldChange.rangeOffset, 9);
	assert.equal(worldChange.rangeLength, 5);
	assert.equal(model.getValue(), 'goodbye 😀 moon');

	// emoji: 2 UTF-16 code units — it now sits at offsets 8..10 (goodbye is one longer than hello)
	model.applyEdits([{ range: Range.fromPositions(model.getPositionAt(8), model.getPositionAt(10)), text: '' }]);
	assert.equal(model.getValue(), 'goodbye  moon');
});

test('applyEdits: overlapping ranges throw the reference message', () => {
	const model = new TextModel('abcdef');
	assert.throws(() => model.applyEdits([
		{ range: new Range(1, 1, 1, 4), text: 'x' },
		{ range: new Range(1, 3, 1, 6), text: 'y' }
	]), /Overlapping ranges are not allowed!/);
});

test('edits out of range throw with the offending position named', () => {
	const model = new TextModel('abc\ndef');
	assert.throws(() => model.applyEdits([{ range: new Range(5, 1, 5, 1), text: 'x' }]), /Illegal value for lineNumber: 5/);
	assert.throws(() => model.applyEdits([{ range: new Range(1, 9, 1, 9), text: 'x' }]), /Illegal value for column: 9/);
});

test('undo grouping: rapid inserts merge into one unit; a pause splits; an EOL edit starts a unit', () => {
	let now = 1000;
	const model = new TextModel('', { now: () => now });

	typedInsert(model, 0, 'a'); now += 100;
	typedInsert(model, 1, 'b'); now += 100;
	typedInsert(model, 2, 'c');
	assert.equal(model.getValue(), 'abc');

	model.undo();
	assert.equal(model.getValue(), '', 'three quick inserts undo as one unit');

	// redo them back, then pause and type
	model.redo();
	assert.equal(model.getValue(), 'abc');
	now += CONTINUATION_TIME + 1;
	typedInsert(model, 3, 'd');
	model.undo();
	assert.equal(model.getValue(), 'abc', 'a pause after the run starts a new unit');
	model.undo();
	assert.equal(model.getValue(), '', 'the earlier run undoes separately');

	// EOL rule on a fresh model
	let clock = 5000;
	const model2 = new TextModel('', { now: () => clock });
	typedInsert(model2, 0, 'a'); clock += 50;
	typedInsert(model2, 1, '\n'); clock += 50;
	typedInsert(model2, 2, 'b');
	assert.equal(model2.getValue(), 'a\nb');
	model2.undo();
	assert.equal(model2.getValue(), 'a', 'the typed text after the newline undoes with the newline');
	model2.undo();
	assert.equal(model2.getValue(), '', 'the run before the newline is its own unit');
});

test('save points: isModified follows the alternative version through undo and redo', () => {
	let now = 0;
	const model = new TextModel('', { now: () => (now += 1000) });

	typedInsert(model, 0, 'a');
	// save: record the current position in history (09's save will do exactly this)
	model.pushStackElement();
	model.setSavedVersionId();
	assert.equal(model.isModified(), false);

	now += 1000;
	typedInsert(model, 1, 'b');
	assert.equal(model.isModified(), true);

	model.undo();
	assert.equal(model.isModified(), false, 'undo back to the save point is not modified');

	model.redo();
	assert.equal(model.isModified(), true, 'redo away from the save point is modified');
});

test('version ids: monotonic on every change; alternative resets after undo + new edit', () => {
	let now = 0;
	const model = new TextModel('', { now: () => (now += 1000) });

	typedInsert(model, 0, 'a');
	assert.equal(model.getVersionId(), 2);
	assert.equal(model.getAlternativeVersionId(), 2);

	typedInsert(model, 1, 'b');
	const versionBeforeUndo = model.getVersionId();
	assert.equal(model.getAlternativeVersionId(), 3);

	model.undo();
	assert.equal(model.getVersionId(), versionBeforeUndo + 1, 'undo bumps versionId');
	assert.equal(model.getAlternativeVersionId(), 2, 'undo decrements the alternative id');

	model.redo();
	assert.equal(model.getAlternativeVersionId(), 3, 'redo increments it back');

	model.undo();
	typedInsert(model, 1, 'z');
	assert.equal(model.getAlternativeVersionId(), model.getVersionId(), 'a new edit jumps to the fresh version');
	assert.equal(model.getValue(), 'az');
	assert.equal(model.canRedo(), false, 'a new edit kills the redo branch');
});

test('CRLF: detected on load, offsets consistent, round-trips', () => {
	const model = new TextModel('a\r\nb\r\nc');
	assert.equal(model.getEOL(), '\r\n');
	assert.equal(model.getLineCount(), 3);
	assert.equal(model.getLineContent(2), 'b');
	assert.equal(model.getOffsetAt(new Position(2, 1)), 3);
	assert.equal(model.getOffsetAt(new Position(3, 2)), 7);
	assert.equal(model.getPositionAt(3).toString(), '2:1');
	assert.equal(model.getPositionAt(8).toString(), '3:2');
	assert.equal(model.getValue(), 'a\r\nb\r\nc');

	model.applyEdits([{ range: new Range(2, 1, 2, 2), text: 'bb' }]);
	assert.equal(model.getValue(), 'a\r\nbb\r\nc');
});

test('pushEditOperations: inverse operations reach the cursor computer; undo restores cursor state', () => {
	let now = 0;
	const model = new TextModel('hello world', { now: () => (now += 1000) });

	let inverseOperationsSeen: unknown[] = [];
	const beforeState = { markers: ['before'] };

	const afterState = model.pushEditOperations(beforeState, [
		{ range: new Range(1, 1, 1, 6), text: 'bye' }
	], inverseOps => {
		inverseOperationsSeen = inverseOps;
		return { markers: ['after'] };
	});

	assert.deepEqual(afterState, { markers: ['after'] });
	assert.equal((inverseOperationsSeen[0] as { text: string }).text, 'hello', 'the inverse operation carries the deleted text');
	assert.equal(model.getValue(), 'bye world');

	const restored = model.undo();
	assert.deepEqual(restored, beforeState, 'undo returns the stored before-cursor-state');
	assert.equal(model.getValue(), 'hello world');
});

test('setValue-style reset: a new model state anchors the save point', () => {
	const model = new TextModel('initial');
	model.setSavedVersionId();
	assert.equal(model.isModified(), false);

	model.applyEdits([{ range: new Range(1, 1, 1, 8), text: 'changed' }]);
	assert.equal(model.isModified(), true);

	// a fresh document (what 09 will do on load/replace) anchors clean again
	const reloaded = new TextModel('changed');
	reloaded.setSavedVersionId();
	assert.equal(reloaded.isModified(), false);
});
