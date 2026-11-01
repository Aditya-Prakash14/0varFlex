// src/renderer/workbench/contrib/terminal/browser/terminalPanel.ts — the panel UI, ported in
// shape from the terminal's view pane + tabbed view + the composite bar's actions:
//
//   - one tab per instance, title = the resolved shell basename (`zsh`), active styling, ✕ on
//     hover; an exited tab stays (with the exit banner in the buffer) until closed;
//   - header actions on the RIGHT of the tab strip: `+` (new) and the trash (kill the active);
//     the collapse chevron lives in the panel part itself;
//   - the panel never shows zero terminals while visible: opening it creates the first one;
//   - confirm-on-kill ports the reference's enum semantics: 'editor' (default) does NOT confirm
//     for a PANEL terminal, 'panel'/'always' do — and only when a child process is running.

import { Disposable } from '../../../../../common/base/common/lifecycle.js';
import { append, $ } from '../../../../base/browser/dom.js';
import { ElementSizeObserver } from '../../../../base/browser/dom.js';
import { confirmDialog } from '../../../browser/parts/editor/dialogs/confirmDialog.js';
import type { IConfigurationService } from '../../../../../common/platform/configuration/common/configuration.js';
import type { PanelPart } from '../../../browser/parts/panel/panelPart.js';
import type { TerminalService } from './terminalService.js';
import type { TerminalInstance } from './terminalInstance.js';

interface ITabEntry {
	readonly tab: HTMLElement;
	readonly label: HTMLElement;
	readonly container: HTMLElement;
}

export class TerminalPanel extends Disposable {

	private readonly _tabs = new Map<TerminalInstance, ITabEntry>();
	private _groupVisible = true;
	private readonly _content: HTMLElement;
	private readonly _sizeObserver: ElementSizeObserver;
	private _ensurePromise: Promise<void> | undefined;

	constructor(
		private readonly _panel: PanelPart,
		private readonly _service: TerminalService,
		private readonly _configuration: IConfigurationService,
		private readonly _setPanelVisible: (visible: boolean) => void
	) {
		super();
		const contentContainer = _panel.getContentContainer();
		if (!contentContainer) {
			throw new Error('the panel has no content container');
		}
		this._content = append(contentContainer, $('.terminal-panel'));
		this._sizeObserver = this._register(new ElementSizeObserver(this._content, undefined));
		this._register(this._sizeObserver.onDidChange(() => this.fitAll()));
		// the observer is inert until started (same contract as the view's in 08)
		this._sizeObserver.startObserving();
		// and the part's layout is the DETERMINISTIC path: a sash drag calls it synchronously
		this._register(_panel.onDidLayout(() => {
			this.fitAll();
			// the fit invalidates the DOM layout: one deferred pass settles the grid
			window.setTimeout(() => this.fitAll(), 50);
		}));

		// header actions (the composite bar's new + kill)
		const actions = _panel.getActionsContainer();
		if (actions) {
			const newButton = append(actions, $('.panel-action.terminal-new', { title: 'New Terminal' }));
			newButton.textContent = '+';
			newButton.addEventListener('click', () => void this.newTerminal());
			const killButton = append(actions, $('.panel-action.terminal-kill', { title: 'Kill Terminal' }));
			killButton.textContent = '🗑';
			killButton.addEventListener('click', () => void this.killActive());
		}

		this._register(_service.onDidOpenTerminal(instance => this._addTab(instance)));
		this._register(_service.onDidCloseTerminal(instance => this._removeTab(instance)));
		this._register(_service.onDidChangeActiveTerminal(instance => this._updateActive(instance)));
		this._register(_service.onDidChangeInstanceTitle(instance => this._updateTitle(instance)));
		this._register(_panel.onDidVisibilityChange(visible => {
			if (visible) {
				void this._ensureTerminal();
				// the split view applies the height on show: fit shortly after (a timer, not rAF —
				// rAF never fires in occluded windows)
				window.setTimeout(() => this.fitAll(), 50);
			}
		}));
		this._register(_panel.onDidRequestHide(() => this._setPanelVisible(false)));

		if (_panel.visible) {
			void this._ensureTerminal();
		}
	}

	get isVisible(): boolean {
		return this._panel.visible;
	}

	/** show the panel and make sure a terminal exists (the Cmd+J / toggle paths) */
	async show(): Promise<void> {
		this._setPanelVisible(true);
		await this._ensureTerminal();
	}

	async hide(): Promise<void> {
		this._setPanelVisible(false);
	}

	async newTerminal(): Promise<TerminalInstance> {
		const instance = await this._service.createTerminal();
		this._service.setActive(instance);
		return instance;
	}

	async killActive(): Promise<void> {
		const active = this._service.activeInstance;
		if (active) {
			await this.kill(active);
		}
	}

