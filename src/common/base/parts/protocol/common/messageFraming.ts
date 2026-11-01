// extensions/toy-lang/client/src/lsp-framing.ts — the LSP base protocol, hand-rolled:
// `Content-Length: N\r\n\r\n` + N BYTES of UTF-8 JSON. The length is bytes, not string length —
// a comment with an emoji breaks naive clients. The reader buffers and survives several
// messages arriving in one chunk and one message arriving in many chunks. Pure, so the tests
// can hammer it without spawning a server.

export function encodeMessage(message: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(message), 'utf8');
	const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
	return Buffer.concat([header, body]);
}

export class MessageReader {

	private _buffer: Buffer = Buffer.alloc(0);

	/** append a chunk; returns every complete message it finished */
	append(chunk: Buffer): unknown[] {
		this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);
		const messages: unknown[] = [];
		for (;;) {
			// headers first: find the CRLFCRLF separator
			const headerEnd = this._buffer.indexOf('\r\n\r\n');
			if (headerEnd === -1) {
				break;
			}
			const headerText = this._buffer.subarray(0, headerEnd).toString('ascii');
			const match = /Content-Length:\s*(\d+)/i.exec(headerText);
			if (!match) {
				throw new Error(`invalid message header: ${JSON.stringify(headerText)}`);
			}
			const contentLength = Number.parseInt(match[1], 10);
			const bodyStart = headerEnd + 4;
			if (this._buffer.length < bodyStart + contentLength) {
				// the body is still in flight: wait for more bytes
				break;
			}
			// slice by BYTES, then decode: a multi-byte character never splits wrongly
			const body = this._buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf8');
			this._buffer = this._buffer.subarray(bodyStart + contentLength);
			messages.push(JSON.parse(body));
		}
		return messages;
	}

	get bufferedBytes(): number {
		return this._buffer.length;
	}
}
