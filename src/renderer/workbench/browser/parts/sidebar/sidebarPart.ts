// src/renderer/workbench/browser/parts/sidebar/sidebarPart.ts — the composite host.
// vs/workbench/browser/parts/sidebar/sidebarPart.ts derives from paneCompositePart.ts (a part
// hosting pluggable views); ours is the shape without the plug-in machinery.
//
// A1: the part now really hosts more than one composite (Explorer and Search). A composite is an
// element in the content area plus a title provider; showing one hides the others and re-reads
// the title, which is how the real part swaps viewlets.
//
// shortcut: composites are registered eagerly by the workbench wiring rather than contributed
// through a registry, and all of them stay in the DOM (hidden) instead of being created on first
// show. With two tenants that is cheaper than a lifecycle; upgrade when a composite is expensive.

import { append, $ } from '../../../../base/browser/dom.js';
import { Part } from '../../part.js';

export interface ISidebarComposite {
	readonly id: string;
	readonly element: HTMLElement;
	/** read every time the composite is shown, so a folder rename updates the header */
	getTitle(): string;
}

export class SidebarPart extends Part {

	private readonly _composites: ISidebarComposite[] = [];
	private _activeId: string | undefined;

	constructor() {
		super('sidebar', { hasTitle: true });
	}

	override get minimumWidth(): number { return 170; }
	override get maximumWidth(): number { return Math.max(170, Math.round(window.innerWidth * 0.4)); }
	override get minimumHeight(): number { return 0; }
	override get maximumHeight(): number { return Number.POSITIVE_INFINITY; }

	/** the composites mount into this */
	getContentContainer(): HTMLElement | undefined {
		return this.contentArea;
	}

	registerComposite(composite: ISidebarComposite): void {
		this._composites.push(composite);
		// everything but the active composite starts hidden
		composite.element.style.display = composite.id === this._activeId ? '' : 'none';
	}

	get activeCompositeId(): string | undefined {
		return this._activeId;
	}

	showComposite(id: string): void {
		this._activeId = id;
		for (const composite of this._composites) {
			composite.element.style.display = composite.id === id ? '' : 'none';
		}
		this.updateTitle();
	}

	/** re-read the active composite's title (the folder changed, say) */
	updateTitle(): void {
		const active = this._composites.find(composite => composite.id === this._activeId);
		if (active) {
			this.setTitle(active.getTitle());
		}
	}

	setTitle(title: string): void {
		if (this.titleArea) {
			this.titleArea.textContent = title;
		}
	}

	protected override createTitleArea(parent: HTMLElement): HTMLElement {
		return append(parent, $('.sidebar-header', {}, 'EXPLORER'));
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		return append(parent, $('.sidebar-content'));
	}
}
