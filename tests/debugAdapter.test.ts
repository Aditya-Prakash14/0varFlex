// A2-2: the DAP conversation, end to end against the REAL adapter process.
//
// This is the automatable half of the exercise's acceptance sketch: start a session, stop at a
// breakpoint, read the call stack and variables, step, continue, and verify the adapter process
// is actually reaped on disconnect. It needs `npm run build` to have produced out/ (the adapter
// is a bundle, like a shipped one) and skips itself if that has not happened.
//
// The framing used on this wire is the shared reader/writer — the same one the LSP client uses.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { encodeMessage, MessageReader } from '../src/common/base/parts/protocol/common/messageFraming.js';

const ADAPTER = path.join(process.cwd(), 'extensions', 'toy-debug', 'out', 'adapter.js');
const HAVE_ADAPTER = existsSync(ADAPTER);

/** the program used by every case: a breakpoint on line 4 stops with counter === 2 */
const PROGRAM = [
	'set 0',   // line 1
	'inc',     // line 2
	'inc',     // line 3
	'inc 10',  // line 4  <-- breakpoint here
	'print',   // line 5
	'dec 3'    // line 6
].join('\n') + '\n';

/** a tiny DAP client: enough to drive the adapter and correlate responses */
class TestClient {

	private readonly _reader = new MessageReader();
	private readonly _pending = new Map<number, (response: any) => void>();
	private readonly _events: { event: string; body: any }[] = [];
	private readonly _eventWaiters: { event: string; resolve: (body: any) => void }[] = [];
	private _seq = 1;

	constructor(private readonly _child: ChildProcessWithoutNullStreams) {
		this._child.stdout.on('data', (chunk: Buffer) => {
			for (const message of this._reader.append(chunk)) {
				const dap = message as any;
				if (dap.type === 'response') {
					this._pending.get(dap.request_seq)?.(dap);
					this._pending.delete(dap.request_seq);
				} else if (dap.type === 'event') {
					this._events.push({ event: dap.event, body: dap.body });
					const index = this._eventWaiters.findIndex(waiter => waiter.event === dap.event);
					if (index >= 0) {
						this._eventWaiters.splice(index, 1)[0].resolve(dap.body);
					}
				}
			}
		});
	}

	request(command: string, args?: unknown): Promise<any> {
		const seq = this._seq++;
		return new Promise(resolve => {
			this._pending.set(seq, resolve);
			this._child.stdin.write(encodeMessage({ seq, type: 'request', command, arguments: args }));
		});
	}

