// src/renderer/workbench/contrib/tasks/browser/taskPanel.ts — the Task output pane: the panel's
// second tab kind, beside the terminals.
//
// Ported in spirit from the real task terminal: the output streams live, the exit line stays on
// screen ("The task will not be restarted automatically"), and a Restart / Terminate pair sits in
// the header — the point being that a finished task's output is still readable.
//
// delta: the real system runs each task in a real terminal (with ANSI rendering, scrollback
// search and links). This is a plain text pane, so ANSI escapes are stripped rather than drawn.
//
// The output is stripped and capped by the task service as it arrives, so this pane only
// assigns text — it never scans the buffer.

import { Disposable, DisposableStore } from '../../../../../common/base/common/lifecycle.js';
import { addDisposableListener, append, $ } from '../../../../base/browser/dom.js';
import type { PanelPart } from '../../../browser/parts/panel/panelPart.js';
import { TaskService } from './taskService.js';

const TAB_GROUP_ID = 'tasks';
const RENDER_DEBOUNCE_MS = 50;

export class TaskPanel extends Disposable {

	private readonly _tab: HTMLElement;
	private readonly _tabLabel: HTMLElement;
	private readonly _container: HTMLElement;
	private readonly _outputElement: HTMLElement;
	private readonly _actions: HTMLElement;

	private _visible = false;
	private _renderTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Listeners for the CURRENT header only. _renderActions rebuilds the header on every task
	 * state change, so its button listeners must die with the buttons.
	 */
	private readonly _actionDisposables = this._register(new DisposableStore());

	constructor(
		private readonly _panel: PanelPart,
		private readonly _taskService: TaskService,
		private readonly _setPanelVisible: (visible: boolean) => void
	) {
		super();

		const tabs = _panel.getTabsContainer();
		const content = _panel.getContentContainer();
		if (!tabs || !content) {
			throw new Error('the panel has no tab or content container');
		}

		this._tab = append(tabs, $('.panel-tab.task-tab'));
		this._tabLabel = append(this._tab, $('.panel-tab-label', {}, 'Tasks'));
		this._register(addDisposableListener(this._tab, 'mousedown', () => this.show()));

		this._container = append(content, $('.task-pane'));
		const header = append(this._container, $('.task-pane-header'));
		this._actions = append(header, $('.task-pane-actions'));
		this._outputElement = append(this._container, $('pre.task-output'));

		this._panel.registerTabGroup(TAB_GROUP_ID, { setVisible: visible => this._setVisible(visible) });

		this._register(this._taskService.onDidWriteOutput(() => this._scheduleRender()));
		this._register(this._taskService.onDidChangeState(() => {
			this._renderActions();
			this._scheduleRender();
		}));

		this._renderActions();
		this._render();
	}

	/** bring the panel up and make this pane the visible one */
	show(): void {
		this._setPanelVisible(true);
		this._panel.activateTabGroup(TAB_GROUP_ID);
	}

	private _setVisible(visible: boolean): void {
		this._visible = visible;
		this._container.style.display = visible ? '' : 'none';
		this._tab.classList.toggle('active', visible);
		if (visible) {
			this._render();
		}
	}

	private _renderActions(): void {
		this._actionDisposables.clear();
		this._actions.textContent = '';

		const state = this._taskService.state;
		const task = this._taskService.execution?.task;
		this._tabLabel.textContent = task ? `Tasks: ${task.label}` : 'Tasks';

		const status = append(this._actions, $('span.task-status'));
		if (state === 'running' && task) {
			status.textContent = `Running ${task.label}…`;
		} else if (state === 'exited' && task) {
			const code = this._taskService.execution?.exitCode;
			status.textContent = `${task.label} — ${code === 0 ? 'completed' : `exited with code ${code ?? 'unknown'}`}`;
			status.classList.toggle('failed', code !== 0);
		} else {
			status.textContent = 'No task has been run.';
		}

		const action = (label: string, title: string, run: () => void): void => {
			const element = append(this._actions, $('span.task-action', { title, tabindex: '0' }, label));
			this._actionDisposables.add(addDisposableListener(element, 'click', run));
			this._actionDisposables.add(addDisposableListener(element, 'keydown', (event: KeyboardEvent) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					run();
				}
			}));
		};

		if (state === 'running') {
			action('Terminate', 'Terminate the running task', () => void this._taskService.terminate());
		} else if (state === 'exited') {
			// the real pane offers exactly this after an exit
			action('Restart', 'Run the task again', () => void this._taskService.rerun());
		}
		if (this._taskService.output) {
			action('Clear', 'Clear the output', () => this._taskService.clearOutput());
		}
	}

	private _scheduleRender(): void {
		if (this._renderTimer !== undefined) {
			return;
		}
		// a flooding task must not re-render per chunk
		this._renderTimer = setTimeout(() => {
			this._renderTimer = undefined;
			this._render();
		}, RENDER_DEBOUNCE_MS);
	}

	private _render(): void {
		if (!this._visible) {
			return; // nothing to paint while hidden; show() re-renders
		}
		// The service already stripped escapes and capped the length as the bytes arrived, so
		// this is a plain assignment — it never scans the buffer.
		// textContent, never innerHTML: this is process output.
		this._outputElement.textContent = this._taskService.output;
		// follow the tail, like a terminal does
		this._container.scrollTop = this._container.scrollHeight;
	}

	override dispose(): void {
		if (this._renderTimer !== undefined) {
			clearTimeout(this._renderTimer);
		}
		super.dispose();
	}
}
