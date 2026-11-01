// src/common/platform/tasks/common/tasks.ts — the task model, ported in subset from
// vs/workbench/contrib/tasks/common/tasks.ts:
//
//   - a Task has a label, a source (where it came from), a command + args, an optional GROUP
//     (`build`/`test`, which is what gives Cmd+Shift+B and "Run Test Task" something to pick),
//     and an optional problem matcher;
//   - two sources: `.0varflex/tasks.json` in the workspace, and npm scripts auto-detected from
//     package.json — the detection people actually use every day;
//   - `${workspaceFolder}` / `${file}` expansion, the tiny subset of the real variable story;
//   - a problem matcher is one regex plus which capture group is the file/line/column/message.
//
// Everything here is PURE, so discovery, expansion and matching are unit tested without a pty.
//
// delta: the real model has dependsOn/dependsOrder, background (watch) matchers with
// begin/end patterns, `inputs` prompts, user-level tasks, presentation options, and detection
// for gulp/grunt/jake/typescript. None of that is here.
// delta: the workspace file is `.0varflex/tasks.json`, not `.vscode/tasks.json`, so this app
// never reads a real VS Code workspace's configuration (the same choice workspace.ts made).

export const TASKS_FILE = 'tasks.json';

export type TaskGroup = 'build' | 'test' | 'none';
export type TaskSource = 'workspace' | 'npm';

export interface IProblemMatcher {
	/** a regex source string, applied per output line */
	readonly pattern: string;
	/** 1-based capture group indices */
	readonly file: number;
	readonly line: number;
	readonly column?: number;
	readonly message: number;
	readonly severity?: 'error' | 'warning' | 'info';
}

export interface ITask {
	readonly label: string;
	readonly source: TaskSource;
	readonly command: string;
	readonly args: readonly string[];
	readonly group: TaskGroup;
	readonly cwd?: string;
	readonly problemMatcher?: IProblemMatcher;
}

export interface ITaskParseError {
	readonly message: string;
}

// ---- variables

/**
 * Expand the supported variables. Unknown `${...}` tokens are left ALONE rather than replaced
 * with an empty string: silently blanking a variable turns `rm -rf ${unknown}/x` into something
 * much worse than a visible failure.
 */
export function expandVariables(value: string, context: { workspaceFolder?: string; file?: string }): string {
	return value.replace(/\$\{(\w+)\}/g, (match, name: string) => {
		if (name === 'workspaceFolder' && context.workspaceFolder !== undefined) {
			return context.workspaceFolder;
		}
		if (name === 'file' && context.file !== undefined) {
			return context.file;
		}
		return match;
	});
}

export function expandTask(task: ITask, context: { workspaceFolder?: string; file?: string }): ITask {
	return {
		...task,
		command: expandVariables(task.command, context),
		args: task.args.map(arg => expandVariables(arg, context)),
		cwd: task.cwd === undefined ? undefined : expandVariables(task.cwd, context)
	};
}

// ---- npm detection

/**
 * The group heuristic the real npm provider uses: scripts named build/compile/watch are the
 * build group, `test` is the test group. That is what makes Cmd+Shift+B work without any
 * configuration at all.
 */
export function npmScriptGroup(scriptName: string): TaskGroup {
	const name = scriptName.toLowerCase();
	if (name === 'build' || name === 'compile' || name === 'watch') {
		return 'build';
	}
	if (name === 'test') {
		return 'test';
	}
	return 'none';
}

/** parse package.json's `scripts` into tasks labelled `npm: <script>`, like the real provider */
export function npmTasksFromPackageJson(contents: string): { tasks: ITask[]; errors: ITaskParseError[] } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch (error) {
		return { tasks: [], errors: [{ message: `package.json is not valid JSON: ${(error as Error).message}` }] };
	}

	const scripts = (parsed as { scripts?: unknown })?.scripts;
	if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
		return { tasks: [], errors: [] }; // no scripts is normal, not an error
	}

	const tasks: ITask[] = [];
	for (const [name, command] of Object.entries(scripts as { [key: string]: unknown })) {
		if (typeof command !== 'string' || !name) {
			continue;
		}
		tasks.push({
			label: `npm: ${name}`,
			source: 'npm',
			command: 'npm',
			// `run` works for every script name, including `start` and `test`, and avoids the
			// shorthand's argument-forwarding quirks
			args: ['run', name],
			group: npmScriptGroup(name)
		});
	}
	return { tasks, errors: [] };
}

// ---- tasks.json

