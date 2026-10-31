// src/common/platform/terminal/common/terminalDataBuffering.ts — the data batching (ported
// verbatim in behavior from the reference's TerminalDataBufferer) + the flow-control state
// machine (the counters the reference keeps inline in terminalProcess.ts, extracted here so it
// is unit-testable).
//
// Batching: data flows pty → buffer → flush on a 5ms timer (the first chunk in a batch starts
// the timer, later chunks join it). Without this, `yes` sends one IPC message per pty read.

import { IDisposable } from '../../../base/common/lifecycle.js';
import { Event } from '../../../base/common/event.js';
import { DATA_BUFFER_THROTTLE_MS, FlowControlConstants } from './terminal.js';

interface ITerminalDataBuffer {
	data: string[];
	timeoutId: ReturnType<typeof setTimeout>;
}

export class TerminalDataBufferer implements IDisposable {

	private readonly _terminalBufferMap = new Map<number, ITerminalDataBuffer>();

	constructor(private readonly _callback: (id: number, data: string) => void) { }

	dispose(): void {
		for (const id of [...this._terminalBufferMap.keys()]) {
			this.stopBuffering(id);
		}
	}

	/** the reference signature: the throttle defaults to 5ms */
	startBuffering(id: number, event: Event<string>, throttleBy: number = DATA_BUFFER_THROTTLE_MS): IDisposable {
		let disposed = false;
		const disposable = event(data => {
			const buffer = this._terminalBufferMap.get(id);
			if (buffer) {
				buffer.data.push(data);
				return;
			}
			const timeoutId = setTimeout(() => this.flushBuffer(id), throttleBy);
			this._terminalBufferMap.set(id, { data: [data], timeoutId });
		});
		return {
			dispose: () => {
				if (disposed) {
					return;
				}
				disposed = true;
				this.stopBuffering(id);
				disposable.dispose();
			}
		};
	}

	stopBuffering(id: number): void {
		const buffer = this._terminalBufferMap.get(id);
		if (!buffer) {
			return;
		}
		clearTimeout(buffer.timeoutId);
		this._terminalBufferMap.delete(id);
		if (buffer.data.length > 0) {
			this._callback(id, buffer.data.join(''));
		}
	}

	flushBuffer(id: number): void {
		const buffer = this._terminalBufferMap.get(id);
		if (!buffer) {
			return;
		}
		this._terminalBufferMap.delete(id);
		this._callback(id, buffer.data.join(''));
	}
}

/**
 * The ported flow-control state: `sent(charCount)` adds to the unacknowledged count and asks
 * the caller to pause the pty past the high watermark; `ack(charCount)` (the renderer parsed
 * that many chars) subtracts and asks for a resume below the low one.
 */
export class FlowControlState {

	private _unacknowledgedChars = 0;
	private _paused = false;

	constructor(
		private readonly _highWatermark = FlowControlConstants.HighWatermarkChars,
		private readonly _lowWatermark = FlowControlConstants.LowWatermarkChars
	) { }

	get unacknowledgedChars(): number {
		return this._unacknowledgedChars;
	}

	get isPaused(): boolean {
		return this._paused;
	}

	/** returns true when the caller must pause the pty */
	sent(charCount: number): boolean {
		this._unacknowledgedChars += charCount;
		if (!this._paused && this._unacknowledgedChars > this._highWatermark) {
			this._paused = true;
			return true;
		}
		return false;
	}

	/** returns true when the caller must resume the pty */
	ack(charCount: number): boolean {
		this._unacknowledgedChars = Math.max(0, this._unacknowledgedChars - charCount);
		if (this._paused && this._unacknowledgedChars < this._lowWatermark) {
			this._paused = false;
			return true;
		}
		return false;
	}
}
