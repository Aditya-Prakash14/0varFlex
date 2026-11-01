// src/renderer/editor/contrib/find/findController.ts — the in-editor find and replace widget,
// ported in shape from vs/editor/contrib/find/browser/{findController,findWidget,findModel}.ts.
//
// This is the omission textModel.ts recorded ("no in-model search"), now paid back: the matching
// lives on the model (textModelSearch.ts, tested on its own) and this file is the UI and the
// navigation around it.
//
// What it does:
//   - a floating widget at the top right of the editor, with the three real toggles
//     (match case, whole word, regex) and a live "3 of 17" count;
//   - every match highlighted as a content layer, the current one highlighted differently,
//     reusing exactly the mechanism 12's marker squiggles use;
//   - Enter / Shift+Enter walk the matches and wrap, F3 / Shift+F3 do the same without focus
//     in the box, Escape closes and returns focus to the editor;
//   - replace and replace-all, with replace-all as ONE undo step.
//
// delta: no search scope ("find in selection"), no match-count-limit UX beyond "more than N",
// no seed-from-selection history, no find-previous-on-regex-anchored special cases.
//
// shortcut: matches are recomputed for the whole model on each change rather than patched
// incrementally. At the 100k-line budget that is a full scan per keystroke in the find box; the
// reference keeps a decorations tree and edits it. Upgrade if find feels slow on a large file.