function readMatcher(raw: unknown): IProblemMatcher | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const candidate = raw as { pattern?: unknown; file?: unknown; line?: unknown; column?: unknown; message?: unknown; severity?: unknown };
	if (typeof candidate.pattern !== 'string' || typeof candidate.file !== 'number'
		|| typeof candidate.line !== 'number' || typeof candidate.message !== 'number') {
		return undefined;
	}
	// a bad regex must be rejected here, not at the first line of output
	try {
		new RegExp(candidate.pattern);
	} catch {
		return undefined;
	}
	const severity = candidate.severity;
	return {
		pattern: candidate.pattern,
		file: candidate.file,
		line: candidate.line,
		column: typeof candidate.column === 'number' ? candidate.column : undefined,
		message: candidate.message,
		severity: severity === 'warning' || severity === 'info' || severity === 'error' ? severity : undefined
	};
}

/**
 * Parse `.0varflex/tasks.json`. Malformed entries are reported and skipped rather than failing
 * the whole file: one bad task should not hide the others.
 */
export function parseTasksJson(contents: string): { tasks: ITask[]; errors: ITaskParseError[] } {
	const errors: ITaskParseError[] = [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch (error) {
		return { tasks: [], errors: [{ message: `tasks.json is not valid JSON: ${(error as Error).message}` }] };
	}

	const rawTasks = (parsed as { tasks?: unknown })?.tasks;
	if (!Array.isArray(rawTasks)) {
		return { tasks: [], errors: [{ message: 'tasks.json needs a "tasks" array' }] };
	}

	const tasks: ITask[] = [];
	for (const raw of rawTasks) {
		const candidate = raw as { label?: unknown; command?: unknown; args?: unknown; group?: unknown; cwd?: unknown; problemMatcher?: unknown };
		if (!candidate || typeof candidate.label !== 'string' || !candidate.label) {
			errors.push({ message: 'a task needs a string "label"' });
			continue;
		}
		if (typeof candidate.command !== 'string' || !candidate.command) {
			errors.push({ message: `task '${candidate.label}' needs a string "command"` });
			continue;
		}
		const args = Array.isArray(candidate.args)
			? candidate.args.filter((arg): arg is string => typeof arg === 'string')
			: [];
		const group: TaskGroup = candidate.group === 'build' || candidate.group === 'test' ? candidate.group : 'none';

		tasks.push({
			label: candidate.label,
			source: 'workspace',
			command: candidate.command,
			args,
			group,
			cwd: typeof candidate.cwd === 'string' ? candidate.cwd : undefined,
			problemMatcher: readMatcher(candidate.problemMatcher)
		});
	}

	return { tasks, errors };
}

// ---- the problem matcher

export interface ITaskProblem {
	readonly path: string;
	readonly line: number;
	readonly column: number;
	readonly message: string;
	readonly severity: 'error' | 'warning' | 'info';
}

/**
 * Apply a matcher to captured output, one line at a time (the real matchers are line-based too).
 *
 * Lines that do not match are not problems — most build output is noise. A match with an
 * unparseable line number is skipped rather than reported at line 0, which would put a squiggle
 * in the wrong place.
 */
export function matchProblems(output: string, matcher: IProblemMatcher): ITaskProblem[] {
	let regexp: RegExp;
	try {
		regexp = new RegExp(matcher.pattern);
	} catch {
		return [];
	}

	const problems: ITaskProblem[] = [];
	for (const rawLine of output.split('\n')) {
		const line = rawLine.replace(/\r$/, '');
		if (!line) {
			continue;
		}
		const match = regexp.exec(line);
		if (!match) {
			continue;
		}

		const path = match[matcher.file];
		const lineNumber = Number(match[matcher.line]);
		const column = matcher.column !== undefined ? Number(match[matcher.column]) : 1;
		const message = match[matcher.message];

		if (!path || !message || !Number.isFinite(lineNumber) || lineNumber < 1) {
			continue;
		}

		problems.push({
			path,
			line: Math.floor(lineNumber),
			column: Number.isFinite(column) && column >= 1 ? Math.floor(column) : 1,
			message,
			severity: matcher.severity ?? 'error'
		});
	}
	return problems;
}

/** the task to run for a group: the real picker prefers an exact group match */
export function taskForGroup(tasks: readonly ITask[], group: TaskGroup): ITask | undefined {
	return tasks.find(task => task.group === group);
}

/** stable ordering for the picker: workspace tasks first, then npm, alphabetical within each */
export function sortTasks(tasks: readonly ITask[]): ITask[] {
	return [...tasks].sort((a, b) => {
		if (a.source !== b.source) {
			return a.source === 'workspace' ? -1 : 1;
		}
		return a.label.localeCompare(b.label);
	});
}
