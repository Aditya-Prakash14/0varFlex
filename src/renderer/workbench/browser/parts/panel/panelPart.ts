// src/renderer/workbench/browser/parts/panel/panelPart.ts — the bottom part.
// One disabled TERMINAL tab placeholder; the real terminal arrives in 13.

import { append, $ } from '../../../../base/browser/dom.js';
import { Part } from '../../part.js';

export class PanelPart extends Part {

	constructor() {
		super('panel', { hasTitle: true });
	}

	override get minimumWidth(): number { return 0; }
	override get maximumWidth(): number { return Number.POSITIVE_INFINITY; }
	override get minimumHeight(): number { return 100; }
	override get maximumHeight(): number { return Math.max(100, Math.round(window.innerHeight * 0.7)); }

	protected override createTitleArea(parent: HTMLElement): HTMLElement {
		return append(parent, $('.panel-header', {},
			$('.panel-tab.disabled', { title: 'The terminal arrives in exercise 13' }, 'TERMINAL')
		));
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		return append(parent, $('.panel-content', {},
			$('.panel-placeholder', {}, 'panel — empty for now'),
			// temporary: proves the preventDefault policy (cmd+b must toggle, not type) — the real
			// settings editor arrives in 06
			$('textarea#settings-preview', { placeholder: 'settings preview (try Cmd+B with focus in here)', spellcheck: 'false' })
		));
	}
}
