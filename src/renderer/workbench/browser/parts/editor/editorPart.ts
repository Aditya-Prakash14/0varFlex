// src/renderer/workbench/browser/parts/editor/editorPart.ts — the editor area: watermark only
// for now. The real EditorPart arrives with real editors in 09; the hint list follows
// editorGroupWatermark.ts (icon + label + keybinding chips), with three fake-but-plausible hints.

import { append, $ } from '../../../../base/browser/dom.js';
import { Part } from '../../part.js';

interface IWatermarkHint {
	readonly icon: string;
	readonly label: string;
	readonly keys: string[];
}

const HINTS: IWatermarkHint[] = [
	{
		icon: '<svg viewBox="0 0 24 24"><path d="M4 4h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1zm1 2v12h14V6H5zm2.5 8l2.4-3 1.8 2.2 2.6-3.4 3.2 4.2H7.5z"/></svg>',
		label: 'Show All Commands',
		keys: ['⇧', '⌘', 'P']
	},
	{
		icon: '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 10-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1114 9.5 4.5 4.5 0 019.5 14z"/></svg>',
		label: 'Go to File',
		keys: ['⌘', 'P']
	},
	{
		icon: '<svg viewBox="0 0 24 24"><path d="M3 5h18a1 1 0 011 1v12a1 1 0 01-1 1H3a1 1 0 01-1-1V6a1 1 0 011-1zm1 2v10h16V7H4zm3 2l4 3-4 3V9z"/></svg>',
		label: 'Toggle Panel',
		keys: ['⌘', 'J']
	}
];

export class EditorPart extends Part {

	constructor() {
		super('editor');
	}

	override get minimumWidth(): number { return 300; }
	override get maximumWidth(): number { return Number.POSITIVE_INFINITY; }
	override get minimumHeight(): number { return 0; }
	override get maximumHeight(): number { return Number.POSITIVE_INFINITY; }

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		const container = append(parent, $('.editor-content'));
		append(container, $('.editor-watermark', {},
			$('.watermark-title', {}, 'mini-vscode'),
			...HINTS.map(hint => {
				const entry = $('.watermark-entry');
				const icon = append(entry, $('.watermark-icon'));
				icon.innerHTML = hint.icon;
				append(entry,
					$('.watermark-label', {}, hint.label),
					$('.watermark-keys', {}, ...hint.keys.map(key => $('kbd.key', {}, key)))
				);
				return entry;
			})
		));
		return container;
	}
}