	/** resolve with an event's body, from the backlog if it already arrived */
	waitForEvent(event: string, timeoutMs = 4000): Promise<any> {
		const seen = this._events.find(entry => entry.event === event);
		if (seen) {
			return Promise.resolve(seen.body);
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out waiting for the '${event}' event`)), timeoutMs);
			this._eventWaiters.push({
				event,
				resolve: body => {
					clearTimeout(timer);
					resolve(body);
				}
			});
		});
	}

	outputs(): string[] {
		return this._events.filter(entry => entry.event === 'output').map(entry => String(entry.body?.output ?? ''));
	}
}

interface ISession {
	client: TestClient;
	child: ChildProcessWithoutNullStreams;
	programPath: string;
	dispose(): void;
}

function startAdapter(program: string): ISession {
	const dir = mkdtempSync(path.join(tmpdir(), '0varflex-debug-'));
	const programPath = path.join(dir, 'program.toy');
	writeFileSync(programPath, program, 'utf8');

	const child = spawn(process.execPath, [ADAPTER], { stdio: 'pipe' }) as ChildProcessWithoutNullStreams;
	return {
		client: new TestClient(child),
		child,
		programPath,
		dispose: () => {
			if (!child.killed) {
				child.kill();
			}
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

/** the handshake the workbench's DebugService performs, in the same order */
async function launchStoppedAtLine4(session: ISession): Promise<void> {
	const initialize = await session.client.request('initialize', { adapterID: 'toy', linesStartAt1: true });
	assert.equal(initialize.success, true);
	assert.equal(initialize.body?.supportsConfigurationDoneRequest, true);
	await session.client.waitForEvent('initialized');

	const setBreakpoints = await session.client.request('setBreakpoints', {
		source: { path: session.programPath },
		breakpoints: [{ line: 4 }]
	});
	assert.equal(setBreakpoints.success, true);
	assert.deepEqual(setBreakpoints.body.breakpoints, [{ verified: true, line: 4 }]);

	await session.client.request('configurationDone', {});
	const launch = await session.client.request('launch', { program: session.programPath });
	assert.equal(launch.success, true);

	const stopped = await session.client.waitForEvent('stopped');
	assert.equal(stopped.reason, 'breakpoint');
	assert.equal(stopped.threadId, 1);
}

test('adapter: the full handshake stops at the breakpoint with the right state', { skip: !HAVE_ADAPTER && 'run npm run build first' }, async () => {
	const session = startAdapter(PROGRAM);
	try {
		await launchStoppedAtLine4(session);

		// the call stack points at the breakpoint line, which has NOT run yet
		const stack = await session.client.request('stackTrace', { threadId: 1 });
		assert.equal(stack.success, true);
		assert.equal(stack.body.stackFrames.length, 1);
		assert.equal(stack.body.stackFrames[0].line, 4);
		assert.equal(stack.body.stackFrames[0].source.path, session.programPath);

		// scopes → variables is the DAP pull the view performs
		const scopes = await session.client.request('scopes', { frameId: stack.body.stackFrames[0].id });
		assert.equal(scopes.body.scopes.length, 1);
		assert.equal(scopes.body.scopes[0].name, 'Locals');

		const variables = await session.client.request('variables', {
			variablesReference: scopes.body.scopes[0].variablesReference
		});
		const byName = new Map<string, string>(variables.body.variables.map((v: any) => [v.name, v.value]));
		// lines 1..3 ran (set 0, inc, inc) so the counter is 2 — line 4 is pending
		assert.equal(byName.get('counter'), '2');
		assert.equal(byName.get('line'), '4');
	} finally {
		session.dispose();
	}
});

test('adapter: step over executes exactly one statement', { skip: !HAVE_ADAPTER && 'run npm run build first' }, async () => {
	const session = startAdapter(PROGRAM);
	try {
		await launchStoppedAtLine4(session);

		await session.client.request('next', { threadId: 1 });
		await session.client.waitForEvent('stopped');

		const stack = await session.client.request('stackTrace', { threadId: 1 });
		assert.equal(stack.body.stackFrames[0].line, 5, 'one step moves to the next statement');

		const scopes = await session.client.request('scopes', { frameId: 1 });
		const variables = await session.client.request('variables', {
			variablesReference: scopes.body.scopes[0].variablesReference
		});
		const counter = variables.body.variables.find((v: any) => v.name === 'counter');
		assert.equal(counter.value, '12', 'inc 10 ran, so 2 + 10');
	} finally {
		session.dispose();
	}
});

test('adapter: continue from a breakpoint runs to the end and terminates', { skip: !HAVE_ADAPTER && 'run npm run build first' }, async () => {
	const session = startAdapter(PROGRAM);
	try {
		await launchStoppedAtLine4(session);

		await session.client.request('continue', { threadId: 1 });
		await session.client.waitForEvent('terminated');

		// print ran after inc 10, so the output carries the mid-program value
		const outputs = session.client.outputs().join('');
		assert.match(outputs, /counter = 12/);
		assert.match(outputs, /program finished with counter = 9/, 'dec 3 ran last');
	} finally {
		session.dispose();
	}
});

test('adapter: with no breakpoints launch runs the whole program', { skip: !HAVE_ADAPTER && 'run npm run build first' }, async () => {
	const session = startAdapter(PROGRAM);
	try {
		await session.client.request('initialize', { adapterID: 'toy' });
		await session.client.waitForEvent('initialized');
		await session.client.request('setBreakpoints', { source: { path: session.programPath }, breakpoints: [] });
		await session.client.request('configurationDone', {});
		await session.client.request('launch', { program: session.programPath });

		await session.client.waitForEvent('terminated');
		assert.match(session.client.outputs().join(''), /program finished with counter = 9/);
	} finally {
		session.dispose();
	}
});

test('adapter: a breakpoint on a blank line is reported unverified', { skip: !HAVE_ADAPTER && 'run npm run build first' }, async () => {
	const session = startAdapter('inc\n\ninc\n');
	try {
		await session.client.request('initialize', { adapterID: 'toy' });
		await session.client.waitForEvent('initialized');
		const response = await session.client.request('setBreakpoints', {
			source: { path: session.programPath },
			breakpoints: [{ line: 2 }]
		});
		// line 2 is blank: there is no statement to stop on
		assert.deepEqual(response.body.breakpoints, [{ verified: false, line: 2 }]);
	} finally {
		session.dispose();
	}
});

test('adapter: an unknown request fails explicitly instead of hanging the client', { skip: !HAVE_ADAPTER && 'run npm run build first' }, async () => {
	const session = startAdapter(PROGRAM);
	try {
		const response = await session.client.request('evaluate', { expression: 'counter' });
		assert.equal(response.success, false);
		assert.match(String(response.message), /unsupported request/);
	} finally {
		session.dispose();
	}
});

test('adapter: a bad program path fails the launch and terminates cleanly', { skip: !HAVE_ADAPTER && 'run npm run build first' }, async () => {
	const session = startAdapter(PROGRAM);
	try {
		await session.client.request('initialize', { adapterID: 'toy' });
		const launch = await session.client.request('launch', { program: path.join(session.programPath, 'nope.toy') });
		assert.equal(launch.success, false);
		assert.match(String(launch.message), /cannot read program/);
		await session.client.waitForEvent('terminated');
	} finally {
		session.dispose();
	}
});

test('adapter: disconnect reaps the process (no orphaned adapters)', { skip: !HAVE_ADAPTER && 'run npm run build first' }, async () => {
	const session = startAdapter(PROGRAM);
	try {
		await launchStoppedAtLine4(session);

		const exited = new Promise<number | null>(resolve => session.child.on('exit', code => resolve(code)));
		await session.client.request('disconnect', { terminateDebuggee: true });

		const code = await Promise.race([
			exited,
			new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 3000))
		]);
		assert.notEqual(code, 'timeout', 'the adapter must exit on disconnect, not linger');
		assert.equal(code, 0, 'and it must exit cleanly');
	} finally {
		session.dispose();
	}
});
