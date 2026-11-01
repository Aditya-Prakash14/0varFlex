// src/renderer/workbench/browser/parts/panel/panelPart.ts — the bottom part. Exercise 03's
// placeholder is now the real terminal panel: a tab strip + actions in the title area, the
// terminal containers in the content area (the terminal contrib fills both).

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { append, $ } from '../../../../base/browser/dom.js';
import { Part } from '../../part.js';

export class PanelPart extends Part {

	private _tabsContainer: HTMLElement | undefined;
	private _actionsContainer: HTMLElement | undefined;
	private _contentContainer: HTMLElement | undefined;

	private readonly _onDidRequestHide = this._register(new Emitter<void>());
	/** the collapse chevron in the header wants the split view to hide the panel */
	readonly onDidRequestHide: Event<void> = this._onDidRequestHide.event;

	private readonly _onDidLayout = this._register(new Emitter<void>());
	/** every split-size change lands here synchronously (sash drags, hide/show) */
	readonly onDidLayout: Event<void> = this._onDidLayout.event;

	constructor() {
		super('panel', { hasTitle: true });
	}

	/** ported override: the split view hands the new size down on every sash change */
	override layout(width: number, height: number, top = 0, left = 0): void {
		super.layout(width, height, top, left);
		this._onDidLayout.fire();
	}

	override get minimumWidth(): number { return 0; }
	override get maximumWidth(): number { return Number.POSITIVE_INFINITY; }
	override get minimumHeight(): number { return 100; }
	override get maximumHeight(): number { return Math.max(100, Math.round(window.innerHeight * 0.7)); }

	protected override createTitleArea(parent: HTMLElement): HTMLElement {
		const header = append(parent, $('.panel-header'));
		this._tabsContainer = append(header, $('.panel-tabs'));
		this._actionsContainer = append(header, $('.panel-actions'));
		const collapse = append(this._actionsContainer, $('.panel-action.panel-collapse', { title: 'Hide Panel' }));
		collapse.textContent = '⌄';
		collapse.addEventListener('click', () => this._onDidRequestHide.fire());
		return header;
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this._contentContainer = append(parent, $('.panel-content'));
		return this._contentContainer;
	}

	/** the terminal tab strip */
	getTabsContainer(): HTMLElement | undefined {
		return this._tabsContainer;
	}

	/** the +/trash action area (the terminal contrib appends its buttons) */
	getActionsContainer(): HTMLElement | undefined {
		return this._actionsContainer;
	}

	getContentContainer(): HTMLElement | undefined {
		return this._contentContainer;
	}

	// ---- A2-3: tab GROUPS, so the panel can host more than one kind of pane.
	//
	// The terminal contrib owns N tabs (one per instance); the task contrib owns one. Rather
	// than have them coordinate with each other, each registers a `setVisible` callback and the
	// part arbitrates: activating a group hides every other group. The reference's
	// paneCompositePart does the same job with a composite registry.

	private readonly _tabGroups = new Map<string, { setVisible(visible: boolean): void }>();
	private _activeTabGroup: string | undefined;

	registerTabGroup(id: string, group: { setVisible(visible: boolean): void }): void {
		this._tabGroups.set(id, group);
		// the first group registered becomes the active one
		if (this._activeTabGroup === undefined) {
			this._activeTabGroup = id;
		}
		group.setVisible(this._activeTabGroup === id);
	}

	activateTabGroup(id: string): void {
		if (!this._tabGroups.has(id)) {
			return;
		}
		this._activeTabGroup = id;
		for (const [groupId, group] of this._tabGroups) {
			group.setVisible(groupId === id);
		}
	}

	get activeTabGroup(): string | undefined {
		return this._activeTabGroup;
	}
}
