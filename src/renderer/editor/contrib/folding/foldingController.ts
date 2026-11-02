// src/renderer/editor/contrib/folding/foldingController.ts — collapse and expand regions.
//
// Ported in shape from vs/editor/contrib/folding/browser/folding.ts. The three pieces it needs
// were all built before it, which is why this file is small:
//
//   - which lines a block covers: common/editor/common/model/indentRanges.ts (shared with
//     sticky scroll, tested there);
//   - lines not being drawn: common/editor/common/viewModel/lineMapping.ts (shared with the word
//     wrap work still to come, tested there);
//   - a gutter layer: the same margin-layer mechanism the marker dots and breakpoints use.
//
// shortcut: collapsed regions are remembered by HEADER LINE NUMBER, so an edit above a fold
// shifts what is collapsed. The reference tracks them with decorations that move with the text.
// Upgrade when editing above a collapsed region in anger; the fix is a decoration id per region
// rather than a line number.

import { Disposable, IDisposable, toDisposable } from '../../../../common/base/common/lifecycle.js';
import { computeIndentRanges, IIndentRange } from '../../../../common/editor/common/model/indentRanges.js';
import { IHiddenRange } from '../../../../common/editor/common/viewModel/lineMapping.js';
import { $ } from '../../../base/browser/dom.js';
import { CommandMetadata, CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { RawContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { KeyChord, KeyCode, KeyMod } from '../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { Selection } from '../../browser/core/selection.js';
import type { EditorWidget } from '../../browser/editorWidget.js';
import { IRenderContext, IViewLayer } from '../../browser/view.js';
import { IViewport } from '../../browser/viewModel.js';

interface IChevron {
	readonly top: number;
	readonly lineNumber: number;
	readonly collapsed: boolean;
}

/** the gutter chevrons: a margin layer, so tops subtract scrollTop (unlike a content layer) */
class FoldingGutterLayer implements IViewLayer {

	readonly element: HTMLElement;
	private readonly _pool: HTMLElement[] = [];

	constructor(
		private readonly _getChevrons: (viewport: IViewport, context: IRenderContext) => IChevron[],
		private readonly _onClick: (lineNumber: number) => void
	) {
		this.element = $('.editor-folding-gutter');
	}

	render(viewport: IViewport, context: IRenderContext): void {
		const chevrons = this._getChevrons(viewport, context);
		for (let i = 0; i < Math.max(chevrons.length, this._pool.length); i++) {
			let node = this._pool[i];
			if (!node) {
				node = $('.folding-chevron');
				this._pool[i] = node;
				this.element.appendChild(node);
				node.addEventListener('mousedown', event => {
					event.preventDefault();
					event.stopPropagation();
					const lineNumber = Number(node!.dataset.lineNumber);
					if (lineNumber > 0) {
						this._onClick(lineNumber);
					}
				});
			}
			if (i >= chevrons.length) {
				node.style.display = 'none';
				continue;
			}
			const chevron = chevrons[i];
			node.style.display = '';
			node.style.top = `${chevron.top}px`;
			node.dataset.lineNumber = String(chevron.lineNumber);
			node.className = chevron.collapsed ? 'folding-chevron collapsed' : 'folding-chevron';
			node.textContent = chevron.collapsed ? '❯' : '⌄';
			node.title = chevron.collapsed ? 'Unfold' : 'Fold';
		}
	}
}

export class FoldingController extends Disposable {

	/** header line numbers of the collapsed regions */
	private readonly _collapsed = new Set<number>();
	private _ranges: readonly IIndentRange[] = [];
	private _rangesVersion = -1;

	constructor(private readonly _editor: EditorWidget) {
		super();
		this._editor.view.addMarginLayer(new FoldingGutterLayer(
			(viewport, context) => this._chevrons(viewport, context),
			lineNumber => this.toggle(lineNumber)
		));

		const model = this._editor.getModel();
		if (model) {
			// the ranges are recomputed lazily, but what is COLLAPSED has to be re-applied now:
			// an edit changes where each region ends
			this._register(model.onDidChangeContent(() => this._applyHiddenRanges()));
		}
	}

	/** header lines currently collapsed, ascending — for the tests and the dev hook */
	getCollapsedLines(): number[] {
		return [...this._collapsed].sort((a, b) => a - b);
	}

	toggle(lineNumber: number): void {
		if (this._collapsed.has(lineNumber)) {
			this.unfold(lineNumber);
		} else {
			this.fold(lineNumber);
		}
	}

	/** collapse the region headed by `lineNumber`, or the innermost one containing it */
	fold(lineNumber: number): void {
		const range = this._rangeFor(lineNumber);
		if (!range) {
			return;
		}
		this._collapsed.add(range.startLineNumber);
		this._applyHiddenRanges();
	}

	unfold(lineNumber: number): void {
		const range = this._rangeFor(lineNumber);
		if (range && this._collapsed.delete(range.startLineNumber)) {
			this._applyHiddenRanges();
			return;
		}
		// the cursor may be ON a collapsed header whose range no longer resolves
		if (this._collapsed.delete(lineNumber)) {
			this._applyHiddenRanges();
		}
	}

	foldAll(): void {
		for (const range of this._currentRanges()) {
			this._collapsed.add(range.startLineNumber);
		}
		this._applyHiddenRanges();
	}

	unfoldAll(): void {
		if (this._collapsed.size === 0) {
			return;
		}
		this._collapsed.clear();
		this._applyHiddenRanges();
	}

	/**
	 * The region a line belongs to: the one it heads, else the innermost one containing it.
	 *
	 * Folding from inside a block is what Ctrl+Shift+[ is for — requiring the cursor to be on the
	 * header exactly would make the keystroke useless.
	 */
	private _rangeFor(lineNumber: number): IIndentRange | null {
		const ranges = this._currentRanges();
		const header = ranges.find(range => range.startLineNumber === lineNumber);
		if (header) {
			return header;
		}
		// innermost = the latest-starting range that contains the line
		let innermost: IIndentRange | null = null;
		for (const range of ranges) {
			if (range.startLineNumber < lineNumber && lineNumber <= range.endLineNumber) {
				if (!innermost || range.startLineNumber > innermost.startLineNumber) {
					innermost = range;
				}
			}
		}
		return innermost;
	}

	private _currentRanges(): readonly IIndentRange[] {
		const model = this._editor.getModel();
		if (!model) {
			return [];
		}
		if (this._rangesVersion !== model.getVersionId()) {
			this._rangesVersion = model.getVersionId();
			this._ranges = computeIndentRanges(model, this._editor.getViewModel().getTabSize());
		}
		return this._ranges;
	}

	/** push the hidden set into the view model and repaint */
	private _applyHiddenRanges(): void {
		const ranges = this._currentRanges();
		const hidden: IHiddenRange[] = [];
		for (const headerLine of this._collapsed) {
			const range = ranges.find(candidate => candidate.startLineNumber === headerLine);
			if (!range) {
				continue; // the region is gone: the edit that removed it also un-collapses it
			}
			// the header stays visible; its BODY is hidden
			hidden.push({ startLineNumber: range.startLineNumber + 1, endLineNumber: range.endLineNumber });
		}
		this._editor.getViewModel().setHiddenRanges(hidden);

		// a cursor inside a region that just collapsed has nowhere to be: move it to the header
		this._moveCursorOutOfHiddenLines();
		this._editor.view.scheduleRender();
	}

	/** the line the folding commands act on: wherever the cursor is */
	currentLine(): number {
		return this._editor.getSelection().activeLineNumber;
	}

	private _moveCursorOutOfHiddenLines(): void {
		const viewModel = this._editor.getViewModel();
		const selection = this._editor.getSelection();
		if (!viewModel.isLineHidden(selection.activeLineNumber)) {
			return;
		}
		// a cursor in a region that just collapsed has no row; the map sends a hidden line to its
		// fold header, which is exactly where the cursor should land
		const mapping = viewModel.getLineMapping();
		const lineNumber = mapping.viewToModel(mapping.modelToView(selection.activeLineNumber));
		this._editor.setSelection(new Selection(lineNumber, 1, lineNumber, 1));
	}

	private _chevrons(viewport: IViewport, context: IRenderContext): IChevron[] {
		const viewModel = context.viewModel;
		const ranges = this._currentRanges();
		if (ranges.length === 0) {
			return [];
		}
		const headers = new Map(ranges.map(range => [range.startLineNumber, range]));
		const chevrons: IChevron[] = [];

		for (const lineNumber of viewModel.visibleModelLines(viewport)) {
			if (!headers.has(lineNumber)) {
				continue;
			}
			chevrons.push({
				// a margin layer is viewport-space, like the breakpoint dots
				top: viewModel.getLineTop(lineNumber) - context.scrollTop,
				lineNumber,
				collapsed: this._collapsed.has(lineNumber)
			});
		}
		return chevrons;
	}
}

// ---- the per-widget lookup, the same shape the other contribs use

const controllers = new WeakMap<EditorWidget, FoldingController>();

export function registerFoldingController(widget: EditorWidget, controller: FoldingController): void {
	controllers.set(widget, controller);
}

export function foldingControllerFor(widget: EditorWidget | null): FoldingController | null {
	return widget ? controllers.get(widget) ?? null : null;
}

/** the real ids from the reference's folding.ts */
export const FOLDING_IDS = {
	Fold: 'editor.fold',
	Unfold: 'editor.unfold',
	FoldAll: 'editor.foldAll',
	UnfoldAll: 'editor.unfoldAll',
	ToggleFold: 'editor.toggleFold'
} as const;

export function registerFoldingCommands(getActiveController: () => FoldingController | null): IDisposable {
	const disposables: IDisposable[] = [];
	const when = new RawContextKey<boolean>('editorTextFocus', false);

	const register = (
		id: string,
		title: string,
		run: (controller: FoldingController, lineNumber: number) => void,
		primary?: number
	): void => {
		disposables.push(CommandsRegistry.registerCommand(id, () => {
			const controller = getActiveController();
			if (controller) {
				run(controller, controller.currentLine());
			}
		}));
		disposables.push(CommandMetadata.register({ id, title, category: 'Folding' }));
		if (primary !== undefined) {
			disposables.push(KeybindingsRegistry.registerKeybindingRule({
				id,
				weight: KeybindingWeight.EditorCore,
				when: when as never,
				primary
			}));
		}
	};

	register(FOLDING_IDS.Fold, 'Fold', (controller, line) => controller.fold(line),
		KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.BracketLeft);
	register(FOLDING_IDS.Unfold, 'Unfold', (controller, line) => controller.unfold(line),
		KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.BracketRight);
	register(FOLDING_IDS.ToggleFold, 'Toggle Fold', (controller, line) => controller.toggle(line),
		KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyL));
	// the reference's real chords; Ctrl+K alone is already a chord prefix here
	register(FOLDING_IDS.FoldAll, 'Fold All', controller => controller.foldAll(),
		KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.Digit0));
	register(FOLDING_IDS.UnfoldAll, 'Unfold All', controller => controller.unfoldAll(),
		KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyJ));

	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
