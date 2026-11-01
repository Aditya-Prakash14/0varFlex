// src/renderer/workbench/contrib/tasks/browser/taskService.ts — the task system, ported in
// subset from vs/workbench/contrib/tasks/browser/abstractTaskService.ts:
//
//   - discovery from two sources (`.0varflex/tasks.json` and auto-detected npm scripts),
//     re-read on demand so editing tasks.json does not need a reload;
//   - execution through 13's pty host, spawning the command DIRECTLY (not via a shell) so the
//     exit code belongs to the task. No terminal UI is created — the output goes to the task
//     pane, which is why the terminal service needed a raw data event;
//   - output is captured and fed to a problem matcher whose results land in 12's marker service
//     under the owner `task`, so they appear in Problems AND as squiggles for free;
//   - re-running a task that is still alive offers the real three-way choice.
//
// delta: no dependsOn, no background/watch matchers, no `inputs` prompts, no user-level tasks,
// no detection beyond npm.
//
// shortcut: one running task at a time. The real system keeps a map of active executions keyed
// by task identity; with one output pane that would need tabs first.

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { Disposable } from '../../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../../common/base/common/uri.js';
import type { IFileService } from '../../../../../common/platform/files/common/files.js';
import type { ILogService } from '../../../../../common/platform/log/common/log.js';
import { MINI_WORKSPACE_FOLDER } from '../../../../../common/platform/workspace/common/workspace.js';
import {
	expandTask,
	ITask,
	matchProblems,
	npmTasksFromPackageJson,
	parseTasksJson,
	sortTasks,
	TASKS_FILE,
	TaskGroup,
	taskForGroup
} from '../../../../../common/platform/tasks/common/tasks.js';
import { MarkerSeverity } from '../../../services/markers/browser/markerService.js';
import type { IMarkerData } from '../../../services/markers/browser/markerService.js';
import type { MarkerService } from '../../../services/markers/browser/markerService.js';
import type { TerminalService } from '../../terminal/browser/terminalService.js';

/** the owner the task problems are published under (the real one uses the matcher's owner) */
export const TASK_MARKER_OWNER = 'task';

/** the most output a task keeps; a watch task would otherwise grow without bound */
export const MAX_OUTPUT_CHARS = 200_000;

export type TaskRunState = 'idle' | 'running' | 'exited';

export interface ITaskExecution {
	readonly task: ITask;
	readonly processId: number;
	exitCode: number | undefined;
}

export interface ITaskServiceOptions {
	readonly terminalService: TerminalService;
	readonly fileService: IFileService;
	readonly markers: MarkerService;
	readonly logService: ILogService;
	getWorkspaceFolder(): URI | undefined;
	getActiveFile(): URI | undefined;
	/**
	 * Asked before the first task runs in a folder. Tasks are defined by files INSIDE the folder
	 * (`.0varflex/tasks.json`, `package.json` scripts), so opening someone else's repository and
	 * pressing Ctrl+Shift+B would otherwise run their command with no warning. The real VS Code
	 * added Workspace Trust for exactly this. The answer is remembered per folder by the caller.
	 */
	isTrusted(folder: URI): Promise<boolean>;
}

export class TaskService extends Disposable {

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState: Event<void> = this._onDidChangeState.event;

	private readonly _onDidWriteOutput = this._register(new Emitter<string>());
	readonly onDidWriteOutput: Event<string> = this._onDidWriteOutput.event;

	private _execution: ITaskExecution | undefined;
	private _output = '';
	/** a trailing, incomplete escape sequence waiting for the rest of its bytes */
	private _pendingEscape = '';
	private _state: TaskRunState = 'idle';

	constructor(private readonly _options: ITaskServiceOptions) {
		super();

		this._register(this._options.terminalService.onProcessData(event => {
			if (this._execution && event.id === this._execution.processId) {
				this._appendOutput(event.data);
			}
		}));

		this._register(this._options.terminalService.onProcessExit(event => {
			if (this._execution && event.id === this._execution.processId) {
				this._onExit(event.exitCode);
			}
		}));
	}

	get state(): TaskRunState { return this._state; }
	get execution(): ITaskExecution | undefined { return this._execution; }
	get output(): string { return this._output; }
	get runningTask(): ITask | undefined { return this._state === 'running' ? this._execution?.task : undefined; }

	// ---- discovery

