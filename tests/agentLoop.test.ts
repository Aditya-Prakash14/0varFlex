// The agentic loop, driven by a scripted fake client.
//
// This is the part of the agent with no other safety net: the tools have their own tests, but
// the loop's rules only show up as misbehaviour against a live API — and each one costs money
// to discover. A fake client makes them assertions instead.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { Event } from '../src/common/base/common/event.js';
import type { ILogService } from '../src/common/platform/log/common/log.js';
import type { IWireAgentEvent } from '../src/common/platform/agent/common/agent.js';
import {
	AgentService,
	buildUserMessage,
	describeError,
	toWorkspaceRelative,
	type IAgentStream,
	type IMessagesClient
} from '../src/main/agent/agentSession.js';

function makeLogService(): ILogService {
	return {
		_serviceBrand: undefined, onDidLog: Event.None,
		trace: () => { }, info: () => { }, warn: () => { }, error: () => { }
	} as ILogService;
}

/** a scripted assistant turn */
interface IScriptedTurn {
	readonly stopReason: 'end_turn' | 'tool_use' | 'refusal' | 'max_tokens' | 'pause_turn';
	readonly text?: string;
	readonly toolUses?: readonly { id: string; name: string; input: unknown }[];
}

interface IFakeClient {
	readonly client: IMessagesClient;
	/** the `messages` array as it was on each request, so the loop's shaping can be checked */
	readonly requests: unknown[][];
	readonly aborts: number;
	abortCount(): number;
}

function fakeClient(turns: readonly IScriptedTurn[], options: { hangOnTurn?: number } = {}): IFakeClient {
	const requests: unknown[][] = [];
	let index = 0;
	let aborts = 0;

	const client: IMessagesClient = {
		messages: {
			stream(params) {
				requests.push(JSON.parse(JSON.stringify(params.messages)) as unknown[]);
				const turn = turns[index++] ?? { stopReason: 'end_turn' as const, text: 'done' };

				let abortRequested = false;
				const stream: IAgentStream = {
					on: (_event, listener) => {
						if (turn.text) {
							// deliver the text as two deltas, like a real stream would
							const half = Math.ceil(turn.text.length / 2);
							listener(turn.text.slice(0, half));
							listener(turn.text.slice(half));
						}
						return stream;
					},
					abort: () => {
						aborts++;
						abortRequested = true;
					},
					finalMessage: async () => {
						if (options.hangOnTurn === index - 1) {
							// wait until aborted, like a stream the user stopped
							await new Promise<void>(resolve => {
								const timer = setInterval(() => {
									if (abortRequested) {
										clearInterval(timer);
										resolve();
									}
								}, 2);
							});
							const error = new Error('Request was aborted.');
							error.name = 'APIUserAbortError';
							throw error;
						}

						const content: unknown[] = [];
						if (turn.text) {
							content.push({ type: 'text', text: turn.text });
						}
						for (const toolUse of turn.toolUses ?? []) {
							content.push({ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input });
						}
						return {
							id: `msg-${index}`,
							type: 'message',
							role: 'assistant',
							model: 'claude-opus-5-5',
							content,
							stop_reason: turn.stopReason,
							stop_sequence: null,
							usage: { input_tokens: 10, output_tokens: 5 }
						} as never;
					}
				};
				return stream;
			}
		}
	};

	return { client, requests, aborts, abortCount: () => aborts };
}

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(path.join(tmpdir(), '0varflex-loop-'));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function makeService(fake: IFakeClient) {
	const events: IWireAgentEvent[] = [];
	const changedFiles: string[][] = [];
	const service = new AgentService({
		logService: makeLogService(),
		createClient: () => fake.client,
		searchFiles: async () => [{ path: 'a.ts', line: 1, text: 'hit' }]
	});
	service.onDidEmitEvent(event => events.push(event));
	service.onDidChangeFiles(event => changedFiles.push([...event.paths]));
	return { service, events, changedFiles };
}

const BASE = { sessionId: 's1', allowCommands: false };

// ---- the simple path

