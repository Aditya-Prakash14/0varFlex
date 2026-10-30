// src/renderer/workbench/browser/workbench.ts — the composition root.
// A much smaller copy of vs/workbench/browser/workbench.ts: create the layout (which creates
// the parts), observe the window size, run the single layout pass, route menu commands.

import { append, $, ElementSizeObserver } from '../../base/browser/dom.js';
import { Disposable } from '../../../common/base/common/lifecycle.js';
import type { IWindowChannel, WindowMenuCommand } from '../../../common/platform/window/common/window.js';
import { IWorkbenchLayoutServices, WorkbenchLayout } from './layout.js';

export interface IWorkbenchServices extends IWorkbenchLayoutServices {
	readonly windowChannel: IWindowChannel;
}

export class Workbench extends Disposable {

	readonly element: HTMLElement;
	readonly layout: WorkbenchLayout;

	private readonly _sizeObserver: ElementSizeObserver;

	constructor(container: HTMLElement, services: IWorkbenchServices) {
		super();

		this.element = append(container, $('.workbench'));
		this.layout = this._register(new WorkbenchLayout(this.element, services));

		this._sizeObserver = this._register(new ElementSizeObserver(this.element, undefined));
		this._register(this._sizeObserver.onDidChange(() => this._layout()));

		// menu commands (main → renderer) drive the same toggles the activity bar does
		this._register(services.windowChannel.onDidMenuCommand(command => this.executeMenuCommand(command)));
	}

	async start(): Promise<void> {
		await this.layout.load();
		this._sizeObserver.startObserving();
		this._layout();
	}

	executeMenuCommand(command: WindowMenuCommand): void {
		switch (command) {
			case 'toggleSidebar':
				this.layout.toggleSidebar();
				break;
			case 'togglePanel':
				this.layout.togglePanel();
				break;
		}
	}

	private _layout(): void {
		this.layout.layout(this._sizeObserver.getWidth(), this._sizeObserver.getHeight());
	}
}
