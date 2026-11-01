// src/main/agent/agentTools.ts — the tools the coding agent can call, and the guard that makes
// them safe to hand to a model.
//
// A tool input is UNTRUSTED MODEL OUTPUT. Schema validation says the shape is right; it says
// nothing about whether `path` points outside the project. `confinePath` is the gate every
// file tool passes through, and it is the most important function in this feature.
//
// Design notes:
//   - no shell anywhere: `run_command` uses execFile with an argument array, so there is no
//     string for the model to inject into;
//   - every tool has a hard output cap, because a tool result goes straight into the context
//     window and a 50MB file would blow the turn;
//   - `edit_file` replaces an EXACT unique string rather than taking a line range: a stale line
//     number silently edits the wrong code, while a non-unique or missing string fails loudly.
//
// shortcut: `run_command` is gated on one setting rather than a per-call approval prompt.
// Upgrade to per-call approval (the model proposes, the user clicks) when the agent is used on
// code the user does not fully trust.

import { execFile } from 'node:child_process';
import { readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/** tool results are context: these caps keep one call from filling the window */
const MAX_READ_BYTES = 256 * 1024;
const MAX_COMMAND_OUTPUT = 32 * 1024;
const MAX_DIRECTORY_ENTRIES = 500;
const COMMAND_TIMEOUT_MS = 120_000;

/** directories the agent never walks into when listing */
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '.test-out']);

export interface IConfinedPath {
	readonly ok: true;
	readonly absolutePath: string;
}

export interface IPathError {
	readonly ok: false;
	readonly reason: string;
}

/**
 * Resolve a model-supplied path and prove it stays inside `root`.
 *
 * Rejects absolute paths, `..` escapes, and — after `realpath` — symlinks that point out of the
 * tree. The lexical check alone is not enough: `root/link` can be a symlink to `/etc`, and
 * `path.relative` would happily call that an inside path.
 *
 * `realpath` fails for a file that does not exist yet (a new file the agent is creating), so in
 * that case the PARENT directory is canonicalized instead and the leaf name is checked for
 * separators. That keeps creation working without opening a hole.
 */
export async function confinePath(root: string, candidate: string): Promise<IConfinedPath | IPathError> {
	if (typeof candidate !== 'string' || candidate.length === 0) {
		return { ok: false, reason: 'path must be a non-empty string' };
	}
	if (candidate.includes('\0')) {
		return { ok: false, reason: 'path contains a null byte' };
	}
	if (path.isAbsolute(candidate)) {
		return { ok: false, reason: 'path must be relative to the workspace folder' };
	}

	let canonicalRoot: string;
	try {
		canonicalRoot = await realpath(path.resolve(root));
	} catch {
		return { ok: false, reason: 'the workspace folder could not be resolved' };
	}

	const target = path.resolve(canonicalRoot, candidate);

	// lexical check first: it is cheap and catches the common `../../etc/passwd`
	if (!isInside(canonicalRoot, target)) {
		return { ok: false, reason: 'path escapes the workspace folder' };
	}

	// then the real check, which catches symlinks
	try {
		const canonicalTarget = await realpath(target);
		return isInside(canonicalRoot, canonicalTarget)
			? { ok: true, absolutePath: canonicalTarget }
			: { ok: false, reason: 'path resolves outside the workspace folder (symlink)' };
	} catch {
		// the file does not exist yet — canonicalize the parent instead
		const parent = path.dirname(target);
		const leaf = path.basename(target);
		if (!leaf || leaf === '.' || leaf === '..' || leaf.includes('/') || leaf.includes('\\')) {
			return { ok: false, reason: 'path does not name a file' };
		}
		try {
			const canonicalParent = await realpath(parent);
			return isInside(canonicalRoot, canonicalParent)
				? { ok: true, absolutePath: path.join(canonicalParent, leaf) }
				: { ok: false, reason: 'parent directory resolves outside the workspace folder' };
		} catch {
			return { ok: false, reason: 'parent directory does not exist' };
		}
	}
}