test('loop: a plain text turn streams deltas and ends once', async () => {
	await withWorkspace(async root => {
		const fake = fakeClient([{ stopReason: 'end_turn', text: 'Hello there' }]);
		const { service, events } = makeService(fake);

		await service.send({ ...BASE, prompt: 'hi', workspaceRoot: root });

		const text = events.filter(e => e.kind === 'text').map(e => (e as { delta: string }).delta).join('');
		assert.equal(text, 'Hello there');
		const done = events.filter(e => e.kind === 'done');
		assert.equal(done.length, 1, 'exactly one terminal event');
		assert.equal((done[0] as { stopReason: string }).stopReason, 'end_turn');
		assert.equal(fake.requests.length, 1, 'no extra round trip after end_turn');
	});
});

test('loop: no workspace folder is refused before any request is made', async () => {
	const fake = fakeClient([{ stopReason: 'end_turn', text: 'x' }]);
	const { service, events } = makeService(fake);

	await service.send({ ...BASE, prompt: 'hi', workspaceRoot: undefined });

	assert.equal(fake.requests.length, 0, 'the API must not be called without a folder');
	assert.equal(events.filter(e => e.kind === 'error').length, 1);
});

// ---- the rule that is easiest to get wrong

test('loop: ALL tool results for one turn go back in a SINGLE user message', async () => {
	await withWorkspace(async root => {
		await writeFile(path.join(root, 'a.ts'), 'alpha\n', 'utf8');
		await writeFile(path.join(root, 'b.ts'), 'beta\n', 'utf8');

		// two parallel reads in one assistant turn
		const fake = fakeClient([
			{
				stopReason: 'tool_use',
				toolUses: [
					{ id: 't1', name: 'read_file', input: { path: 'a.ts' } },
					{ id: 't2', name: 'read_file', input: { path: 'b.ts' } }
				]
			},
			{ stopReason: 'end_turn', text: 'read both' }
		]);
		const { service } = makeService(fake);

		await service.send({ ...BASE, prompt: 'read both files', workspaceRoot: root });

		// the second request carries: user, assistant(tool_use x2), user(tool_result x2)
		const second = fake.requests[1] as { role: string; content: unknown }[];
		const resultMessages = second.filter(message => message.role === 'user' && Array.isArray(message.content)
			&& (message.content as { type?: string }[]).some(block => block.type === 'tool_result'));

		assert.equal(resultMessages.length, 1, 'splitting results across messages stops parallel calls');
		const blocks = resultMessages[0].content as { type: string; tool_use_id: string }[];
		assert.equal(blocks.length, 2, 'both results in that one message');
		assert.deepEqual(blocks.map(block => block.tool_use_id).sort(), ['t1', 't2']);
	});
});

test('loop: a failed tool still returns a tool_result, flagged as an error', async () => {
	await withWorkspace(async root => {
		const fake = fakeClient([
			// a traversal the guard will refuse
			{ stopReason: 'tool_use', toolUses: [{ id: 't1', name: 'read_file', input: { path: '../escape.txt' } }] },
			{ stopReason: 'end_turn', text: 'could not' }
		]);
		const { service, events } = makeService(fake);

		await service.send({ ...BASE, prompt: 'read it', workspaceRoot: root });

		const second = fake.requests[1] as { role: string; content: unknown }[];
		const resultBlock = (second[second.length - 1].content as { type: string; is_error?: boolean }[])[0];
		assert.equal(resultBlock.type, 'tool_result');
		assert.equal(resultBlock.is_error, true, 'dropping a failed result breaks the conversation');

		const toolEnd = events.find(e => e.kind === 'tool-end') as { ok: boolean } | undefined;
		assert.equal(toolEnd?.ok, false, 'and the view shows it failed');
	});
});

// ---- the stop reasons that must not run tools

