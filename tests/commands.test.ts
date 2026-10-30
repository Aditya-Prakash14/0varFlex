// Command registry + service semantics: unknown ids, surfacing-vs-execution, error paths.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Event } from '../src/common/base/common/event.js';
import { InstantiationService } from '../src/common/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../src/common/platform/instantiation/common/serviceCollection.js';
import type { ILogService } from '../src/common/platform/log/common/log.js';
import { CommandMetadata, CommandsRegistry, ICommandService } from '../src/renderer/platform/commands/common/commands.js';
import { ContextKeyExpr } from '../src/renderer/platform/contextkey/common/contextkey.js';
import { ContextKeyService } from '../src/renderer/platform/contextkey/common/contextKeyService.js';
import { CommandService } from '../src/renderer/workbench/services/commands/common/commandService.js';

function makeLogService(): { service: ILogService; messages: string[] } {
	const messages: string[] = [];
	const service: ILogService = {
		_serviceBrand: undefined,
		onDidLog: Event.None,
		trace: () => { },
		info: () => { },
		warn: message => { messages.push(message); },
		error: message => { messages.push(typeof message === 'string' ? message : message.message); }
	};
	return { service, messages };
}

function createService(): { service: CommandService; messages: string[] } {
	const { service: logService, messages } = makeLogService();
	const container = new ServiceCollection();
	const instantiationService = new InstantiationService(container);
	const service = new CommandService(instantiationService, logService);
	container.set(ICommandService, service);
	return { service, messages };
}

test('unknown command rejects with the reference message shape', async () => {
	const { service } = createService();
	await assert.rejects(service.executeCommand('nope.command'), /command 'nope\.command' not found/);
});

test('preconditions gate surfacing, never execution', async () => {
	const { service } = createService();
	const contextKeyService = new ContextKeyService();

	let executed = 0;
	CommandsRegistry.registerCommand('test.gated', () => { executed++; });
	CommandMetadata.register({ id: 'test.gated', title: 'Gated Command', precondition: ContextKeyExpr.not('someFlag') });

	const precondition = CommandMetadata.get('test.gated')!.precondition;

	// panel-style: flag unset → !someFlag is true → the palette would surface it
	assert.equal(contextKeyService.contextMatchesRules(precondition), true);
	await service.executeCommand('test.gated');
	assert.equal(executed, 1);

	// flag set → precondition is false → hidden from surfacing...
	contextKeyService.createKey<boolean>('someFlag', true).set(true);
	await Promise.resolve(); // the service buffers change events (and cache invalidation) per microtask
	assert.equal(contextKeyService.contextMatchesRules(precondition), false);

	// ...but execution still works — surprising and important upstream semantics
	await service.executeCommand('test.gated');
	assert.equal(executed, 2);
});

test('handler errors reject, fire onDidExecuteCommand, and log', async () => {
	const { service, messages } = createService();

	let didExecute = 0;
	service.onDidExecuteCommand(() => didExecute++);

	CommandsRegistry.registerCommand('test.throwsSync', () => { throw new Error('sync boom'); });
	await assert.rejects(service.executeCommand('test.throwsSync'), /sync boom/);
	assert.equal(didExecute, 1);
	assert.ok(messages.some(message => message.includes('sync boom')), `expected logged error, got ${JSON.stringify(messages)}`);

	CommandsRegistry.registerCommand('test.throwsAsync', async () => { throw new Error('async boom'); });
	await assert.rejects(service.executeCommand('test.throwsAsync'), /async boom/);
	assert.equal(didExecute, 2);
	assert.ok(messages.some(message => message.includes('async boom')));
});

test('registerCommandAlias routes through the command service', async () => {
	const { service } = createService();
	CommandsRegistry.registerCommand('test.target', () => 'the result');
	CommandsRegistry.registerCommandAlias('test.alias', 'test.target');

	assert.equal(await service.executeCommand('test.alias'), 'the result');
});

test('onWillExecuteCommand/onDidExecuteCommand fire with id and args', async () => {
	const { service } = createService();
	CommandsRegistry.registerCommand('test.events', (accessor, a: number, b: number) => a + b);

	const will: unknown[][] = [];
	const did: unknown[][] = [];
	service.onWillExecuteCommand(e => will.push([e.commandId, ...e.args]));
	service.onDidExecuteCommand(e => did.push([e.commandId, ...e.args]));

	assert.equal(await service.executeCommand('test.events', 20, 22), 42);
	assert.deepEqual(will, [['test.events', 20, 22]]);
	assert.deepEqual(did, [['test.events', 20, 22]]);
});