import { Emitter, Event } from '../../../../common/base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../common/base/common/lifecycle.js';
import { Range } from '../../../../common/editor/common/core/range.js';
import {
	expandReplacement,
	IFindMatch,
	indexOfMatchNear,
	ISearchParams
} from '../../../../common/editor/common/model/textModelSearch.js';
import { addDisposableListener, append, $ } from '../../../base/browser/dom.js';
import { CommandMetadata, CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { ContextKeyExpr, RawContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { KeyCode, KeyMod } from '../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { Selection } from '../../browser/core/selection.js';
import { USUAL_WORD_SEPARATORS } from '../../browser/core/wordHelper.js';
import type { EditorWidget } from '../../browser/editorWidget.js';
import type { IRenderContext, IViewLayer } from '../../browser/view.js';
import type { IViewport } from '../../browser/viewModel.js';

/** the widget only renders this many highlights; the count still reports the true total */
const MAX_HIGHLIGHTS = 2_000;
/** the matching limit, so a pattern like `.` on a big file cannot stall the editor */
const MATCH_LIMIT = 20_000;

interface IMatchRect {
	readonly top: number;
	readonly left: number;
	readonly width: number;
	readonly current: boolean;
}

/** pooled divs, per-rect class — the same shape as the marker squiggle layer */
class FindMatchLayer implements IViewLayer {

	readonly element: HTMLElement;
	private readonly _pool: HTMLElement[] = [];

	constructor(private readonly _getRects: (viewport: IViewport, context: IRenderContext) => IMatchRect[]) {
		this.element = $('.editor-find-matches');
	}

	render(viewport: IViewport, context: IRenderContext): void {
		const rects = this._getRects(viewport, context);
		for (let i = 0; i < Math.max(rects.length, this._pool.length); i++) {
			let node = this._pool[i];
			if (!node) {
				node = $('.find-match');
				this._pool[i] = node;
				this.element.appendChild(node);
			}
			if (i >= rects.length) {
				node.style.display = 'none';
				continue;
			}
			const rect = rects[i];
			node.style.display = '';
			node.className = rect.current ? 'find-match current' : 'find-match';
			node.style.top = `${rect.top}px`;
			node.style.left = `${rect.left}px`;
			node.style.width = `${rect.width}px`;
		}
	}
}

export class FindController extends Disposable {

	private readonly _widgetElement: HTMLElement;
	private readonly _findInput: HTMLInputElement;
	private readonly _replaceInput: HTMLInputElement;
	private readonly _countElement: HTMLElement;
	private readonly _replaceRow: HTMLElement;
	private readonly _toggles = new Map<'case' | 'word' | 'regex', HTMLElement>();

	private _visible = false;
	private _replaceVisible = false;
	private _matchCase = false;
	private _wholeWord = false;
	private _isRegExp = false;

	private _matches: readonly IFindMatch[] = [];
	private _limitHit = false;
	private _current = -1;

	private readonly _onDidChangeVisibility = this._register(new Emitter<boolean>());
	readonly onDidChangeVisibility: Event<boolean> = this._onDidChangeVisibility.event;

	constructor(private readonly _editor: EditorWidget) {
		super();

		// the widget floats over the editor, top right, like the real one
		this._widgetElement = append(_editor.view.element, $('.editor-find-widget'));
		this._widgetElement.style.display = 'none';

		const findRow = append(this._widgetElement, $('.find-row'));
		this._findInput = append(findRow, $<HTMLInputElement>('input.find-input', {
			type: 'text', placeholder: 'Find', spellcheck: 'false', 'aria-label': 'Find'
		}));
		this._countElement = append(findRow, $('span.find-count'));

		const toggleRow = append(findRow, $('.find-toggles'));
		this._addToggle(toggleRow, 'case', 'Aa', 'Match Case');
		this._addToggle(toggleRow, 'word', 'ab', 'Match Whole Word');
		this._addToggle(toggleRow, 'regex', '.*', 'Use Regular Expression');

		const navRow = append(findRow, $('.find-nav'));
		this._addButton(navRow, '↑', 'Previous Match (Shift+Enter)', () => this.moveToPrevious());
		this._addButton(navRow, '↓', 'Next Match (Enter)', () => this.moveToNext());
		this._addButton(navRow, '✕', 'Close (Escape)', () => this.hide());

		this._replaceRow = append(this._widgetElement, $('.find-replace-row'));
		this._replaceRow.style.display = 'none';
		this._replaceInput = append(this._replaceRow, $<HTMLInputElement>('input.find-input', {
			type: 'text', placeholder: 'Replace', spellcheck: 'false', 'aria-label': 'Replace'
		}));
		const replaceNav = append(this._replaceRow, $('.find-nav'));
		this._addButton(replaceNav, '⇥', 'Replace (Enter)', () => this.replaceCurrent());
		this._addButton(replaceNav, '⇥⇥', 'Replace All', () => this.replaceAll());

		// the highlight layer sits in content space, so no scroll subtraction (unlike a margin layer)
		this._editor.view.addContentLayer(new FindMatchLayer((viewport, context) => this._matchRects(viewport, context)));

		this._register(addDisposableListener(this._findInput, 'input', () => {
			this._recompute({ moveToMatch: true });
		}));
		this._register(addDisposableListener(this._findInput, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				event.shiftKey ? this.moveToPrevious() : this.moveToNext();
			} else if (event.key === 'Escape') {
				event.preventDefault();
				this.hide();
			}
		}));
		this._register(addDisposableListener(this._replaceInput, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				this.replaceCurrent();
			} else if (event.key === 'Escape') {
				event.preventDefault();
				this.hide();
			}
		}));

		// an edit anywhere invalidates the match list — including the agent writing the file
		const model = this._editor.getModel();
		if (model) {
			this._register(model.onDidChangeContent(() => {
				if (this._visible) {
					this._recompute({ moveToMatch: false });
				}
			}));
		}
	}

	get isVisible(): boolean { return this._visible; }
	get matchCount(): number { return this._matches.length; }
	/** 1-based, for the "3 of 17" readout and for tests */
	get currentMatchIndex(): number { return this._current + 1; }

	// ---- open / close

	show(options: { seedFromSelection?: boolean; showReplace?: boolean } = {}): void {
		this._visible = true;
		this._widgetElement.style.display = '';

		if (options.showReplace !== undefined) {
			this._replaceVisible = options.showReplace;
			this._replaceRow.style.display = options.showReplace ? '' : 'none';
		}

		// seed from the selection, which is what every editor does on Ctrl+F
		if (options.seedFromSelection !== false) {
			const selected = this._editor.getSelectedText();
			if (selected && !selected.includes('\n')) {
				this._findInput.value = selected;
			}
		}

		this._recompute({ moveToMatch: true });
		this._findInput.focus();
		this._findInput.select();
		this._onDidChangeVisibility.fire(true);
	}

	hide(): void {
		if (!this._visible) {
			return;
		}
		this._visible = false;
		this._widgetElement.style.display = 'none';
		this._matches = [];
		this._current = -1;
		this._editor.view.scheduleRender();
		this._editor.focus();
		this._onDidChangeVisibility.fire(false);
	}

	focusFindInput(): void {
		this._findInput.focus();
		this._findInput.select();
	}

	// ---- navigation

	moveToNext(): void {
		this._move(true);
	}

	moveToPrevious(): void {
		this._move(false);
	}

	private _move(forward: boolean): void {
		if (this._matches.length === 0) {
			return;
		}
		if (this._current === -1) {
			this._current = indexOfMatchNear(this._matches, this._editor.getSelection().getPosition(), forward);
		} else {
			// wrap in both directions
			this._current = forward
				? (this._current + 1) % this._matches.length
				: (this._current - 1 + this._matches.length) % this._matches.length;
		}
		this._revealCurrent();
	}

	private _revealCurrent(): void {
		const match = this._matches[this._current];
		if (!match) {
			return;
		}
		const range = match.range;
		this._editor.setSelection(new Selection(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn));
		this._editor.revealPosition(range.getStartPosition(), 'center');
		this._renderCount();
		this._editor.view.scheduleRender();
	}

	// ---- replace

	replaceCurrent(): void {
		const match = this._matches[this._current];
		if (!match || this._editor.isReadonly) {
			return;
		}
		const text = expandReplacement(this._replaceInput.value, match, this._isRegExp);
		this._editor.replaceRange(match.range, text);
		// the edit fires onDidChangeContent, which recomputes; then land on the next match
		this._recompute({ moveToMatch: false });
		if (this._matches.length > 0) {
			this._current = Math.min(this._current, this._matches.length - 1);
			this._revealCurrent();
		}
	}

	replaceAll(): void {
		if (this._matches.length === 0 || this._editor.isReadonly) {
			return;
		}
		const model = this._editor.getModel();
		if (!model) {
			return;
		}

		// ONE undo step for the whole operation, and applied back-to-front so that replacing an
		// earlier match cannot shift the ranges of the later ones
		model.pushStackElement();
		const ordered = [...this._matches].reverse();
		for (const match of ordered) {
			this._editor.replaceRange(match.range, expandReplacement(this._replaceInput.value, match, this._isRegExp));
		}
		model.pushStackElement();

		this._recompute({ moveToMatch: false });
	}

	// ---- state

	toggleMatchCase(): void { this._matchCase = !this._matchCase; this._afterToggle(); }
	toggleWholeWord(): void { this._wholeWord = !this._wholeWord; this._afterToggle(); }
	toggleRegExp(): void { this._isRegExp = !this._isRegExp; this._afterToggle(); }

	toggleReplace(): void {
		this._replaceVisible = !this._replaceVisible;
		this._replaceRow.style.display = this._replaceVisible ? '' : 'none';
	}

	private _afterToggle(): void {
		this._updateToggles();
		this._recompute({ moveToMatch: true });
	}

	private _searchParams(): ISearchParams {
		return {
			searchString: this._findInput.value,
			isRegExp: this._isRegExp,
			matchCase: this._matchCase,
			wholeWord: this._wholeWord,
			wordSeparators: USUAL_WORD_SEPARATORS
		};
	}

	private _recompute(options: { moveToMatch: boolean }): void {
		const model = this._editor.getModel();
		if (!model || !this._findInput.value) {
			this._matches = [];
			this._limitHit = false;
			this._current = -1;
			this._renderCount();
			this._editor.view.scheduleRender();
			return;
		}

		const result = model.findMatches(this._searchParams(), { captureMatches: this._isRegExp, limit: MATCH_LIMIT });
		this._matches = result.matches;
		this._limitHit = result.limitHit;

		if (this._matches.length === 0) {
			this._current = -1;
		} else if (options.moveToMatch) {
			this._current = indexOfMatchNear(this._matches, this._editor.getSelection().getPosition());
			this._revealCurrent();
			return;
		} else if (this._current >= this._matches.length) {
			this._current = this._matches.length - 1;
		}

		this._renderCount();
		this._editor.view.scheduleRender();
	}

	private _renderCount(): void {
		const total = this._matches.length;
		if (!this._findInput.value) {
			this._countElement.textContent = '';
		} else if (total === 0) {
			this._countElement.textContent = 'No results';
		} else {
			const suffix = this._limitHit ? '+' : '';
			this._countElement.textContent = this._current >= 0
				? `${this._current + 1} of ${total}${suffix}`
				: `${total}${suffix} results`;
		}
		this._countElement.classList.toggle('no-results', !!this._findInput.value && total === 0);
	}

	private _matchRects(viewport: IViewport, context: IRenderContext): IMatchRect[] {
		if (!this._visible || this._matches.length === 0) {
			return [];
		}

		const rects: IMatchRect[] = [];
		const lineHeight = context.viewModel.getLineHeight();

		for (let i = 0; i < this._matches.length && rects.length < MAX_HIGHLIGHTS; i++) {
			const range = this._matches[i].range;
			// only what is on screen
			if (range.startLineNumber < viewport.startLineNumber || range.startLineNumber > viewport.endLineNumber) {
				continue;
			}
			const lineText = context.model.getLineContent(range.startLineNumber);
			const left = context.viewModel.getXForColumn(lineText, range.startColumn);
			const right = context.viewModel.getXForColumn(lineText, range.endColumn);
			rects.push({
				// content-space: no scroll subtraction, unlike a margin layer
				top: context.viewModel.getLineTop(range.startLineNumber),
				left,
				width: Math.max(2, right - left),
				current: i === this._current
			});
		}
		void lineHeight;
		return rects;
	}

	// ---- widget bits

	private _addToggle(parent: HTMLElement, id: 'case' | 'word' | 'regex', label: string, title: string): void {
		const element = append(parent, $('span.find-toggle', { title, role: 'checkbox', tabindex: '0' }, label));
		this._toggles.set(id, element);
		const run = () => {
			if (id === 'case') {
				this.toggleMatchCase();
			} else if (id === 'word') {
				this.toggleWholeWord();
			} else {
				this.toggleRegExp();
			}
		};
		this._register(addDisposableListener(element, 'click', run));
		this._register(addDisposableListener(element, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				run();
			}
		}));
	}

	private _addButton(parent: HTMLElement, label: string, title: string, run: () => void): void {
		const element = append(parent, $('span.find-button', { title, tabindex: '0' }, label));
		this._register(addDisposableListener(element, 'click', run));
		this._register(addDisposableListener(element, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				run();
			}
		}));
	}

	private _updateToggles(): void {
		const states: [string, boolean][] = [['case', this._matchCase], ['word', this._wholeWord], ['regex', this._isRegExp]];
		for (const [id, on] of states) {
			const element = this._toggles.get(id as 'case' | 'word' | 'regex');
			element?.classList.toggle('checked', on);
			element?.setAttribute('aria-checked', String(on));
		}
	}
}

