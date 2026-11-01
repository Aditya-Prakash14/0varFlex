// The coding agent's safety boundary.
//
// A tool input is untrusted model output. `confinePath` is the only thing standing between a
// hallucinated or adversarial path and the user's home directory, so it is tested hardest:
// traversal, absolute paths, symlinks out of the tree, and the not-yet-created-file case that
// has to keep working without opening a hole.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
	confinePath,
	countOccurrences,
	isInside,
	runAgentTool,
	agentToolDefinitions,
	type IAgentToolContext
} from '../src/main/agent/agentTools.js';
import { describeToolCall } from '../src/main/agent/agentSession.js';

async function withWorkspace(run: (root: string, outside: string) => Promise<void>): Promise<void> {
	// a sibling directory stands in for "anywhere outside the workspace"
	const base = await mkdtemp(path.join(tmpdir(), '0varflex-agent-'));
	const root = path.join(base, 'workspace');
	const outside = path.join(base, 'outside');
	await mkdir(root, { recursive: true });
	await mkdir(outside, { recursive: true });
	try {
		await run(root, outside);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
}

function makeContext(root: string, overrides: Partial<IAgentToolContext> = {}): IAgentToolContext {
	return {
		workspaceRoot: root,
		allowCommands: false,
		searchFiles: async () => [],
		...overrides
	};
}

// ---- isInside

test('isInside: the root itself is inside, a sibling is not', () => {
	assert.equal(isInside('/a/b', '/a/b'), true);
	assert.equal(isInside('/a/b', path.join('/a/b', 'c')), true);
	assert.equal(isInside('/a/b', '/a/bc'), false, 'a prefix match is not a path match');
	assert.equal(isInside('/a/b', '/a'), false);
	assert.equal(isInside('/a/b', '/other'), false);
});

// ---- confinePath: the cases that matter

test('confinePath: a plain relative path resolves inside the workspace', async () => {
	await withWorkspace(async root => {
		await writeFile(path.join(root, 'a.ts'), 'x', 'utf8');
		const result = await confinePath(root, 'a.ts');
		assert.equal(result.ok, true);
		assert.ok(result.ok && result.absolutePath.endsWith('a.ts'));
	});
});

test('confinePath: directory traversal is refused', async () => {
	await withWorkspace(async (root, outside) => {
		await writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
		for (const attempt of ['../outside/secret.txt', '../../etc/passwd', 'sub/../../outside/secret.txt', '..']) {
			const result = await confinePath(root, attempt);
			assert.equal(result.ok, false, `"${attempt}" must be refused`);
		}
	});
});

test('confinePath: an absolute path is refused even when it points inside', async () => {
	await withWorkspace(async root => {
		await writeFile(path.join(root, 'a.ts'), 'x', 'utf8');
		// refused on principle: tools take workspace-relative paths, so an absolute one is a
		// sign the model is confused about where it is
		const result = await confinePath(root, path.join(root, 'a.ts'));
		assert.equal(result.ok, false);
	});
});

test('confinePath: a symlink pointing OUT of the workspace is refused', async () => {
	await withWorkspace(async (root, outside) => {
		const secret = path.join(outside, 'secret.txt');
		await writeFile(secret, 'secret', 'utf8');
		try {
			await symlink(secret, path.join(root, 'link.txt'));
		} catch {
			return; // symlink creation needs privileges on some Windows setups; skip there
		}

		// the lexical check passes here — only realpath catches it
		const result = await confinePath(root, 'link.txt');
		assert.equal(result.ok, false, 'a symlink out of the tree must be refused');
		assert.ok(!result.ok && /symlink/.test(result.reason));
	});
});

test('confinePath: a symlink INSIDE the workspace is allowed', async () => {
	await withWorkspace(async root => {
		const real = path.join(root, 'real.txt');
		await writeFile(real, 'ok', 'utf8');
		try {
			await symlink(real, path.join(root, 'alias.txt'));
		} catch {
			return;
		}
		const result = await confinePath(root, 'alias.txt');
		assert.equal(result.ok, true);
	});
});

test('confinePath: a file that does not exist yet is allowed (creating files must work)', async () => {
	await withWorkspace(async root => {
		const result = await confinePath(root, 'new/nested/file.ts');
		// the parent does not exist either, so this is refused with a clear reason
		assert.equal(result.ok, false);
		assert.ok(!result.ok && /parent directory does not exist/.test(result.reason));

		await mkdir(path.join(root, 'new', 'nested'), { recursive: true });
		const second = await confinePath(root, 'new/nested/file.ts');
		assert.equal(second.ok, true, 'with the parent present, a new file is fine');
	});
});

test('confinePath: a new file under a symlinked-out parent is refused', async () => {
	await withWorkspace(async (root, outside) => {
		try {
			await symlink(outside, path.join(root, 'escape'), 'dir');
		} catch {
			return;
		}
		// the file does not exist, so the PARENT is canonicalized — it must be checked too
		const result = await confinePath(root, 'escape/planted.ts');
		assert.equal(result.ok, false, 'creating a file through a symlinked directory must be refused');
	});
});

test('confinePath: empty, null-byte and non-string paths are refused', async () => {
	await withWorkspace(async root => {
		assert.equal((await confinePath(root, '')).ok, false);
		assert.equal((await confinePath(root, 'a\0b')).ok, false);
		assert.equal((await confinePath(root, undefined as never)).ok, false);
	});
});

// ---- the file tools honour the guard

test('read_file refuses a traversal instead of reading the file', async () => {
	await withWorkspace(async (root, outside) => {
		await writeFile(path.join(outside, 'secret.txt'), 'TOP SECRET', 'utf8');
		const result = await runAgentTool('read_file', { path: '../outside/secret.txt' }, makeContext(root));
		assert.equal(result.isError, true);
		assert.ok(!result.content.includes('TOP SECRET'), 'the file contents must never be returned');
	});
});

test('write_file refuses a traversal instead of writing outside', async () => {
	await withWorkspace(async (root, outside) => {
		const target = path.join(outside, 'planted.txt');
		const result = await runAgentTool('write_file', { path: '../outside/planted.txt', content: 'x' }, makeContext(root));
		assert.equal(result.isError, true);
		await assert.rejects(() => readFile(target, 'utf8'), 'nothing may be written outside the workspace');
	});
});

test('read_file returns 1-based line numbers so the model can quote exact lines', async () => {
	await withWorkspace(async root => {
		await writeFile(path.join(root, 'a.ts'), 'first\nsecond\n', 'utf8');
		const result = await runAgentTool('read_file', { path: 'a.ts' }, makeContext(root));
		assert.equal(result.isError, false);
		assert.ok(result.content.startsWith('1\tfirst'));
		assert.ok(result.content.includes('2\tsecond'));
	});
});

test('read_file refuses a binary file and a directory', async () => {
	await withWorkspace(async root => {
		await writeFile(path.join(root, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
		await mkdir(path.join(root, 'folder'));
		assert.equal((await runAgentTool('read_file', { path: 'bin.dat' }, makeContext(root))).isError, true);
		const dir = await runAgentTool('read_file', { path: 'folder' }, makeContext(root));
		assert.equal(dir.isError, true);
		assert.ok(/list_directory/.test(dir.content), 'it should point at the right tool');
	});
});

// ---- edit_file: the uniqueness contract is what keeps it from editing the wrong code

test('edit_file replaces a unique string', async () => {
	await withWorkspace(async root => {
		const file = path.join(root, 'a.ts');
		await writeFile(file, 'const a = 1;\nconst b = 2;\n', 'utf8');
		const result = await runAgentTool('edit_file', { path: 'a.ts', old_text: 'const b = 2;', new_text: 'const b = 3;' }, makeContext(root));
		assert.equal(result.isError, false);
		assert.equal(await readFile(file, 'utf8'), 'const a = 1;\nconst b = 3;\n');
		assert.equal(result.changedPath, await (await import('node:fs/promises')).realpath(file));
	});
});

test('edit_file fails loudly when old_text is NOT unique, and changes nothing', async () => {
	await withWorkspace(async root => {
		const file = path.join(root, 'a.ts');
		const original = 'x = 1;\nx = 1;\n';
		await writeFile(file, original, 'utf8');
		const result = await runAgentTool('edit_file', { path: 'a.ts', old_text: 'x = 1;', new_text: 'x = 2;' }, makeContext(root));
		assert.equal(result.isError, true);
		assert.ok(/appears 2 times/.test(result.content), 'the model needs to know why, to fix its call');
		assert.equal(await readFile(file, 'utf8'), original, 'an ambiguous edit must not be applied');
	});
});

test('edit_file fails when old_text is absent, and changes nothing', async () => {
	await withWorkspace(async root => {
		const file = path.join(root, 'a.ts');
		await writeFile(file, 'const a = 1;\n', 'utf8');
		const result = await runAgentTool('edit_file', { path: 'a.ts', old_text: 'const z = 9;', new_text: 'x' }, makeContext(root));
		assert.equal(result.isError, true);
		assert.equal(await readFile(file, 'utf8'), 'const a = 1;\n');
	});
});

test('edit_file treats old_text as literal text, not a pattern', async () => {
	await withWorkspace(async root => {
		const file = path.join(root, 'a.ts');
		// regex metacharacters must match themselves
		await writeFile(file, 'if (a.b[0]) { x(); }\n', 'utf8');
		const result = await runAgentTool('edit_file', { path: 'a.ts', old_text: 'a.b[0]', new_text: 'a.b[1]' }, makeContext(root));
		assert.equal(result.isError, false);
		assert.equal(await readFile(file, 'utf8'), 'if (a.b[1]) { x(); }\n');
	});
});

test('countOccurrences counts literal, non-overlapping matches', () => {
	assert.equal(countOccurrences('aaa', 'a'), 3);
	assert.equal(countOccurrences('aaaa', 'aa'), 2, 'non-overlapping');
	assert.equal(countOccurrences('a.b', '.'), 1, 'a dot is a dot');
	assert.equal(countOccurrences('abc', 'z'), 0);
	assert.equal(countOccurrences('abc', ''), 0);
});

// ---- run_command is off unless the user turned it on

test('run_command is refused when commands are not allowed', async () => {
	await withWorkspace(async root => {
		const result = await runAgentTool('run_command', { command: 'node', args: ['-e', 'console.log(1)'] }, makeContext(root));
		assert.equal(result.isError, true);
		assert.ok(/agent.allowCommands/.test(result.content), 'it must name the setting that enables it');
	});
});

test('run_command is not even offered to the model when commands are off', () => {
	const withoutCommands = agentToolDefinitions(false).map(tool => tool.name);
	const withCommands = agentToolDefinitions(true).map(tool => tool.name);
	assert.ok(!withoutCommands.includes('run_command'), 'a disabled tool must not be advertised');
	assert.ok(withCommands.includes('run_command'));
});

test('run_command runs with no shell, so metacharacters are literal arguments', async () => {
	await withWorkspace(async root => {
		const context = makeContext(root, { allowCommands: true });
		// if this went through a shell, the `;` would start a second command
		const result = await runAgentTool('run_command', {
			command: process.execPath,
			args: ['-e', 'process.stdout.write(process.argv[1] ?? "none")', '; echo pwned']
		}, context);
		assert.equal(result.isError, false);
		assert.ok(/; echo pwned/.test(result.content), 'the metacharacters arrive as one literal argument');
		assert.ok(!/pwned\n/.test(result.content.replace('; echo pwned', '')), 'no second command ran');
	});
});

test('run_command reports a non-zero exit as information, not a tool failure', async () => {
	await withWorkspace(async root => {
		const context = makeContext(root, { allowCommands: true });
		const result = await runAgentTool('run_command', { command: process.execPath, args: ['-e', 'process.exit(3)'] }, context);
		// the model needs to see the failure to react to it, so this is not an error result
		assert.equal(result.isError, false);
		assert.ok(/exit code: 3/.test(result.content));
	});
});

// ---- schemas and validation

test('every tool schema is strict and closed, as forced tool choice is unavailable', () => {
	for (const tool of agentToolDefinitions(true)) {
		assert.equal(tool.strict, true, `${tool.name} must be strict`);
		assert.equal(tool.input_schema.additionalProperties, false, `${tool.name} must close its schema`);
		assert.ok(Array.isArray(tool.input_schema.required) && tool.input_schema.required.length > 0,
			`${tool.name} must mark its arguments required`);
	}
});

test('tools with large string inputs stream eagerly', () => {
	const byName = new Map(agentToolDefinitions(true).map(tool => [tool.name, tool]));
	// file contents can be long; a boolean or a short pattern cannot
	assert.equal((byName.get('write_file') as { eager_input_streaming?: boolean }).eager_input_streaming, true);
	assert.equal((byName.get('edit_file') as { eager_input_streaming?: boolean }).eager_input_streaming, true);
});

test('a malformed or truncated tool input is rejected, never acted on', async () => {
	await withWorkspace(async root => {
		const context = makeContext(root);
		// what a truncated eager stream can look like: missing fields, wrong types
		assert.equal((await runAgentTool('read_file', {}, context)).isError, true);
		assert.equal((await runAgentTool('write_file', { path: 'a.ts' }, context)).isError, true);
		assert.equal((await runAgentTool('edit_file', { path: 'a.ts', old_text: 'x' }, context)).isError, true);
		assert.equal((await runAgentTool('read_file', { path: 42 }, context)).isError, true);
		assert.equal((await runAgentTool('search_files', {}, context)).isError, true);
		assert.equal((await runAgentTool('nope', {}, context)).isError, true);
	});
});

test('an unexpected failure becomes an error result, never a thrown exception', async () => {
	await withWorkspace(async root => {
		// the file is gone: the underlying fs call throws, and the tool must absorb it
		const result = await runAgentTool('read_file', { path: 'missing.ts' }, makeContext(root));
		assert.equal(result.isError, true);
		assert.ok(result.summary.length > 0);
	});
});

// ---- the chat view's one-line descriptions

test('describeToolCall gives a readable line for each tool', () => {
	assert.equal(describeToolCall('read_file', { path: 'a.ts' }), 'Reading a.ts');
	assert.equal(describeToolCall('edit_file', { path: 'a.ts' }), 'Editing a.ts');
	assert.equal(describeToolCall('search_files', { pattern: 'TODO' }), 'Searching for "TODO"');
	assert.equal(describeToolCall('run_command', { command: 'npm', args: ['test'] }), 'Running npm test');
	// a truncated input must not produce "undefined" in the UI
	assert.equal(describeToolCall('read_file', {}), 'Reading a file');
	assert.equal(describeToolCall('read_file', undefined), 'Reading a file');
});
