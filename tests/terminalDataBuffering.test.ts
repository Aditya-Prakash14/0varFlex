// The terminal's batching + flow control (13): the 5ms data buffer (the reason `yes` does not
// flood the IPC) and the watermark state machine (pause > 100k unacknowledged, resume < 5k).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Emitter } from '../src/common/base/common/event.js';
import { FlowControlState, TerminalDataBufferer } from '../src/common/platform/terminal/common/terminalDataBuffering.js';
import {
	FlowControlConstants
} from '../src/common/platform/terminal/common/terminal.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('the flow control constants are the ported values', () => {
	assert.equal(FlowControlConstants.HighWatermarkChars, 100_000);
	assert.equal(FlowControlConstants.LowWatermarkChars, 5_000);
	assert.equal(FlowControlConstants.CharCountAckSize, 5_000);
});

test('data is batched into one flush 5ms after the first chunk', async () => {
	const flushes: Array<{ id: number; data: string }> = [];
	const bufferer = new TerminalDataBufferer((id, data) => flushes.push({ id, data }));
	const source = new Emitter<string>();
	const subscription = bufferer.startBuffering(7, source.event);

	source.fire('a');
	source.fire('b');
	source.fire('c');
	assert.equal(flushes.length, 0, 'nothing flushes before the throttle elapses');
	await sleep(20);
	assert.deepEqual(flushes, [{ id: 7, data: 'abc' }]);

	// a second burst starts a fresh buffer
	source.fire('d');
	await sleep(20);
	assert.deepEqual(flushes[1], { id: 7, data: 'd' });
	subscription.dispose();
	bufferer.dispose();
});

test('bufferers are keyed per id and flush independently', async () => {
	const flushes: Array<{ id: number; data: string }> = [];
	const bufferer = new TerminalDataBufferer((id, data) => flushes.push({ id, data }));
	const one = new Emitter<string>();
	const two = new Emitter<string>();
	bufferer.startBuffering(1, one.event);
	bufferer.startBuffering(2, two.event);
	one.fire('one');
	two.fire('two');
	await sleep(20);
	assert.deepEqual(flushes.sort((a, b) => a.id - b.id), [{ id: 1, data: 'one' }, { id: 2, data: 'two' }]);
	bufferer.dispose();
});

test('disposing the subscription flushes what is buffered', () => {
	const flushes: Array<{ id: number; data: string }> = [];
	const bufferer = new TerminalDataBufferer((id, data) => flushes.push({ id, data }));
	const source = new Emitter<string>();
	const subscription = bufferer.startBuffering(3, source.event);
	source.fire('pending');
	subscription.dispose();
	assert.deepEqual(flushes, [{ id: 3, data: 'pending' }]);
	bufferer.dispose();
});

test('flow control: pause past the high watermark, resume only below the low one', () => {
	const flow = new FlowControlState();

	// below high: no pause
	assert.equal(flow.sent(FlowControlConstants.HighWatermarkChars - 1), false);
	assert.equal(flow.isPaused, false);

	// crossing high pauses exactly once
	assert.equal(flow.sent(2), true);
	assert.equal(flow.isPaused, true);
	assert.equal(flow.sent(1), false, 'already paused: no second pause');

	// acks that do not reach the low watermark keep it paused
	assert.equal(flow.ack(10_000), false);
	assert.equal(flow.isPaused, true);

	// resuming happens when the unacknowledged count falls below low
	assert.equal(flow.ack(flow.unacknowledgedChars - (FlowControlConstants.LowWatermarkChars - 1)), true);
	assert.equal(flow.isPaused, false);

	// and it can pause again
	assert.equal(flow.sent(FlowControlConstants.HighWatermarkChars), true);
});

test('flow control: acks never drive the count below zero', () => {
	const flow = new FlowControlState();
	flow.ack(5_000);
	assert.equal(flow.unacknowledgedChars, 0);
});
