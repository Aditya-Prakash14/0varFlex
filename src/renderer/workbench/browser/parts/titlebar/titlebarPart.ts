// src/renderer/workbench/browser/parts/titlebar/titlebarPart.ts — the custom title bar.
// Compared to vs/workbench/browser/parts/titlebar/titlebarPart.ts: no menus, no command
// center, no editor actions — a centered label and placeholder flex areas. The window is
// created with `titleBarStyle: 'hiddenInset'` (main.ts), so the traffic lights sit inside.

import { IPartOptions, Part } from '../../part.js';
import { append, $ } from '../../../../base/browser/dom.js';

export class TitlebarPart extends Part {

	constructor(
		options: IPartOptions = { hasTitle: true }
	) {
		super('titlebar', options);
	}

	override get minimumWidth(): number { return 0; }
	override get maximumWidth(): number { return Number.POSITIVE_INFINITY; }
	override get minimumHeight(): number { return 0; }
	override get maximumHeight(): number { return Number.POSITIVE_INFINITY; }

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		return append(parent, $('.titlebar-content', {},
			$('.titlebar-left'),
			$('.titlebar-center', {}, $('span.titlebar-title', {}, '0varflex')),
			$('.titlebar-right')
		));
	}
}
