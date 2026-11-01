// src/renderer/workbench/contrib/tasks/browser/taskActions.ts — the Task commands with the REAL
// ids and bindings, read from vs/workbench/contrib/tasks/browser/task.contribution.ts:
//
//   workbench.action.tasks.runTask                   — the "Select a task" quick pick
//   workbench.action.tasks.build        cmd/ctrl+shift+b
//   workbench.action.tasks.test
//   workbench.action.tasks.terminate
//   workbench.action.tasks.restartTask
//   workbench.action.tasks.showTasks                 — reveal the output pane
//
// The picker groups by source with a description, the way taskQuickPick.ts does, and the
// already-running prompt offers the real three-way choice.

import { IDisposable, toDisposable } from '../../../../../common/base/common/lifecycle.js';
import { CommandMetadata, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { KeyCode, KeyMod } from '../../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import type { QuickInputController } from '../../../../platform/quickinput/browser/quickInput.js';
import { fuzzyScore } from '../../../../platform/quickinput/browser/commandsQuickAccess.js';
import type { ITask, TaskGroup } from '../../../../../common/platform/tasks/common/tasks.js';
import type { TaskService } from './taskService.js';
import type { TaskPanel } from './taskPanel.js';

export const RUN_TASK_ID = 'workbench.action.tasks.runTask';
export const BUILD_TASK_ID = 'workbench.action.tasks.build';
export const TEST_TASK_ID = 'workbench.action.tasks.test';
export const TERMINATE_TASK_ID = 'workbench.action.tasks.terminate';
export const RESTART_TASK_ID = 'workbench.action.tasks.restartTask';
export const SHOW_TASKS_ID = 'workbench.action.tasks.showTasks';

export interface ITaskActionServices {
	readonly taskService: TaskService;
	readonly quickInput: QuickInputController;
	getPanel(): TaskPanel;
	notify(message: string, severity?: 'info' | 'warning' | 'error'): void;
}

export function registerTaskActions(services: ITaskActionServices): IDisposable {
	const disposables: IDisposable[] = [];
	const { taskService, quickInput } = services;

	const register = (id: string, title: string, handler: () => unknown): void => {
		disposables.push(CommandsRegistry.registerCommand(id, () => handler()));
		disposables.push(CommandMetadata.register({ id, title, category: 'Tasks' }));
	};

	/** the real prompt when a task is already running */
	const onBusy = async (): Promise<'terminate' | 'restart' | 'cancel'> => {
		const choice = await quickInput.pick<{ id: 'terminate' | 'restart' | 'cancel'; label: string; detail: string }>({
			placeholder: 'A task is already running',
			items: () => [
				{ id: 'restart', label: 'Restart Task', detail: 'Terminate the running task and start it again' },
				{ id: 'terminate', label: 'Terminate Task', detail: 'Stop the running task' },
				{ id: 'cancel', label: 'Cancel', detail: 'Leave the running task alone' }
			],
			label: item => item.label,
			description: item => item.detail
		});
		return choice?.id ?? 'cancel';
	};

	const runWithPrompt = async (task: ITask): Promise<void> => {
		const started = await taskService.runTask(task, onBusy);
		if (started) {
			services.getPanel().show();
		}
	};

	const runGroup = async (group: TaskGroup, label: string): Promise<void> => {
		const task = await taskService.taskForGroup(group);
		if (!task) {
			services.notify(`No ${label} task found. Add one to .0varflex/tasks.json or a "${label}" script to package.json.`, 'warning');
			return;
		}
		await runWithPrompt(task);
	};

	register(RUN_TASK_ID, 'Run Task', async () => {
		const tasks = await taskService.discoverTasks();
		if (tasks.length === 0) {
			services.notify('No tasks found. Add .0varflex/tasks.json or npm scripts to package.json.', 'warning');
			return;
		}

		const picked = await quickInput.pick<ITask>({
			placeholder: 'Select a task to run',
			items: value => {
				if (!value) {
					return tasks;
				}
				// reuse 04's scorer rather than inventing a second one
				return tasks
					.map(task => ({ task, score: fuzzyScore(task.label, value) }))
					.filter((entry): entry is { task: ITask; score: number } => entry.score !== undefined)
					.sort((a, b) => b.score - a.score)
					.map(entry => entry.task);
			},
			label: task => task.label,
			// the source is the grouping signal the real picker shows
			description: task => task.group !== 'none' ? `${task.source} · ${task.group}` : task.source
		});

		if (picked) {
			await runWithPrompt(picked);
		}
	});

	register(BUILD_TASK_ID, 'Run Build Task', () => runGroup('build', 'build'));
	register(TEST_TASK_ID, 'Run Test Task', () => runGroup('test', 'test'));
	register(TERMINATE_TASK_ID, 'Terminate Task', () => taskService.terminate());
	register(RESTART_TASK_ID, 'Restart Task', async () => {
		const restarted = await taskService.rerun(onBusy);
		if (restarted) {
			services.getPanel().show();
		} else {
			services.notify('No task to restart.', 'warning');
		}
	});
	register(SHOW_TASKS_ID, 'Show Task Output', () => services.getPanel().show());

	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: BUILD_TASK_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyB
	}));

	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
