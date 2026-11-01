// src/renderer/workbench/browser/parts/activitybar/activitybarPart.ts — the icon column.
// vs/workbench/browser/parts/activitybar/activitybarPart.ts hosts the composite bar; ours has
// two placeholder icons and three real actions (Explorer and Search switch the sidebar's
// composite, the gear opens settings.json).

import { Emitter } from '../../../../../common/base/common/event.js';
import { addDisposableListener, append, $ } from '../../../../base/browser/dom.js';
import { Part } from '../../part.js';

export type ActivityBarItem = 'explorer' | 'search' | 'source-control' | 'debug' | 'settings';

interface IActivityBarEntry {
	readonly id: ActivityBarItem;
	readonly title: string;
	readonly icon: string;
	readonly enabled: boolean;
}

// minimal inline SVG icons (static strings — no user data goes through innerHTML)
const ICONS: { [id in ActivityBarItem]: string } = {
	'explorer': '<svg viewBox="0 0 24 24"><path d="M13.5 3.6l7 7.05a1 1 0 010 1.4l-7 7.05a1 1 0 01-1.7-.7V14a.2.2 0 00-.2-.2H4a1 1 0 01-1-1v-1.6a1 1 0 011-1h7.6a.2.2 0 00.2-.2V4.3a1 1 0 011.7-.7z" transform="scale(-1 1) translate(-24 0)"/></svg>',
	'search': '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 10-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1114 9.5 4.5 4.5 0 019.5 14z"/></svg>',
	'source-control': '<svg viewBox="0 0 24 24"><path d="M7 6.5a2.5 2.5 0 112.4 2.5c.3 1 .8 1.8 1.7 2.6 1.4 1.2 3.1 1.6 5.4 1.7a2.5 2.5 0 11.1 1.7c-2.8-.1-5.1-.6-7-2.1-.7-.6-1.3-1.3-1.7-2.1A2.5 2.5 0 017 6.5z"/><circle cx="18" cy="16.5" r="1.8"/><circle cx="10.5" cy="18.8" r="1.2"/></svg>',
	'debug': '<svg viewBox="0 0 24 24"><path d="M9 7V6a3 3 0 013-3v0a3 3 0 013 3v1.2c.8.5 1.5 1.3 1.9 2.3H18a1 1 0 011 1v1a1 1 0 01-1 1h-.6c0 .3-.1.7-.2 1H18a1 1 0 011 1v1a1 1 0 01-1 1h-1.2a6 6 0 01-11.6 0H4a1 1 0 01-1-1v-1a1 1 0 011-1h1.8c-.1-.3-.2-.7-.2-1H5a1 1 0 01-1-1v-1a1 1 0 011-1h1.1c.4-1 1.1-1.8 1.9-2.3V7zm2 0h2V6a1 1 0 00-2 0v1zm-1 6.8A2.2 2.2 0 0012 16a2.2 2.2 0 002-2.2V9.6A2.2 2.2 0 0012 7.4a2.2 2.2 0 00-2 2.2v4.2z"/></svg>',
	'settings': '<svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 00-.48-.41h-3.84a.48.48 0 00-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87a.49.49 0 00.12.61l2.03 1.58c-.05.3-.07.64-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.57 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 00-.12-.61l-2.03-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.6 3.6 0 0112 15.6z"/></svg>'
};

const ENTRIES: IActivityBarEntry[] = [
	{ id: 'explorer', title: 'Explorer', icon: ICONS['explorer'], enabled: true },
	// A1: the Search composite is real now, so this icon switches the sidebar to it
	{ id: 'search', title: 'Search', icon: ICONS['search'], enabled: true },
	// A2-1: a real composite now — whatever provider registers renders in it
	{ id: 'source-control', title: 'Source Control', icon: ICONS['source-control'], enabled: true },
	{ id: 'debug', title: 'Run and Debug (coming later)', icon: ICONS['debug'], enabled: false },
	// the gear sits at the bottom (margin-top: auto) — exercise 06
	{ id: 'settings', title: 'Manage', icon: ICONS['settings'], enabled: true }
];

export class ActivityBarPart extends Part {

	private readonly _onDidClickIcon = this._register(new Emitter<ActivityBarItem>());
	readonly onDidClickIcon = this._onDidClickIcon.event;

	private readonly _iconElements = new Map<ActivityBarItem, HTMLElement>();

	constructor() {
		super('activitybar');
	}

	override get minimumWidth(): number { return 48; }
	override get maximumWidth(): number { return 48; }
	override get minimumHeight(): number { return 0; }
	override get maximumHeight(): number { return Number.POSITIVE_INFINITY; }

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		const container = append(parent, $('.activitybar-content'));

		for (const entry of ENTRIES) {
			const element = append(container, $('.activitybar-item', { title: entry.title }));
			element.innerHTML = entry.icon;
			if (!entry.enabled) {
				element.classList.add('disabled');
			} else {
				this._register(addDisposableListener(element, 'click', () => this._onDidClickIcon.fire(entry.id)));
			}
			this._iconElements.set(entry.id, element);
		}

		this.setActive('explorer');
		return container;
	}

	setActive(id: ActivityBarItem): void {
		for (const [itemId, element] of this._iconElements) {
			element.classList.toggle('active', itemId === id);
		}
	}
}