	async kill(instance: TerminalInstance): Promise<void> {
		if (!instance.isExited && await this._shouldConfirmKill(instance)) {
			const result = await confirmDialog({
				message: `Do you want to terminate the terminal '${instance.title}'?`,
				primaryLabel: 'Terminate',
				secondaryLabel: null,
				cancelLabel: 'Cancel'
			});
			if (result !== 'primary') {
				return;
			}
		}
		await this._service.removeInstance(instance);
	}

	focusActive(): void {
		this._service.activeInstance?.focus();
	}

	clearActive(): void {
		this._service.activeInstance?.clear();
	}

	focusNext(): void {
		this._cycle(1);
	}

	focusPrevious(): void {
		this._cycle(-1);
	}

	private _cycle(delta: number): void {
		const instances = this._service.instances;
		if (instances.length === 0) {
			return;
		}
		const current = this._service.activeInstance;
		const index = current ? instances.indexOf(current) : -1;
		const next = instances[(index + delta + instances.length) % instances.length];
		this._service.setActive(next);
		next.focus();
	}

	/** only a running process in a location the setting names triggers the confirmation */
	private async _shouldConfirmKill(instance: TerminalInstance): Promise<boolean> {
		const setting = this._configuration.getValue<string>('terminal.integrated.confirmOnKill') ?? 'editor';
		if (setting === 'never') {
			return false;
		}
		if (setting === 'editor') {
			// our terminals live in the panel only: 'editor' never confirms (faithful to the enum)
			return false;
		}
		if (instance.id === undefined) {
			return false;
		}
		return this._service.hasChildProcesses(instance.id);
	}

	private async _ensureTerminal(): Promise<void> {
		// an in-flight guard: the boot path (visible panel) and the visibility event can race,
		// and two concurrent ensures create two terminals (and restart the pty host)
		if (this._ensurePromise) {
			return this._ensurePromise;
		}
		this._ensurePromise = (async () => {
			if (this._service.activeInstance) {
				this._service.activeInstance.setVisible(true);
				return;
			}
			if (this._service.instances.length > 0) {
				this._service.setActive(this._service.instances[0]);
				this._service.instances[0].setVisible(true);
				return;
			}
			await this.newTerminal();
		})().finally(() => {
			this._ensurePromise = undefined;
		});
		return this._ensurePromise;
	}

	fitAll(): void {
		for (const instance of this._service.instances) {
			instance.fit();
		}
	}

	private _addTab(instance: TerminalInstance): void {
		const tabs = this._panel.getTabsContainer();
		if (!tabs || this._tabs.has(instance)) {
			return;
		}
		const tab = append(tabs, $('.terminal-tab'));
		const label = append(tab, $('.terminal-tab-label', {}, instance.title));
		const close = append(tab, $('.terminal-tab-close', { title: 'Kill Terminal' }));
		close.textContent = '✕';
		tab.addEventListener('mousedown', (event: MouseEvent) => {
			if (event.target === close) {
				return;
			}
			this._panel.activateTabGroup('terminal');
			this._service.setActive(instance);
			instance.focus();
		});
		close.addEventListener('click', (event: MouseEvent) => {
			event.stopPropagation();
			void this.kill(instance);
		});

		// the instance's container: appended here and given to the instance (open → fit → start)
		const container = append(this._content, $('.terminal-instance'));
		container.style.display = 'none';
		this._tabs.set(instance, { tab, label, container });
		instance.attach(container).catch(error => {
			// an attach failure must be visible (a silent rejection leaves an id-less zombie tab)
			console.error(`[terminal] attach failed: ${(error as Error)?.message ?? error}`);
		});
		this._updateActive(this._service.activeInstance);
	}

	private _removeTab(instance: TerminalInstance): void {
		const entry = this._tabs.get(instance);
		if (!entry) {
			return;
		}
		this._tabs.delete(instance);
		entry.tab.remove();
		entry.container.remove();
		this._updateActive(this._service.activeInstance);
		if (this._service.instances.length === 0 && this._panel.visible) {
			// the panel never shows zero terminals: closing the last kills it and starts one
			void this._ensureTerminal();
		}
	}

	/** A2-3: the panel hosts more than terminals now; the part tells us when we are the ones shown */
	setGroupVisible(visible: boolean): void {
		this._groupVisible = visible;
		for (const [, entry] of this._tabs) {
			entry.tab.style.display = visible ? '' : 'none';
		}
		this._updateActive(this._service.activeInstance);
	}

	private _updateActive(instance: TerminalInstance | null): void {
		for (const [candidate, entry] of this._tabs) {
			const active = this._groupVisible && candidate === instance;
			entry.tab.classList.toggle('active', active);
			entry.container.style.display = active ? '' : 'none';
			if (active) {
				candidate.setVisible(true);
			}
		}
		if (this._groupVisible) {
			this.fitAll();
		}
	}

	private _updateTitle(instance: TerminalInstance): void {
		const entry = this._tabs.get(instance);
		if (!entry) {
			return;
		}
		entry.label.textContent = instance.isExited ? `${instance.title} (exited)` : instance.title;
		entry.tab.classList.toggle('exited', instance.isExited);
	}
}