/** true when `target` is `root` itself or below it */
export function isInside(root: string, target: string): boolean {
	if (root === target) {
		return true;
	}
	const relative = path.relative(root, target);
	return relative.length > 0
		&& !relative.startsWith('..' + path.sep)
		&& relative !== '..'
		&& !path.isAbsolute(relative);
}

// ---- input validation (the SDK's tolerant parser can hand back a truncated object)

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export interface IToolCallResult {
	readonly content: string;
	readonly isError: boolean;
	/** a one-line description for the chat view */
	readonly summary: string;
	/** set when the call changed a file, so editors showing it can reload */
	readonly changedPath?: string;
}

function fail(summary: string, content = summary): IToolCallResult {
	return { content, isError: true, summary };
}

export interface IAgentToolContext {
	readonly workspaceRoot: string;
	readonly allowCommands: boolean;
	/** injected so the search tool reuses the editor's own engine instead of a second one */
	searchFiles(pattern: string, isRegExp: boolean): Promise<readonly { path: string; line: number; text: string }[]>;
}

/**
 * The tool definitions sent to the API.
 *
 * `strict: true` with `additionalProperties: false` keeps arguments schema-valid, which matters
 * because forced tool choice is rejected on this model — the prompt steers, the schema holds.
 * `eager_input_streaming` lets a large `content` stream as it is generated instead of arriving
 * in one burst; the server then stops validating, which is why every input is re-checked below.
 */
export function agentToolDefinitions(allowCommands: boolean) {
	const definitions = [
		{
			name: 'read_file',
			description: 'Read a UTF-8 text file from the workspace. Paths are relative to the workspace folder. Returns the file with 1-based line numbers so you can quote exact lines.',
			strict: true,
			eager_input_streaming: true,
			input_schema: {
				type: 'object' as const,
				properties: { path: { type: 'string', description: 'Path relative to the workspace folder' } },
				required: ['path'],
				additionalProperties: false
			}
		},
		{
			name: 'list_directory',
			description: 'List the files and folders directly inside a workspace directory. Use "." for the workspace root. Skips node_modules, .git and build output.',
			strict: true,
			input_schema: {
				type: 'object' as const,
				properties: { path: { type: 'string', description: 'Directory path relative to the workspace folder' } },
				required: ['path'],
				additionalProperties: false
			}
		},
		{
			name: 'search_files',
			description: 'Search the workspace for a pattern and return matching lines with their paths. Prefer this over reading many files.',
			strict: true,
			input_schema: {
				type: 'object' as const,
				properties: {
					pattern: { type: 'string', description: 'Text or regular expression to find' },
					is_regex: { type: 'boolean', description: 'Treat the pattern as a regular expression' }
				},
				required: ['pattern', 'is_regex'],
				additionalProperties: false
			}
		},
		{
			name: 'write_file',
			description: 'Create a file, or replace its entire contents. Prefer edit_file for changing part of an existing file.',
			strict: true,
			eager_input_streaming: true,
			input_schema: {
				type: 'object' as const,
				properties: {
					path: { type: 'string', description: 'Path relative to the workspace folder' },
					content: { type: 'string', description: 'The complete new contents of the file' }
				},
				required: ['path', 'content'],
				additionalProperties: false
			}
		},
		{
			name: 'edit_file',
			description: 'Replace an exact unique string in a file. old_text must appear exactly once, including indentation. This fails loudly rather than editing the wrong place.',
			strict: true,
			eager_input_streaming: true,
			input_schema: {
				type: 'object' as const,
				properties: {
					path: { type: 'string', description: 'Path relative to the workspace folder' },
					old_text: { type: 'string', description: 'The exact text to replace; must occur exactly once' },
					new_text: { type: 'string', description: 'The replacement text' }
				},
				required: ['path', 'old_text', 'new_text'],
				additionalProperties: false
			}
		}
	];

	if (allowCommands) {
		definitions.push({
			name: 'run_command',
			description: 'Run a program in the workspace folder and return its output. The command is run directly with an argument array, not through a shell.',
			strict: true,
			input_schema: {
				type: 'object' as const,
				properties: {
					command: { type: 'string', description: 'The program to run, e.g. "npm"' },
					args: { type: 'array', items: { type: 'string' }, description: 'Arguments, one per element' }
				},
				required: ['command', 'args'],
				additionalProperties: false
			}
		} as never);
	}

	return definitions;
}

