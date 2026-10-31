// Configuration layering: merge nuance, inspect, change events, formatting-preserving writes,
// invalid JSON keeps the last good model.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Event } from '../src/common/base/common/event.js';
import { URI } from '../src/common/base/common/uri.js';
import type { ILogService } from '../src/common/platform/log/common/log.js';
import { createTestFileService } from './harness/fileSystem.js';
import { ConfigurationTarget } from '../src/common/platform/configuration/common/configuration.js';
import { ConfigurationModel } from '../src/common/platform/configuration/common/configurationModels.js';
import { ConfigurationService } from '../src/common/platform/configuration/common/configurationService.js';
import { ConfigurationRegistry } from '../src/common/platform/configuration/common/configurationRegistry.js';

function makeLogService(): { service: ILogService; errors: string[] } {
	const errors: string[] = [];
	const service: ILogService = {
		_serviceBrand: undefined,
		onDidLog: Event.None,
		trace: () => { },
		info: () => { },
		warn: message => { errors.push(message); },
		error: message => { errors.push(typeof message === 'string' ? message : message.message); }
	};
	return { service, errors };
}

const SETTINGS = '/test/User/settings.json';
const WORKSPACE_SETTINGS = '/test/workspace/.0varflex/settings.json';

/** the harness gives every test a real FileService over the in-memory provider */
function makeFileService(initialContent?: string): ReturnType<typeof createTestFileService> {
	const harness = createTestFileService();
	if (initialContent !== undefined) {
		harness.fs.setFile(SETTINGS, initialContent);
	}
	return harness;
}

test('ConfigurationModel: objects deep-merge; arrays and scalars replace', () => {
	const base = new ConfigurationModel({ editor: { fontSize: 14, tabSize: 4, rulers: [80] } });
	const over = new ConfigurationModel({ editor: { fontSize: 16, rulers: [100, 120] } });

	const merged = base.merge(over);
	assert.equal(merged.getValue('editor.fontSize'), 16);
	assert.equal(merged.getValue('editor.tabSize'), 4); // survived the deep merge
	assert.deepEqual(merged.getValue('editor.rulers'), [100, 120]); // array replaced wholesale
	assert.equal(merged.getValue('editor.missing.deep'), undefined);
});

test('inspect() reports defaultValue and userValue per target', async () => {
	const disposable = ConfigurationRegistry.registerConfiguration({
		id: 'testConfiguration',
		properties: {
			'editor.fontSize': { type: 'number', default: 14 }
		}
	});
	try {
		const { fileService, fs } = makeFileService();
		const { service: logService } = makeLogService();
		const configuration = new ConfigurationService(SETTINGS, fileService, logService);
		await configuration.load();

		assert.equal(configuration.getValue<number>('editor.fontSize'), 14);
		await configuration.updateValue('editor.fontSize', 16, ConfigurationTarget.USER);

		const inspected = configuration.inspect<number>('editor.fontSize');
		assert.equal(inspected.defaultValue, 14);
		assert.equal(inspected.userValue, 16);
		assert.equal(inspected.value, 16);

		// the write landed in the file
		assert.ok(fs.getFile(SETTINGS)!.includes('16'));
	} finally {
		disposable.dispose();
	}
});

test('onDidChangeConfiguration + affectsConfiguration', async () => {
	const disposable = ConfigurationRegistry.registerConfiguration({
		id: 'testConfiguration2',
		properties: {
			'editor.fontSize': { type: 'number', default: 14 },
			'editor.tabSize': { type: 'number', default: 4 }
		}
	});
	try {
		const { fileService } = makeFileService();
		const { service: logService } = makeLogService();
		const configuration = new ConfigurationService(SETTINGS, fileService, logService);
		await configuration.load();

		const events: string[][] = [];
		configuration.onDidChangeConfiguration(event => {
			events.push(event.change.keys);
			assert.equal(event.affectsConfiguration('editor'), true);
			assert.equal(event.affectsConfiguration('workbench'), false);
		});

		await configuration.updateValue('editor.fontSize', 16, ConfigurationTarget.USER);
		assert.deepEqual(events, [['editor.fontSize']]);
	} finally {
		disposable.dispose();
	}
});

test('updateValue is formatting-preserving (comments and indent survive)', async () => {
	const original = `{
  // my settings — do not reformat
  "editor.fontSize": 16,
  "editor.tabSize": 2
}
`;
	const disposable = ConfigurationRegistry.registerConfiguration({
		id: 'testConfiguration3',
		properties: {
			'editor.fontSize': { type: 'number', default: 14 },
			'editor.tabSize': { type: 'number', default: 4 }
		}
	});
	try {
		const { fileService, fs } = makeFileService(original);
		const { service: logService } = makeLogService();
		const configuration = new ConfigurationService(SETTINGS, fileService, logService);
		await configuration.load();

		await configuration.updateValue('editor.tabSize', 8, ConfigurationTarget.USER);

		const updated = fs.getFile(SETTINGS)!;
		assert.equal(updated, original.replace('"editor.tabSize": 2', '"editor.tabSize": 8'));
		assert.ok(updated.includes('// my settings — do not reformat'));
		assert.ok(updated.includes('"editor.fontSize": 16'));
	} finally {
		disposable.dispose();
	}
});

