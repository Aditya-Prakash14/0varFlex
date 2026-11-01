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
}

export class TaskService extends Disposable {

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState: Event<void> = this._onDidChangeState.event;

	private readonly _onDidWriteOutput = this._register(new Emitter<string>());
	readonly onDidWriteOutput: Event<string> = this._onDidWriteOutput.event;

	private _execution: ITaskExecution | undefined;
	private _output = '';
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
		const expanded = expandTask(task, {
			workspaceFolder: folder?.fsPath,
			file: this._options.getActiveFile()?.fsPath
		});

		// a fresh run owns the problem list: stale markers from the previous run must not linger
		this._options.markers.removeOwner(TASK_MARKER_OWNER);
		this._output = '';
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
		this._output += data;
		this._onDidWriteOutput.fire(data);
	}

	private _onExit(exitCode: number | undefined): void {
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
		const problems = matchProblems(stripAnsi(this._output), matcher);

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
 * Drop ANSI escape sequences before matching. A pty colours its output, and `\x1b[31m` in front
 * of a path breaks any regex anchored with `^`.
 */
export function stripAnsi(value: string): string {
	// eslint-disable-next-line no-control-regex
	return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
}
