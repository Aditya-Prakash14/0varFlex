// src/extHost/extHostConsole.ts — console + stdout forwarding, ported from
// vs/workbench/api/common/extHostConsoleForwarder.ts: every line reaches the renderer log with
// the `[extensionId]` prefix, because the host's own stdout is invisible to the workbench.

import type { IMainThreadLog } from './mainThreadTypes.js';
import { getCurrentExtension } from './currentExtension.js';

export function installConsoleForwarder(proxy: IMainThreadLog): void {
	const forward = (level: 'trace' | 'info' | 'warn' | 'error', args: unknown[]): void => {
		const extensionId = getCurrentExtension();
		const message = args.map(argument => format(argument)).join(' ');
		void proxy.$log(level, message, extensionId).catch(() => { /* renderer gone */ });
	};

	const originalConsole = {
		log: console.log.bind(console),
		info: console.info.bind(console),
		warn: console.warn.bind(console),
		error: console.error.bind(console),
		trace: console.trace.bind(console)
	};

	// forward-only: calling the originals too would ALSO hit the stdout patch below and the
	// main process would print every line twice
	console.log = (...args: unknown[]) => forward('info', args);
	console.info = (...args: unknown[]) => forward('info', args);
	console.warn = (...args: unknown[]) => forward('warn', args);
	console.error = (...args: unknown[]) => forward('error', args);
	console.trace = (...args: unknown[]) => forward('trace', args);
	void originalConsole;

	// stdout/stderr writes (servers in 12 log this way) — line-buffered, like the reference
	const patchStream = (stream: NodeJS.WriteStream, level: 'info' | 'error'): void => {
		const original = stream.write.bind(stream);
		let buffered = '';
		(stream as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
			buffered += String(chunk);
			let index: number;
			while ((index = buffered.indexOf('\n')) >= 0) {
				const line = buffered.substring(0, index);
				buffered = buffered.substring(index + 1);
				if (line.trim().length > 0) {
					void proxy.$log(level, `[stdout] ${line}`).catch(() => { /* ignore */ });
				}
			}
			return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
		};
	};
	patchStream(process.stdout, 'info');
	patchStream(process.stderr, 'error');
}

function format(value: unknown): string {
	if (value instanceof Error) {
		return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
	}
	if (typeof value === 'string') {
		return value;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
