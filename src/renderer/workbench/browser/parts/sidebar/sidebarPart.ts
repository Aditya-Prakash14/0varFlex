// src/renderer/workbench/browser/parts/sidebar/sidebarPart.ts — the composite host.
// vs/workbench/browser/parts/sidebar/sidebarPart.ts derives from paneCompositePart.ts (a part
// hosting pluggable views); ours is the shape without the plug-in machinery — the Explorer
// composite arrives in exercise 10.

import { append, $ } from '../../../../base/browser/dom.js';
import { Part } from '../../part.js';

export class SidebarPart extends Part {

	constructor() {
		super('sidebar', { hasTitle: true });
	}

	override get minimumWidth(): number { return 170; }
	override get maximumWidth(): number { return Math.max(170, Math.round(window.innerWidth * 0.4)); }
	override get minimumHeight(): number { return 0; }
	override get maximumHeight(): number { return Number.POSITIVE_INFINITY; }

	protected override createTitleArea(parent: HTMLElement): HTMLElement {
		return append(parent, $('.sidebar-header', {}, 'EXPLORER'));
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		return append(parent, $('.sidebar-content', {},
			$('.sidebar-placeholder', {}, 'No folder opened — the Explorer arrives in exercise 10')
		));
	}
}
