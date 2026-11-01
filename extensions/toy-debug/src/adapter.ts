// extensions/toy-debug/src/adapter.ts — the debug adapter: a separate PROCESS speaking DAP over
// stdio, exactly like a real adapter (js-debug is its own repo; this one is a file).
//
// It implements only what the workbench's client asks for: initialize, launch, setBreakpoints,
// configurationDone, continue, next, stackTrace, scopes, variables, disconnect — plus the
// `initialized`, `stopped`, `output` and `terminated` events.
//
// The framing is the SHARED reader/writer (src/common/base/parts/protocol/common/messageFraming),
// the same one the LSP client uses. That sharing is the point of A2-2.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeMessage, MessageReader } from '../../../src/common/base/parts/protocol/common/messageFraming.js';
import { firstBreakpointIndex, IProgramLine, parseProgram, runUntilBreakpoint, applyLine } from './program.js';

const VARIABLES_REFERENCE_LOCALS = 1000;

let seq = 1;
let programPath = '';
let lines: readonly IProgramLine[] = [];
let breakpointLines = new Set<number>();
let index = 0;
let counter = 0;
let running = false;

function send(message: Record<string, unknown>): void {
	process.stdout.write(encodeMessage({ seq: seq++, ...message }));
}

function respond(request: { seq: number; command: string }, body?: unknown, success = true, message?: string): void {
	send({ type: 'response', request_seq: request.seq, command: request.command, success, body, message });
}

function event(name: string, body?: unknown): void {
	send({ type: 'event', event: name, body });
}

function emitOutputs(outputs: readonly string[]): void {
	for (const output of outputs) {
		event('output', { category: 'stdout', output });
	}
}

/** stopped at the current index, or terminate when the program ran off the end */
function reportStopOrTerminate(reason: string): void {
	if (index >= lines.length) {
		running = false;
		event('output', { category: 'stdout', output: `program finished with counter = ${counter}\n` });
		event('terminated');
		return;
	}
	event('stopped', { reason, threadId: 1, allThreadsStopped: true });
}