// ---- the per-widget lookup, the same shape suggest and hover use

const findControllers = new WeakMap<EditorWidget, FindController>();

export function registerFindController(widget: EditorWidget, controller: FindController): void {
	findControllers.set(widget, controller);
}

export function findControllerFor(widget: EditorWidget | null): FindController | null {
	return widget ? findControllers.get(widget) ?? null : null;
}

// ---- commands & keybindings, with the real ids from the reference's findModel.ts

export const FIND_IDS = {
	StartFindAction: 'actions.find',
	NextMatchFindAction: 'editor.action.nextMatchFindAction',
	PreviousMatchFindAction: 'editor.action.previousMatchFindAction',
	StartFindReplaceAction: 'editor.action.startFindReplaceAction',
	CloseFindWidgetCommand: 'closeFindWidget',
	ToggleFindCaseSensitiveCommand: 'toggleFindCaseSensitive',
	ToggleFindWholeWordCommand: 'toggleFindWholeWord',
	ToggleFindRegexCommand: 'toggleFindRegex',
	ReplaceOneAction: 'editor.action.replaceOne',
	ReplaceAllAction: 'editor.action.replaceAll'
} as const;

/** true while a find widget is open, so Escape and Enter go to it and not the editor */
export const FindWidgetVisibleContext = new RawContextKey<boolean>('findWidgetVisible', false);