	/** read both sources; errors are logged and the other source still contributes */
	async discoverTasks(): Promise<ITask[]> {
		const folder = this._options.getWorkspaceFolder();
		if (!folder) {
			return [];
		}

		const tasks: ITask[] = [];

		// workspace tasks
		const tasksUri = URI.joinPath(folder, MINI_WORKSPACE_FOLDER, TASKS_FILE);
		try {
			const contents = await this._options.fileService.readFile(tasksUri);
			const parsed = parseTasksJson(contents);
			tasks.push(...parsed.tasks);
			for (const error of parsed.errors) {
				this._options.logService.warn(`tasks: ${error.message}`);
			}
		} catch {
			// no tasks.json is the normal case, not an error
		}

		// npm scripts
		const packageUri = URI.joinPath(folder, 'package.json');
		try {
			const contents = await this._options.fileService.readFile(packageUri);
			const parsed = npmTasksFromPackageJson(contents);
			tasks.push(...parsed.tasks);
			for (const error of parsed.errors) {
				this._options.logService.warn(`tasks: ${error.message}`);
			}
		} catch {
			// no package.json: nothing to detect
		}

		return sortTasks(tasks);
	}

	async taskForGroup(group: TaskGroup): Promise<ITask | undefined> {
		return taskForGroup(await this.discoverTasks(), group);
	}

	// ---- execution

	/**
	 * Run a task. Returns false when nothing was started.
	 *
	 * `onBusy` is the real "task already running" prompt: Terminate / Restart / Reuse. The caller
	 * supplies it because the choice is UX, not task logic.
	 */
	async runTask(task: ITask, onBusy?: () => Promise<'terminate' | 'restart' | 'cancel'>): Promise<boolean> {
		if (this._state === 'running') {
			const choice = onBusy ? await onBusy() : 'cancel';
			if (choice === 'cancel') {
				return false;
			}
			await this.terminate();
			if (choice === 'terminate') {
				return false;
			}
		}

		const folder = this._options.getWorkspaceFolder();
		// the trust gate lives here, not in the commands, so the output pane's Restart button
		// cannot route around it
		if (folder && !await this._options.isTrusted(folder)) {
			return false;
		}
		const expanded = expandTask(task, {
			workspaceFolder: folder?.fsPath,
			file: this._options.getActiveFile()?.fsPath
		});

		// a fresh run owns the problem list: stale markers from the previous run must not linger
		this._options.markers.removeOwner(TASK_MARKER_OWNER);
		this._output = '';
		this._pendingEscape = '';
		this._state = 'running';
		this._writeHeader(expanded);

		try {
			// 80x24 is a sane fixed size: nothing renders this pty, we only read its bytes
			const result = await this._options.terminalService.createProcess(80, 24, {
				shell: expanded.command,
				shellArgs: expanded.args,
				cwd: expanded.cwd ?? folder?.fsPath
			});
			this._execution = { task: expanded, processId: result.id, exitCode: undefined };
			await this._options.terminalService.start(result.id);
		} catch (error) {
			this._state = 'exited';
			this._execution = undefined;
			this._appendOutput(`\r\nfailed to start: ${(error as Error).message}\r\n`);
			this._onDidChangeState.fire();
			return false;
		}

		this._onDidChangeState.fire();
		return true;
	}

	async terminate(): Promise<void> {
		const execution = this._execution;
		if (!execution) {
			return;
		}
		await this._options.terminalService.shutdown(execution.processId);
		// the exit event may never arrive for a killed pty: settle the state here too
		if (this._state === 'running') {
			this._onExit(undefined);
		}
	}

	async rerun(onBusy?: () => Promise<'terminate' | 'restart' | 'cancel'>): Promise<boolean> {
		const task = this._execution?.task;
		return task ? this.runTask(task, onBusy) : false;
	}

	clearOutput(): void {
		this._output = '';
		this._onDidChangeState.fire();
	}

	// ---- internals

	private _writeHeader(task: ITask): void {
		const command = [task.command, ...task.args].join(' ');
		this._appendOutput(`> Executing task: ${task.label} <\r\n> ${command}\r\n\r\n`);
	}

	private _appendOutput(data: string): void {
		// Strip once, on arrival, instead of on every repaint: the pane used to re-scan the
		// whole buffer every 50ms while output streamed.
		const { text, pending } = stripAnsiStreaming(this._pendingEscape, data);
		this._pendingEscape = pending;
		this._output += text;
		// A watch task runs for hours; without this the service holds every byte it ever printed
		// and the problem matcher re-scans all of it on each exit.
		if (this._output.length > MAX_OUTPUT_CHARS) {
			this._output = this._output.slice(this._output.length - MAX_OUTPUT_CHARS);
		}
		this._onDidWriteOutput.fire(text);
	}

