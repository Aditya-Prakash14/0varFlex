// src/renderer/editor/contrib/bracketMatching/bracketMatchingController.ts — highlight the
// bracket beside the cursor and its partner, and jump between them.
//
// Ported in shape from vs/editor/contrib/bracketMatching/browser/bracketMatching.ts. The scanning
// is in common/editor/common/model/bracketMatching.ts and tested there; this file is the
// highlight layer and the command, reusing exactly the content-layer mechanism find's match
// highlights use.

import { Disposable, IDisposable, toDisposable } from '../../../../common/base/common/lifecycle.js';
import { Range } from '../../../../common/editor/common/core/range.js';
import { findMatchingBracket, IMatchedBracket } from '../../../../common/editor/common/model/bracketMatching.js';
import { $ } from '../../../base/browser/dom.js';
import { CommandMetadata, CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { RawContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { KeyCode, KeyMod } from '../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { Selection } from '../../browser/core/selection.js';
import type { EditorWidget } from '../../browser/editorWidget.js';
import { IRenderContext, IViewLayer } from '../../browser/view.js';
import { IViewport } from '../../browser/viewModel.js';

interface IBracketRect {
	readonly top: number;
	readonly left: number;
	readonly width: number;
}

/** a content layer: tops are in content space, so no scrollTop subtraction (unlike a margin layer) */
class BracketHighlightLayer implements IViewLayer {

	readonly element: HTMLElement;
	private readonly _pool: HTMLElement[] = [];

	constructor(private readonly _getRects: (viewport: IViewport, context: IRenderContext) => IBracketRect[]) {
		this.element = $('.editor-bracket-matches');
	}

	render(viewport: IViewport, context: IRenderContext): void {
		const rects = this._getRects(viewport, context);
		for (let i = 0; i < Math.max(rects.length, this._pool.length); i++) {
			let node = this._pool[i];
			if (!node) {
				node = $('.bracket-match');
				this._pool[i] = node;
				this.element.appendChild(node);
			}
			if (i >= rects.length) {
				node.style.display = 'none';
				continue;
			}
			node.style.display = '';
			node.style.top = `${rects[i].top}px`;
			node.style.left = `${rects[i].left}px`;
			node.style.width = `${rects[i].width}px`;
		}
	}
}

export class BracketMatchingController extends Disposable {

	private _matched: IMatchedBracket | null = null;
	/** the cursor the current match was computed for, so a re-render does not rescan the file */
	private _computedFor = '';

	constructor(private readonly _editor: EditorWidget) {
		super();
		this._editor.view.addContentLayer(new BracketHighlightLayer((viewport, context) => this._rects(viewport, context)));
	}

	/**
	 * Move the cursor to the partner of the bracket beside it.
	 *
	 * With the cursor already on a partner this walks back, because the scan looks right of the
	 * cursor and then left — which is what makes repeated presses bounce between the two.
	 */
	jumpToBracket(): void {
		const model = this._editor.getModel();
		if (!model) {
			return;
		}
		const position = this._editor.getSelection().getPosition();
		const matched = findMatchingBracket(model, position, this._editor.getLanguageConfiguration().brackets);
		if (!matched) {
			return;
		}
		// a partner that lies AFTER the cursor is a closer, so the cursor goes past it; one that
		// lies before is an opener, so the cursor goes onto it. Compared as positions, not bare
		// columns — the partner is usually on another line.
		const lineNumber = matched.partner.startLineNumber;
		const forward = lineNumber > matched.bracket.startLineNumber
			|| (lineNumber === matched.bracket.startLineNumber && matched.partner.startColumn > matched.bracket.startColumn);
		const target = forward ? matched.partner.startColumn + 1 : matched.partner.startColumn;
		this._editor.setSelection(new Selection(lineNumber, target, lineNumber, target));
		this._editor.revealPosition(matched.partner.getStartPosition());
	}

	private _rects(viewport: IViewport, context: IRenderContext): IBracketRect[] {
		const position = context.selection.getPosition();
		const key = `${position.lineNumber}:${position.column}:${context.model.getVersionId()}`;
		if (key !== this._computedFor) {
			this._computedFor = key;
			this._matched = context.selection.isEmpty()
				? findMatchingBracket(context.model, position, this._editor.getLanguageConfiguration().brackets)
				: null; // a selection means the user is doing something else
		}
		if (!this._matched) {
			return [];
		}

		const rects: IBracketRect[] = [];
		for (const range of [this._matched.bracket, this._matched.partner]) {
			if (range.startLineNumber < viewport.startLineNumber || range.startLineNumber > viewport.endLineNumber) {
				continue; // offscreen
			}
			rects.push(this._rectFor(range, context));
		}
		return rects;
	}

	private _rectFor(range: Range, context: IRenderContext): IBracketRect {
		const lineText = context.model.getLineContent(range.startLineNumber);
		const left = context.viewModel.getXForColumn(lineText, range.startColumn);
		const right = context.viewModel.getXForColumn(lineText, range.endColumn);
		return {
			top: context.viewModel.getLineTop(range.startLineNumber),
			left,
			width: Math.max(2, right - left)
		};
	}
}

// ---- the per-widget lookup, the same shape find, suggest and hover use

const controllers = new WeakMap<EditorWidget, BracketMatchingController>();

export function registerBracketMatchingController(widget: EditorWidget, controller: BracketMatchingController): void {
	controllers.set(widget, controller);
}

export function bracketMatchingControllerFor(widget: EditorWidget | null): BracketMatchingController | null {
	return widget ? controllers.get(widget) ?? null : null;
}

export const BRACKET_MATCHING_IDS = {
	JumpToBracket: 'editor.action.jumpToBracket'
} as const;

export function registerBracketMatchingCommands(getActiveController: () => BracketMatchingController | null): IDisposable {
	const disposables: IDisposable[] = [];
	const when = new RawContextKey<boolean>('editorTextFocus', false);

	disposables.push(CommandsRegistry.registerCommand(BRACKET_MATCHING_IDS.JumpToBracket, () => {
		getActiveController()?.jumpToBracket();
	}));
	disposables.push(CommandMetadata.register({
		id: BRACKET_MATCHING_IDS.JumpToBracket,
		title: 'Go to Bracket',
		category: 'Navigation'
	}));
	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: BRACKET_MATCHING_IDS.JumpToBracket,
		weight: KeybindingWeight.EditorCore,
		when: when as never,
		primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Backslash
	}));

	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
