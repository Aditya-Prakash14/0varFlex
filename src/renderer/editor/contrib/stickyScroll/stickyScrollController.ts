// src/renderer/editor/contrib/stickyScroll/stickyScrollController.ts — pin the enclosing scopes
// at the top of the editor while scrolling.
//
// Ported in shape from vs/editor/contrib/stickyScroll/browser/stickyScrollController.ts. Which
// lines to pin is computed in common/editor/common/model/indentRanges.ts and tested there; this
// file is the overlay and the settings.
//
// shortcut: no line numbers in the pinned rows and no horizontal following — the overlay sits at
// the content's left edge rather than tracking scrollLeft. Upgrade alongside folding, which wants
// the same gutter treatment.

import { Disposable } from '../../../../common/base/common/lifecycle.js';
import {
	computeIndentRanges, IIndentRange, stickyLinesFor
} from '../../../../common/editor/common/model/indentRanges.js';
import { IConfigurationService } from '../../../../common/platform/configuration/common/configuration.js';
import { addDisposableListener, append, $ } from '../../../base/browser/dom.js';
import { Selection } from '../../browser/core/selection.js';
import type { EditorWidget } from '../../browser/editorWidget.js';
import { expandTabs } from '../../browser/viewModel.js';

const DEFAULT_MAX_LINES = 5;

export class StickyScrollController extends Disposable {

	private readonly _container: HTMLElement;
	private readonly _rows: HTMLElement[] = [];

	/** the ranges for the current content, recomputed only when the version changes */
	private _ranges: readonly IIndentRange[] = [];
	private _rangesVersion = -1;
	private _pinned: readonly IIndentRange[] = [];

	constructor(
		private readonly _editor: EditorWidget,
		private readonly _configuration: IConfigurationService
	) {
		super();
		this._container = append(this._editor.view.element, $('.editor-sticky-scroll'));
		this._container.style.display = 'none';

		// scrolling already schedules a render, so this is the one event needed
		this._register(this._editor.onDidRender(() => this._update()));
		this._register(this._configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('editor.stickyScroll.enabled')
				|| event.affectsConfiguration('editor.stickyScroll.maxLineCount')) {
				this._update();
			}
		}));
	}

	/** the model lines currently pinned, outermost first — for the tests and the dev hook */
	getPinnedLines(): number[] {
		return this._pinned.map(range => range.startLineNumber);
	}

	private get _enabled(): boolean {
		return this._configuration.getValue<boolean>('editor.stickyScroll.enabled') ?? true;
	}

	private get _maxLineCount(): number {
		return this._configuration.getValue<number>('editor.stickyScroll.maxLineCount') ?? DEFAULT_MAX_LINES;
	}

	private _update(): void {
		const model = this._editor.getModel();
		if (!this._enabled || !model) {
			this._hide();
			return;
		}

		const viewModel = this._editor.getViewModel();
		const lineHeight = viewModel.getLineHeight();
		const scrollTop = this._editor.view.getScrollTop();

		// the first line the user can actually see, without the viewport's overscan
		const topLineNumber = Math.min(model.getLineCount(), Math.floor(scrollTop / lineHeight) + 1);

		if (this._rangesVersion !== model.getVersionId()) {
			this._rangesVersion = model.getVersionId();
			this._ranges = computeIndentRanges(model, viewModel.getTabSize());
		}

		const pinned = stickyLinesFor(this._ranges, topLineNumber, this._maxLineCount);
		this._pinned = pinned;
		if (pinned.length === 0) {
			this._hide();
			return;
		}

		this._container.style.display = '';
		// the gutter is a sibling of the scrollable area, so the overlay starts where content does
		this._container.style.left = `${this._editor.view.marginElement.offsetWidth}px`;

		for (let i = 0; i < Math.max(pinned.length, this._rows.length); i++) {
			let row = this._rows[i];
			if (!row) {
				row = append(this._container, $('.view-line.sticky-line'));
				this._rows[i] = row;
				this._register(addDisposableListener(row, 'click', () => {
					const lineNumber = Number(row.dataset.lineNumber);
					if (lineNumber > 0) {
						this._revealLine(lineNumber);
					}
				}));
			}
			if (i >= pinned.length) {
				row.style.display = 'none';
				continue;
			}
			const lineNumber = pinned[i].startLineNumber;
			const { rendered } = expandTabs(model.getLineContent(lineNumber), viewModel.getTabSize());
			row.style.display = '';
			row.style.top = `${i * lineHeight}px`;
			row.style.height = `${lineHeight}px`;
			row.style.lineHeight = `${lineHeight}px`;
			row.dataset.lineNumber = String(lineNumber);
			row.textContent = rendered;
		}
	}

	private _revealLine(lineNumber: number): void {
		this._editor.setSelection(new Selection(lineNumber, 1, lineNumber, 1));
		this._editor.revealPosition(this._editor.getSelection().getPosition(), 'center');
		this._editor.focus();
	}

	private _hide(): void {
		this._pinned = [];
		if (this._container.style.display !== 'none') {
			this._container.style.display = 'none';
			// park the rows too: hiding only the container leaves each row claiming to be visible,
			// which is stale state for anything that inspects them
			this._rows.forEach(row => { row.style.display = 'none'; });
		}
	}
}

// ---- the per-widget lookup, the same shape the other contribs use

const controllers = new WeakMap<EditorWidget, StickyScrollController>();

export function registerStickyScrollController(widget: EditorWidget, controller: StickyScrollController): void {
	controllers.set(widget, controller);
}

export function stickyScrollControllerFor(widget: EditorWidget | null): StickyScrollController | null {
	return widget ? controllers.get(widget) ?? null : null;
}