test('invalid JSON: errors with line info, last good model stays, recovery is live', async () => {
	const disposable = ConfigurationRegistry.registerConfiguration({
		id: 'testConfiguration4',
		properties: {
			'editor.fontSize': { type: 'number', default: 14 }
		}
	});
	try {
		const { fileService, fs } = makeFileService();
		const { service: logService, errors } = makeLogService();
		const configuration = new ConfigurationService(SETTINGS, fileService, logService);
		await configuration.load();

		await configuration.updateValue('editor.fontSize', 16, ConfigurationTarget.USER);
		assert.equal(configuration.getValue<number>('editor.fontSize'), 16);

		// break the file: line 3 is garbage
		fs.setFile(SETTINGS, `{\n\t"editor.fontSize": 16,\n\tthis is not json\n}\n`);
		await configuration.reload();
		assert.equal(configuration.getValue<number>('editor.fontSize'), 16, 'last good value stays active');
		assert.ok(errors.some(message => message.includes('line 3')), `expected a line-3 error, got ${JSON.stringify(errors)}`);

		// fix it: recovery is live
		fs.setFile(SETTINGS, `{ "editor.fontSize": 18 }`);
		await configuration.reload();
		assert.equal(configuration.getValue<number>('editor.fontSize'), 18);
	} finally {
		disposable.dispose();
	}
});

test('workspace layer: DEFAULT < USER < WORKSPACE; closing the folder reverts', async () => {
	const disposable = ConfigurationRegistry.registerConfiguration({
		id: 'testConfigurationWorkspace',
		properties: {
			'editor.fontSize': { type: 'number', default: 14 },
			'editor.tabSize': { type: 'number', default: 4 }
		}
	});
	try {
		const { fileService, fs } = makeFileService(`{ "editor.fontSize": 16 }`);
		fs.setFile(WORKSPACE_SETTINGS, `{ "editor.fontSize": 22 }`);

		const { service: logService } = makeLogService();
		const configuration = new ConfigurationService(SETTINGS, fileService, logService);
		await configuration.load();
		assert.equal(configuration.getValue<number>('editor.fontSize'), 16, 'user layer wins over defaults');

		// opening the folder brings the workspace layer in (22 beats 16)
		configuration.setWorkspaceSettingsPath(WORKSPACE_SETTINGS);
		await configuration.load();
		assert.equal(configuration.getValue<number>('editor.fontSize'), 22, 'workspace beats user');
		assert.equal(configuration.getValue<number>('editor.tabSize'), 4, 'untouched keys fall through to defaults');

		const inspected = configuration.inspect<number>('editor.fontSize');
		assert.equal(inspected.defaultValue, 14);
		assert.equal(inspected.userValue, 16);
		assert.equal(inspected.workspaceValue, 22);
		assert.equal(inspected.value, 22);

		// closing the folder reverts to the user layer
		configuration.setWorkspaceSettingsPath(null);
		assert.equal(configuration.getValue<number>('editor.fontSize'), 16, 'no folder: workspace layer is gone');

		// and workspace writes edit the workspace file (surgical, like the user file)
		configuration.setWorkspaceSettingsPath(WORKSPACE_SETTINGS);
		await configuration.load();
		await configuration.updateValue('editor.tabSize', 8, ConfigurationTarget.WORKSPACE);
		assert.equal(configuration.getValue<number>('editor.tabSize'), 8);
		assert.ok(fs.getFile(WORKSPACE_SETTINGS)!.includes('"editor.tabSize": 8'));
		assert.ok(fs.getFile(WORKSPACE_SETTINGS)!.includes('"editor.fontSize": 22'), 'the rest of the file survives');
	} finally {
		disposable.dispose();
	}
});

test('duplicate registration warns with the reference message shape', () => {
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (message: string) => { warnings.push(message); };
	try {
		const first = ConfigurationRegistry.registerConfiguration({ id: 'dup1', properties: { 'test.duplicated': { type: 'number', default: 1 } } });
		const second = ConfigurationRegistry.registerConfiguration({ id: 'dup2', properties: { 'test.duplicated': { type: 'number', default: 2 } } });
		first.dispose();
		second.dispose();
	} finally {
		console.warn = originalWarn;
	}
	assert.ok(warnings.includes(`Configuration 'test.duplicated' is already registered.`), JSON.stringify(warnings));
});