function handle(request: { seq: number; command: string; arguments?: any }): void {
	switch (request.command) {
		case 'initialize':
			respond(request, { supportsConfigurationDoneRequest: true });
			// the adapter announces it is ready to receive configuration
			event('initialized');
			break;

		case 'setBreakpoints': {
			const requested: { line: number }[] = request.arguments?.breakpoints ?? [];
			// setBreakpoints REPLACES this source's breakpoints — that is the DAP contract
			breakpointLines = new Set(requested.map(breakpoint => breakpoint.line));

			// This arrives BEFORE launch, so the program is not loaded yet. Verification has to
			// read the source named in the request — which the client gives us precisely so an
			// adapter can answer without a session. Reporting `verified: true` blindly would lie
			// about breakpoints on blank lines, which never get hit.
			const sourcePath = String(request.arguments?.source?.path ?? '');
			let sourceLines = lines;
			if (sourceLines.length === 0 && sourcePath) {
				try {
					sourceLines = parseProgram(readFileSync(sourcePath, 'utf8')).lines;
				} catch {
					sourceLines = []; // unreadable: everything stays unverified
				}
			}

			respond(request, {
				breakpoints: requested.map(breakpoint => ({
					verified: sourceLines.some(line => line.lineNumber === breakpoint.line),
					line: breakpoint.line
				}))
			});
			break;
		}

		case 'configurationDone':
			respond(request);
			break;

		case 'launch': {
			// no program given: debug the fixture this extension ships with. The adapter knows
			// where it lives; the workbench does not need to.
			const requested = String(request.arguments?.program ?? '');
			programPath = requested || join(__dirname, '..', 'program.toy');
			try {
				const text = readFileSync(programPath, 'utf8');
				const parsed = parseProgram(text);
				lines = parsed.lines;
				for (const error of parsed.errors) {
					event('output', { category: 'stderr', output: `line ${error.lineNumber}: ${error.message}\n` });
				}
			} catch (error) {
				respond(request, undefined, false, `cannot read program '${programPath}': ${(error as Error).message}`);
				event('terminated');
				return;
			}

			index = 0;
			counter = 0;
			running = true;
			respond(request);

			// stopOnEntry, or run to the first breakpoint
			if (request.arguments?.stopOnEntry) {
				reportStopOrTerminate('entry');
				break;
			}
			const target = firstBreakpointIndex(lines, breakpointLines, 0);
			if (target === -1) {
				// no breakpoints: run the whole program
				const result = runUntilBreakpoint(lines, 0, counter, new Set());
				index = result.index;
				counter = result.counter;
				emitOutputs(result.outputs);
				reportStopOrTerminate('breakpoint');
			} else {
				// execute everything before the breakpoint, then stop ON it
				for (let i = 0; i < target; i++) {
					const result = applyLine(counter, lines[i]);
					counter = result.counter;
					if (result.output) {
						event('output', { category: 'stdout', output: result.output });
					}
				}
				index = target;
				reportStopOrTerminate('breakpoint');
			}
			break;
		}

		case 'continue': {
			respond(request, { allThreadsContinued: true });
			if (!running) {
				return;
			}
			const result = runUntilBreakpoint(lines, index, counter, breakpointLines);
			index = result.index;
			counter = result.counter;
			emitOutputs(result.outputs);
			reportStopOrTerminate('breakpoint');
			break;
		}

		case 'next': {
			respond(request);
			if (!running) {
				return;
			}
			if (index < lines.length) {
				const result = applyLine(counter, lines[index]);
				counter = result.counter;
				if (result.output) {
					event('output', { category: 'stdout', output: result.output });
				}
				index++;
			}
			reportStopOrTerminate('step');
			break;
		}

		case 'threads':
			respond(request, { threads: [{ id: 1, name: 'toy' }] });
			break;

		case 'stackTrace': {
			const line = lines[index];
			respond(request, {
				stackFrames: line
					? [{
						id: 1,
						name: `${line.op}${line.operand !== undefined ? ` ${line.operand}` : ''}`,
						line: line.lineNumber,
						column: 1,
						source: { name: programPath.split(/[\\/]/).pop(), path: programPath }
					}]
					: [],
				totalFrames: line ? 1 : 0
			});
			break;
		}

		case 'scopes':
			respond(request, {
				scopes: [{ name: 'Locals', variablesReference: VARIABLES_REFERENCE_LOCALS, expensive: false }]
			});
			break;

		case 'variables': {
			if (request.arguments?.variablesReference !== VARIABLES_REFERENCE_LOCALS) {
				respond(request, { variables: [] });
				break;
			}
			const line = lines[index];
			respond(request, {
				variables: [
					{ name: 'counter', value: String(counter), variablesReference: 0 },
					{ name: 'step', value: String(index), variablesReference: 0 },
					{ name: 'line', value: String(line?.lineNumber ?? '-'), variablesReference: 0 },
					{ name: 'statements', value: String(lines.length), variablesReference: 0 }
				]
			});
			break;
		}

		case 'disconnect':
			respond(request);
			event('terminated');
			// let the response flush before leaving
			setTimeout(() => process.exit(0), 10);
			break;

		default:
			// an unknown request gets an explicit failure rather than silence (the client waits)
			respond(request, undefined, false, `unsupported request '${request.command}'`);
			break;
	}
}

const reader = new MessageReader();
process.stdin.on('data', (chunk: Buffer) => {
	let messages: unknown[];
	try {
		messages = reader.append(chunk);
	} catch (error) {
		process.stderr.write(`framing error: ${(error as Error).message}\n`);
		return;
	}
	for (const message of messages) {
		const request = message as { type?: string; seq?: number; command?: string; arguments?: unknown };
		if (request.type === 'request' && typeof request.seq === 'number' && typeof request.command === 'string') {
			try {
				handle(request as { seq: number; command: string; arguments?: unknown });
			} catch (error) {
				// one bad request must not kill the session
				process.stderr.write(`handler error: ${(error as Error).stack ?? error}\n`);
			}
		}
	}
});

process.stdin.on('end', () => process.exit(0));