export function registerFindCommands(getActiveController: () => FindController | null): IDisposable {
	const disposables: IDisposable[] = [];
	const editorFocus = new RawContextKey<boolean>('editorTextFocus', false);

	const register = (
		id: string,
		title: string,
		run: (controller: FindController) => void,
		binding?: { primary?: number; secondary?: number; when?: ContextKeyExpr | RawContextKey<boolean> }
	): void => {
		disposables.push(CommandsRegistry.registerCommand(id, () => {
			const controller = getActiveController();
			if (controller) {
				run(controller);
			}
		}));
		disposables.push(CommandMetadata.register({ id, title, category: 'Find' }));
		if (binding) {
			disposables.push(KeybindingsRegistry.registerKeybindingRule({
				id,
				// above EditorCore so the widget wins Escape and the arrows while it is open
				weight: KeybindingWeight.WorkbenchContrib,
				when: binding.when as never,
				primary: binding.primary,
				secondary: binding.secondary
			}));
		}
	};

	register(FIND_IDS.StartFindAction, 'Find', controller => controller.show({ showReplace: false }), {
		primary: KeyMod.CtrlCmd | KeyCode.KeyF
	});

	register(FIND_IDS.StartFindReplaceAction, 'Replace', controller => controller.show({ showReplace: true }), {
		primary: KeyMod.CtrlCmd | KeyCode.KeyH
	});

	register(FIND_IDS.NextMatchFindAction, 'Find Next', controller => controller.moveToNext(), {
		primary: KeyCode.F3
	});

	register(FIND_IDS.PreviousMatchFindAction, 'Find Previous', controller => controller.moveToPrevious(), {
		primary: KeyMod.Shift | KeyCode.F3
	});

	register(FIND_IDS.CloseFindWidgetCommand, 'Close Find Widget', controller => controller.hide(), {
		primary: KeyCode.Escape,
		when: FindWidgetVisibleContext
	});

	register(FIND_IDS.ToggleFindCaseSensitiveCommand, 'Toggle Match Case', controller => controller.toggleMatchCase());
	register(FIND_IDS.ToggleFindWholeWordCommand, 'Toggle Match Whole Word', controller => controller.toggleWholeWord());
	register(FIND_IDS.ToggleFindRegexCommand, 'Toggle Use Regular Expression', controller => controller.toggleRegExp());
	register(FIND_IDS.ReplaceOneAction, 'Replace', controller => controller.replaceCurrent());
	register(FIND_IDS.ReplaceAllAction, 'Replace All', controller => controller.replaceAll());

	void editorFocus;
	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
