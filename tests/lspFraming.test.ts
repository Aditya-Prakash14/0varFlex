// The LSP base protocol reader/writer (12). The pitfalls under test:
//   - Content-Length is BYTES of UTF-8, never string length (the emoji case);
//   - two messages can arrive in one chunk and one message can arrive split across many;
//   - a >64KB payload must survive the buffering.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeMessage, MessageReader } from '../src/common/base/parts/protocol/common/messageFraming.js';

function messageOf(chunk: Buffer): unknown {
	const messages = new MessageReader().append(chunk);
	assert.equal(messages.length, 1);
	return messages[0];
}

test('Content-Length counts bytes, not UTF-16 code units (emoji proof)', () => {
	const emoji = '🎉';
	assert.equal(emoji.length, 2); // UTF-16 code units
	assert.equal(Buffer.byteLength(emoji, 'utf8'), 4); // bytes

	const encoded = encodeMessage({ jsonrpc: '2.0', id: 1, result: emoji });
	const header = encoded.subarray(0, encoded.indexOf('\r\n\r\n')).toString('ascii');
	const length = Number(/Content-Length: (\d+)/.exec(header)?.[1]);
	const body = encoded.subarray(encoded.indexOf('\r\n\r\n') + 4);
	assert.equal(length, body.length);
	assert.deepEqual(messageOf(encoded), { jsonrpc: '2.0', id: 1, result: emoji });
});

test('two messages coalesced into one chunk are both parsed', () => {
	const first = encodeMessage({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///a' } });
	const second = encodeMessage({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///b' } });
	const messages = new MessageReader().append(Buffer.concat([first, second]));
	assert.equal(messages.length, 2);
	assert.deepEqual(messages.map(m => (m as { params: { uri: string } }).params.uri), ['file:///a', 'file:///b']);
});

test('a message split across chunks is parsed exactly when complete', () => {
	const encoded = encodeMessage({ jsonrpc: '2.0', id: 7, result: { value: 'hello 🎉 world' } });
	const reader = new MessageReader();

	// split inside the header
	assert.deepEqual(reader.append(encoded.subarray(0, 10)), []);
	// split inside the body
	assert.deepEqual(reader.append(encoded.subarray(10, encoded.length - 3)), []);
	// the tail finishes it
	const messages = reader.append(encoded.subarray(encoded.length - 3));
	assert.equal(messages.length, 1);
	assert.deepEqual((messages[0] as { result: unknown }).result, { value: 'hello 🎉 world' });
	assert.equal(reader.bufferedBytes, 0);
});

test('a >64KB payload round-trips (the big completion list)', () => {
	const items = Array.from({ length: 1000 }, (_, index) => ({
		label: `item-${index}`,
		detail: 'x'.repeat(64),
		textEdit: { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: `item-${index}` }
	}));
	const encoded = encodeMessage({ jsonrpc: '2.0', id: 3, result: { isIncomplete: false, items } });
	assert.ok(encoded.length > 64 * 1024);

	// delivered in 8KB slices: the reader must buffer to the full length
	const reader = new MessageReader();
	let delivered: unknown[] = [];
	for (let offset = 0; offset < encoded.length; offset += 8192) {
		delivered = reader.append(encoded.subarray(offset, Math.min(offset + 8192, encoded.length)));
	}
	assert.equal(delivered.length, 1);
	const result = (delivered[0] as { result: { items: unknown[] } }).result;
	assert.equal(result.items.length, 1000);
});

test('a header without Content-Length throws instead of mis-parsing', () => {
	const reader = new MessageReader();
	assert.throws(() => reader.append(Buffer.from('X-Whatever: 1\r\n\r\n{}', 'ascii')), /invalid LSP header/);
});
