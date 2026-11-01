// The task trust gate. Tasks are defined by files INSIDE the opened folder, so running one runs
// code that folder's author wrote. These cases pin that the gate actually blocks execution and
// that nothing can route around it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Event } from '../src/common/base/common/event.js';
import { URI } from '../src/common/base/common/uri.js';
import type { ILogService } from '../src/common/platform/log/common/log.js';
import type { ITask } from '../src/common/platform/tasks/common/tasks.js';
import { TaskService } from '../src/renderer/workbench/contrib/tasks/browser/taskService.js';

const TASK: ITask = {
	label: 'dangerous', source: 'workspace', command: 'rm', args: ['-rf', '/'], group: 'build'
};

function makeService(trusted: boolean | (() => Promise<boolean>)) {
	const spawned: { shell?: string; args?: readonly string[] }[] = [];
	let trustAsked = 0;

	const terminalService = {
		onProcessData: Event.None,
		onProcessExit: Event.None,
		createProcess: async (_cols: number, _rows: number, overrides?: { shell?: string; shellArgs?: readonly string[] }) => {
			spawned.push({ shell: overrides?.shell, args: overrides?.shellArgs });
			return { id: 1, shellName: 'test' };
		},
		start: async () => { /* nothing to start in a stub */ },
		shutdown: async () => { /* nothing to kill */ }
	};

	const logService: ILogService = {
		_serviceBrand: undefined, onDidLog: Event.None,
		trace: () => { }, info: () => { }, warn: () => { }, error: () => { }
	} as ILogService;

	const service = new TaskService({
		terminalService: terminalService as never,
		fileService: {} as never,
		markers: { removeOwner: () => { }, changeAll: () => { } } as never,
		logService,
		getWorkspaceFolder: () => URI.file('/untrusted-repo'),
		getActiveFile: () => undefined,
		isTrusted: async () => {
			trustAsked++;
			return typeof trusted === 'boolean' ? trusted : trusted();
		}
	});

	return { service, spawned, trustAsked: () => trustAsked };
}

test('trust gate: a refused folder does not spawn anything', async () => {
	const { service, spawned, trustAsked } = makeService(false);

	const started = await service.runTask(TASK);

	assert.equal(started, false, 'runTask must report that it did not start');
	assert.equal(spawned.length, 0, 'no process may be created for an untrusted folder');
	assert.equal(trustAsked(), 1);
	assert.equal(service.state, 'idle', 'a refused task must leave the state alone');
});

test('trust gate: an approved folder runs the command', async () => {
	const { service, spawned, trustAsked } = makeService(true);

	const started = await service.runTask(TASK);

	assert.equal(started, true);
	assert.equal(trustAsked(), 1);
	assert.deepEqual(spawned, [{ shell: 'rm', args: ['-rf', '/'] }]);
	assert.equal(service.state, 'running');
});

test('trust gate: the gate is checked BEFORE the output header is written', async () => {
	// a refusal must not even look like a run started
	const { service } = makeService(false);
	await service.runTask(TASK);
	assert.equal(service.output, '', 'a refused task writes no output at all');
});

test('trust gate: Restart cannot route around the gate', async () => {
	// the output pane's Restart button calls rerun() directly, not through the commands
	let allow = true;
	const { service, spawned } = makeService(async () => allow);

	assert.equal(await service.runTask(TASK), true);
	assert.equal(spawned.length, 1);

	// trust is revoked (a different folder was opened, say) — rerun must ask again and obey
	allow = false;
	service.clearOutput();
	assert.equal(await service.rerun(), false, 'rerun must respect a refusal');
	assert.equal(spawned.length, 1, 'no second process may be spawned');
});

test('trust gate: a refused task is not remembered as running, so the next one is not blocked', async () => {
	let allow = false;
	const { service, spawned } = makeService(async () => allow);

	assert.equal(await service.runTask(TASK), false);
	// the first refusal must not leave the service thinking a task is in flight, or the "already
	// running" prompt would appear for a task that never started
	allow = true;
	assert.equal(await service.runTask(TASK), true);
	assert.equal(spawned.length, 1);
});