/** run one tool call. Never throws: a failure becomes an error result the model can read. */
export async function runAgentTool(name: string, input: unknown, context: IAgentToolContext): Promise<IToolCallResult> {
	const args = (input ?? {}) as Record<string, unknown>;

	try {
		switch (name) {
			case 'read_file': return await readFileTool(args, context);
			case 'list_directory': return await listDirectoryTool(args, context);
			case 'search_files': return await searchFilesTool(args, context);
			case 'write_file': return await writeFileTool(args, context);
			case 'edit_file': return await editFileTool(args, context);
			case 'run_command': return await runCommandTool(args, context);
			default: return fail(`unknown tool '${name}'`);
		}
	} catch (error) {
		// a tool must never take the turn down
		return fail(`${name} failed: ${(error as Error).message}`);
	}
}

async function readFileTool(args: Record<string, unknown>, context: IAgentToolContext): Promise<IToolCallResult> {
	const requested = asString(args.path);
	if (!requested) {
		return fail('read_file needs a "path" string');
	}
	const confined = await confinePath(context.workspaceRoot, requested);
	if (!confined.ok) {
		return fail(`read_file refused: ${confined.reason}`);
	}

	const info = await stat(confined.absolutePath);
	if (info.isDirectory()) {
		return fail(`${requested} is a directory — use list_directory`);
	}
	const buffer = await readFile(confined.absolutePath);
	if (buffer.subarray(0, 8192).includes(0)) {
		return fail(`${requested} looks binary, not text`);
	}

	const truncated = buffer.length > MAX_READ_BYTES;
	const text = buffer.subarray(0, MAX_READ_BYTES).toString('utf8');
	const numbered = text.split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n');

	return {
		content: truncated ? `${numbered}\n… truncated at ${MAX_READ_BYTES} bytes …` : numbered,
		isError: false,
		summary: `read ${requested}${truncated ? ' (truncated)' : ''}`
	};
}

async function listDirectoryTool(args: Record<string, unknown>, context: IAgentToolContext): Promise<IToolCallResult> {
	const requested = asString(args.path) ?? '.';
	const confined = await confinePath(context.workspaceRoot, requested);
	if (!confined.ok) {
		return fail(`list_directory refused: ${confined.reason}`);
	}

	const entries = await readdir(confined.absolutePath, { withFileTypes: true });
	const lines: string[] = [];
	for (const entry of entries.slice(0, MAX_DIRECTORY_ENTRIES)) {
		if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
			continue;
		}
		lines.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
	}

	return {
		content: lines.length > 0 ? lines.sort().join('\n') : '(empty)',
		isError: false,
		summary: `listed ${requested} (${lines.length} entries)`
	};
}

async function searchFilesTool(args: Record<string, unknown>, context: IAgentToolContext): Promise<IToolCallResult> {
	const pattern = asString(args.pattern);
	if (!pattern) {
		return fail('search_files needs a "pattern" string');
	}
	const matches = await context.searchFiles(pattern, args.is_regex === true);
	if (matches.length === 0) {
		return { content: 'no matches', isError: false, summary: `searched for "${pattern}" — no matches` };
	}
	const content = matches.map(match => `${match.path}:${match.line}: ${match.text}`).join('\n');
	return {
		content,
		isError: false,
		summary: `searched for "${pattern}" — ${matches.length} match${matches.length === 1 ? '' : 'es'}`
	};
}

