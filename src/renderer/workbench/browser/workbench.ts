// src/renderer/workbench/browser/workbench.ts — the composition root.
// A much smaller copy of vs/workbench/browser/workbench.ts: create the layout (which creates
// the parts), observe the window size, run the single layout pass. Menu commands and the
// activity bar route through the command service — one implementation per toggle (ex. 04).

import { append, $, ElementSizeObserver } from '../../base/browser/dom.js';
import { Disposable } from '../../../common/base/common/lifecycle.js';
import type { IWindowChannel, WindowMenuCommand } from '../../../common/platform/window/common/window.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { TOGGLE_PANEL_ID, TOGGLE_SIDEBAR_VISIBILITY_ID } from '../contrib/layout/browser/layoutActions.js';
import { IWorkbenchLayoutServices, WorkbenchLayout } from './layout.js';

export interface IWorkbenchServices extends IWorkbenchLayoutServices {
	readonly windowChannel: IWindowChannel;
	readonly commandService: ICommandService;
}

export class Workbench extends Disposable {

	readonly element: HTMLElement;
	readonly layout: WorkbenchLayout;

	private readonly _sizeObserver: ElementSizeObserver;
	private readonly _commandService: ICommandService;

	constructor(container: HTMLElement, services: IWorkbenchServices) {
		super();

		this._commandService = services.commandService;

		this.element = append(container, $('.workbench'));
		this.layout = this._register(new WorkbenchLayout(this.element, services));

		this._sizeObserver = this._register(new ElementSizeObserver(this.element, undefined));
		this._register(this._sizeObserver.onDidChange(() => this._layout()));

		// menu commands (main → renderer) drive the same commands the activity bar runs
		this._register(services.windowChannel.onDidMenuCommand(command => this.executeMenuCommand(command)));
		this._register(this.layout.activitybar.onDidClickIcon(id => {
			if (id === 'explorer') {
				void this._commandService.executeCommand(TOGGLE_SIDEBAR_VISIBILITY_ID);
			}
		}));
	}

	async start(): Promise<void> {
		this.layout.load();
		this._sizeObserver.startObserving();
		this._layout();
	}

	executeMenuCommand(command: WindowMenuCommand): void {
		switch (command) {
			case 'toggleSidebar':
				void this._commandService.executeCommand(TOGGLE_SIDEBAR_VISIBILITY_ID);
				break;
			case 'togglePanel':
				void this._commandService.executeCommand(TOGGLE_PANEL_ID);
				break;
		}
	}

	private _layout(): void {
		this.layout.layout(this._sizeObserver.getWidth(), this._sizeObserver.getHeight());
	}
}