test('loop: a refusal never runs that turn\'s tools', async () => {
	await withWorkspace(async root => {
		const target = path.join(root, 'victim.ts');
		await writeFile(target, 'original\n', 'utf8');

		// a refusal can cut a tool input off mid-stream, so the call is not trustworthy
		const fake = fakeClient([{
			stopReason: 'refusal',
			toolUses: [{ id: 't1', name: 'write_file', input: { path: 'victim.ts', content: 'OVERWRITTEN' } }]
		}]);
		const { service, events } = makeService(fake);

		await service.send({ ...BASE, prompt: 'go', workspaceRoot: root });

		assert.equal(await readFile(target, 'utf8'), 'original\n', 'the file must be untouched');
		assert.equal(events.filter(e => e.kind === 'tool-start').length, 0, 'no tool may even start');
		assert.equal(events.filter(e => e.kind === 'error').length, 1);
	});
});

test('loop: max_tokens on a tool turn refuses the call instead of acting on truncated input', async () => {
	await withWorkspace(async root => {
		const target = path.join(root, 'victim.ts');
		await writeFile(target, 'original\n', 'utf8');

		// truncated arguments often still parse, which is exactly why this is dangerous
		const fake = fakeClient([{
			stopReason: 'max_tokens',
			toolUses: [{ id: 't1', name: 'write_file', input: { path: 'victim.ts', content: 'HALF WRITT' } }]
		}]);
		const { service, events } = makeService(fake);

		await service.send({ ...BASE, prompt: 'go', workspaceRoot: root });

		assert.equal(await readFile(target, 'utf8'), 'original\n', 'a truncated write must not land');
		const error = events.find(e => e.kind === 'error') as { message: string } | undefined;
		assert.ok(error && /output limit/.test(error.message), 'and the user is told why');
	});
});

test('loop: pause_turn is not an end — the turn is sent back', async () => {
	await withWorkspace(async root => {
		const fake = fakeClient([
			{ stopReason: 'pause_turn', text: 'thinking' },
			{ stopReason: 'end_turn', text: 'finished' }
		]);
		const { service, events } = makeService(fake);

		await service.send({ ...BASE, prompt: 'go', workspaceRoot: root });

		assert.equal(fake.requests.length, 2, 'the paused turn must be continued');
		const done = events.filter(e => e.kind === 'done');
		assert.equal(done.length, 1);
		assert.equal((done[0] as { stopReason: string }).stopReason, 'end_turn');
	});
});

// ---- cancel

test('loop: Stop aborts the in-flight request rather than only setting a flag', async () => {
	await withWorkspace(async root => {
		// turn 0 hangs until aborted, standing in for a long generation
		const fake = fakeClient([{ stopReason: 'end_turn', text: 'never' }], { hangOnTurn: 0 });
		const { service, events } = makeService(fake);

		const pending = service.send({ ...BASE, prompt: 'go', workspaceRoot: root });
		// let the loop reach the stream before stopping it
		await new Promise(resolve => setTimeout(resolve, 20));
		await service.cancel('s1');
		await pending;

		assert.equal(fake.abortCount(), 1, 'the HTTP request must actually be aborted — it bills otherwise');
		const done = events.filter(e => e.kind === 'done');
		assert.equal(done.length, 1);
		assert.equal((done[0] as { stopReason: string }).stopReason, 'cancelled');
		assert.equal(events.filter(e => e.kind === 'error').length, 0, 'Stop is not an error');
	});
});

// ---- edits are published so open editors reload

test('loop: files the agent wrote are published once the turn ends', async () => {
	await withWorkspace(async root => {
		const fake = fakeClient([
			{ stopReason: 'tool_use', toolUses: [{ id: 't1', name: 'write_file', input: { path: 'new.ts', content: 'x\n' } }] },
			{ stopReason: 'end_turn', text: 'wrote it' }
		]);
		const { service, changedFiles } = makeService(fake);

		await service.send({ ...BASE, prompt: 'create it', workspaceRoot: root });

		assert.equal(changedFiles.length, 1, 'the workbench needs this to reload the editor');
		assert.ok(changedFiles[0][0].endsWith('new.ts'));
		assert.equal(await readFile(path.join(root, 'new.ts'), 'utf8'), 'x\n');
	});
});

