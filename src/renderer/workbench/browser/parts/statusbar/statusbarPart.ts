// src/renderer/workbench/browser/parts/statusbar/statusbarPart.ts — the bottom strip.
// Ported small: left/right entry containers with dynamic add/remove and priority ordering
// (vs/workbench/browser/parts/statusbar/statusbarPart.ts nests two SplitViews for overflow —
// not needed at this scale).

import { append, $ } from '../../../../base/browser/dom.js';
import { Part } from '../../part.js';

export const enum StatusbarAlignment {
	LEFT = 0,
	RIGHT = 1
}

export interface IStatusbarEntry {
	readonly text: string;
	readonly alignment: StatusbarAlignment;
	/** higher priority sits closer to the edge of its side */
	readonly priority?: number;
	/** clicking the entry (10: the file-changed warning) */
	readonly onClick?: () => void;
	readonly title?: string;
}

export class StatusbarPart extends Part {

	private readonly _entries = new Map<string, { entry: IStatusbarEntry; element: HTMLElement }>();
	private _leftContainer: HTMLElement | undefined;
	private _rightContainer: HTMLElement | undefined;

	constructor() {
		super('statusbar');
	}

	override get minimumWidth(): number { return 0; }
	override get maximumWidth(): number { return Number.POSITIVE_INFINITY; }
	override get minimumHeight(): number { return 22; }
	override get maximumHeight(): number { return 22; }

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		const container = append(parent, $('.statusbar-content'));
		this._leftContainer = append(container, $('.statusbar-left'));
		this._rightContainer = append(container, $('.statusbar-right'));
		return container;
	}

	addEntry(id: string, entry: IStatusbarEntry): void {
		this.removeEntry(id);

		const container = entry.alignment === StatusbarAlignment.LEFT ? this._leftContainer! : this._rightContainer!;
		const element = $('.statusbar-entry', {}, entry.text);
		if (entry.title) {
			element.title = entry.title;
		}
		if (entry.onClick) {
			element.classList.add('clickable');
			element.addEventListener('click', () => entry.onClick?.());
		}
		this._entries.set(id, { entry, element });

		// keep the container ordered by priority (higher first)
		const siblings = [...this._entries.entries()].filter(([, item]) => item.entry.alignment === entry.alignment);
		siblings.sort((a, b) => (b[1].entry.priority ?? 0) - (a[1].entry.priority ?? 0));
		const index = siblings.findIndex(([entryId]) => entryId === id);
		const next = siblings[index + 1]?.[1].element;
		container.insertBefore(element, next ?? null);
	}

	removeEntry(id: string): void {
		const existing = this._entries.get(id);
		if (existing) {
			existing.element.remove();
			this._entries.delete(id);
		}
	}
}