async function writeFileTool(args: Record<string, unknown>, context: IAgentToolContext): Promise<IToolCallResult> {
	const requested = asString(args.path);
	const content = typeof args.content === 'string' ? args.content : undefined;
	if (!requested || content === undefined) {
		return fail('write_file needs "path" and "content" strings');
	}
	const confined = await confinePath(context.workspaceRoot, requested);
	if (!confined.ok) {
		return fail(`write_file refused: ${confined.reason}`);
	}

	await writeFile(confined.absolutePath, content, 'utf8');
	const lineCount = content.split('\n').length;
	return {
		content: `wrote ${requested} (${lineCount} lines)`,
		isError: false,
		summary: `wrote ${requested}`,
		changedPath: confined.absolutePath
	};
}

async function editFileTool(args: Record<string, unknown>, context: IAgentToolContext): Promise<IToolCallResult> {
	const requested = asString(args.path);
	const oldText = typeof args.old_text === 'string' ? args.old_text : undefined;
	const newText = typeof args.new_text === 'string' ? args.new_text : undefined;
	if (!requested || !oldText || newText === undefined) {
		return fail('edit_file needs "path", "old_text" and "new_text"');
	}
	const confined = await confinePath(context.workspaceRoot, requested);
	if (!confined.ok) {
		return fail(`edit_file refused: ${confined.reason}`);
	}

	const original = await readFile(confined.absolutePath, 'utf8');
	const occurrences = countOccurrences(original, oldText);
	if (occurrences === 0) {
		return fail(`edit_file found no match in ${requested}`, `old_text does not appear in ${requested}. Read the file again and quote it exactly, including indentation.`);
	}
	if (occurrences > 1) {
		return fail(`edit_file found ${occurrences} matches in ${requested}`, `old_text appears ${occurrences} times in ${requested}. Include more surrounding lines so it is unique.`);
	}

	await writeFile(confined.absolutePath, original.replace(oldText, newText), 'utf8');
	return {
		content: `edited ${requested}`,
		isError: false,
		summary: `edited ${requested}`,
		changedPath: confined.absolutePath
	};
}

/** plain count, no regex: `old_text` is literal text and may contain regex metacharacters */
export function countOccurrences(haystack: string, needle: string): number {
	if (!needle) {
		return 0;
	}
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

async function runCommandTool(args: Record<string, unknown>, context: IAgentToolContext): Promise<IToolCallResult> {
	if (!context.allowCommands) {
		return fail('running commands is turned off', `Running commands is disabled. The user can enable it with the "${'agent.allowCommands'}" setting.`);
	}
	const command = asString(args.command);
	if (!command) {
		return fail('run_command needs a "command" string');
	}
	const rawArgs = Array.isArray(args.args) ? args.args : [];
	if (!rawArgs.every(entry => typeof entry === 'string')) {
		return fail('run_command "args" must be an array of strings');
	}

	const result = await new Promise<{ stdout: string; stderr: string; code: number }>(resolve => {
		// execFile with an argument array: no shell, so nothing to inject into
		execFile(command, rawArgs as string[], {
			cwd: context.workspaceRoot,
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: MAX_COMMAND_OUTPUT * 4
		}, (error, stdout, stderr) => {
			const code = error && typeof (error as { code?: unknown }).code === 'number'
				? (error as unknown as { code: number }).code
				: error ? 1 : 0;
			resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
		});
	});

	const clip = (value: string): string => value.length > MAX_COMMAND_OUTPUT
		? `${value.slice(0, MAX_COMMAND_OUTPUT)}\n… output truncated …`
		: value;

	const parts = [`exit code: ${result.code}`];
	if (result.stdout.trim()) {
		parts.push(`stdout:\n${clip(result.stdout)}`);
	}
	if (result.stderr.trim()) {
		parts.push(`stderr:\n${clip(result.stderr)}`);
	}

	return {
		content: parts.join('\n\n'),
		isError: false, // a non-zero exit is information for the model, not a tool failure
		summary: `ran ${command} ${(rawArgs as string[]).join(' ')} → exit ${result.code}`
	};
}