	private _onExit(exitCode: number | undefined): void {
		// terminate() settles the state itself (a killed pty may never report an exit), so the
		// real exit event can arrive afterwards for the same process. Without this guard the
		// exit line is written twice and the problem matcher runs twice, the second pass
		// republishing markers that were just cleared.
		if (this._state === 'exited') {
			return;
		}
		if (this._execution) {
			this._execution.exitCode = exitCode;
		}
		this._state = 'exited';

		// the real terminal says this and keeps the pane open rather than closing it
		this._appendOutput(
			`\r\n> The task ${exitCode === 0 ? 'completed successfully' : `exited with code ${exitCode ?? 'unknown'}`}. `
			+ 'The task will not be restarted automatically.\r\n'
		);

		this._publishProblems();
		this._onDidChangeState.fire();
	}

	/** run the matcher over everything captured and hand the results to the marker service */
	private _publishProblems(): void {
		const task = this._execution?.task;
		const matcher = task?.problemMatcher;
		if (!task || !matcher) {
			return;
		}

		const folder = this._options.getWorkspaceFolder();
		const problems = matchProblems(this._output, matcher);

		// group by file: changeOne replaces a whole (owner, resource) tuple
		const byResource = new Map<string, { resource: URI; markers: IMarkerData[] }>();
		for (const problem of problems) {
			// a relative path is relative to the workspace folder, as the real matchers assume
			const resource = /^([a-zA-Z]:[\\/]|[\\/])/.test(problem.path) || !folder
				? URI.file(problem.path)
				: URI.joinPath(folder, problem.path);
			const key = resource.toString();
			const entry = byResource.get(key) ?? { resource, markers: [] };
			entry.markers.push({
				range: {
					startLineNumber: problem.line,
					startColumn: problem.column,
					endLineNumber: problem.line,
					// the matcher has no end column: mark to the end of the line, like the real one
					endColumn: Number.MAX_SAFE_INTEGER
				},
				message: problem.message,
				severity: problem.severity === 'warning'
					? MarkerSeverity.Warning
					: problem.severity === 'info' ? MarkerSeverity.Info : MarkerSeverity.Error
			});
			byResource.set(key, entry);
		}

		this._options.markers.changeAll(TASK_MARKER_OWNER, [...byResource.values()]);
		if (problems.length > 0) {
			this._appendOutput(`> ${problems.length} problem${problems.length === 1 ? '' : 's'} reported.\r\n`);
		}
	}
}

/**
 * Drop ANSI escape sequences. A pty colours its output, and a greedy `(.*)` in a problem pattern
 * swallows `\x1b[31m` INTO the captured path, so the matcher would report a problem against a
 * file that does not exist.
 */
export function stripAnsi(value: string): string {
	// eslint-disable-next-line no-control-regex
	return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
}

/** the longest escape tail we hold back; past this a lone ESC is treated as ordinary data */
const MAX_PENDING_ESCAPE = 32;

/**
 * Strip escapes from a STREAM, one chunk at a time.
 *
 * A pty can split `\x1b[31m` across two chunks, and stripping each chunk on its own would leave
 * `[31m` behind as visible garbage. Any trailing, not-yet-terminated escape is held back in
 * `pending` and prepended to the next chunk. The cap stops a lone ESC in binary output from
 * stalling the stream forever.
 */
export function stripAnsiStreaming(pending: string, chunk: string): { text: string; pending: string } {
	const combined = pending + chunk;
	// eslint-disable-next-line no-control-regex
	const lastEscape = combined.lastIndexOf('\x1b');

	if (lastEscape >= 0) {
		const tail = combined.slice(lastEscape);
		// a CSI ends with a letter; an OSC ends with BEL or ST; any other escape is 2 bytes
		const terminated = /^\x1b\[[0-9;]*[A-Za-z]/.test(tail)
			|| /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.test(tail)
			|| (!tail.startsWith('\x1b[') && !tail.startsWith('\x1b]') && tail.length >= 2);
		if (!terminated && tail.length <= MAX_PENDING_ESCAPE) {
			return { text: stripAnsi(combined.slice(0, lastEscape)), pending: tail };
		}
	}

	return { text: stripAnsi(combined), pending: '' };
}