// ---- runaway protection

test('loop: a model that never stops is cut off with an explanation', async () => {
	await withWorkspace(async root => {
		await writeFile(path.join(root, 'a.ts'), 'x\n', 'utf8');
		// always asks for another tool call, never ends
		const forever = Array.from({ length: 60 }, () => ({
			stopReason: 'tool_use' as const,
			toolUses: [{ id: 't', name: 'read_file', input: { path: 'a.ts' } }]
		}));
		const fake = fakeClient(forever);
		const { service, events } = makeService(fake);

		await service.send({ ...BASE, prompt: 'loop', workspaceRoot: root });

		assert.ok(fake.requests.length <= 41, `the loop must be capped, made ${fake.requests.length} requests`);
		const error = events.find(e => e.kind === 'error') as { message: string } | undefined;
		assert.ok(error && /Stopped after/.test(error.message));
	});
});

test('loop: a second send while busy is rejected rather than interleaved', async () => {
	await withWorkspace(async root => {
		const fake = fakeClient([{ stopReason: 'end_turn', text: 'x' }], { hangOnTurn: 0 });
		const { service, events } = makeService(fake);

		const first = service.send({ ...BASE, prompt: 'one', workspaceRoot: root });
		await new Promise(resolve => setTimeout(resolve, 20));
		await service.send({ ...BASE, prompt: 'two', workspaceRoot: root });

		const errors = events.filter(e => e.kind === 'error') as { message: string }[];
		assert.ok(errors.some(error => /already working/.test(error.message)));

		await service.cancel('s1');
		await first;
	});
});

// ---- the editor context that travels with each message

test('buildUserMessage: the active file is given as a WORKSPACE-RELATIVE path', () => {
	const root = path.join(path.sep, 'repo');
	const message = buildUserMessage(
		{ prompt: 'fix this', activeFile: path.join(root, 'src', 'a.ts') },
		root
	);
	// an absolute path would teach the model to send one back, and every tool call would be refused
	assert.ok(message.includes('Active editor: src/a.ts'), message);
	assert.ok(!message.includes(root), 'the absolute path must not appear');
	assert.ok(message.endsWith('fix this'));
});

test('buildUserMessage: a file outside the workspace is left out, not sent as ..', () => {
	const root = path.join(path.sep, 'repo');
	const message = buildUserMessage(
		{ prompt: 'fix', activeFile: path.join(path.sep, 'elsewhere', 'x.ts') },
		root
	);
	assert.equal(message, 'fix');
});

test('buildUserMessage: a selection is fenced, and a huge one is clipped', () => {
	const root = path.join(path.sep, 'repo');
	const withSelection = buildUserMessage({ prompt: 'explain', selectionText: 'const a = 1;' }, root);
	assert.ok(withSelection.includes('```\nconst a = 1;\n```'));

	const huge = buildUserMessage({ prompt: 'explain', selectionText: 'x'.repeat(10_000) }, root);
	assert.ok(huge.includes('selection truncated'), 'context must not crowd out the task');
	assert.ok(huge.length < 6000);
});

test('buildUserMessage: no context means the prompt is sent unchanged', () => {
	assert.equal(buildUserMessage({ prompt: 'hello' }, path.sep), 'hello');
	assert.equal(buildUserMessage({ prompt: 'hello', selectionText: '   ' }, path.sep), 'hello');
});

test('toWorkspaceRelative: posix separators on every platform, outside paths rejected', () => {
	const root = path.join(path.sep, 'repo');
	assert.equal(toWorkspaceRelative(root, path.join(root, 'a', 'b.ts')), 'a/b.ts');
	assert.equal(toWorkspaceRelative(root, root), undefined);
	assert.equal(toWorkspaceRelative(root, path.join(path.sep, 'other', 'b.ts')), undefined);
});

// ---- errors the user can act on

test('describeError turns SDK failures into advice, not stack traces', () => {
	// a plain error passes its message through
	assert.equal(describeError(new Error('boom')), 'boom');
	assert.ok(describeError('odd').length > 0);
});
