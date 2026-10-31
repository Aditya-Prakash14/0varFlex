// src/renderer/editor/contrib/suggest/suggestController.ts — the suggest state machine, ported
// in behavior from vs/editor/contrib/suggest/browser/suggestController.ts + suggestModel.ts:
//
// Ported rules (the ones a user feels):
//   - while the widget is CLOSED only a provider triggerCharacter (or Ctrl+Space) opens it;
//     quickSuggestions is off in this port (delta vs the modern 'on' default);
//   - while OPEN: word chars re-filter the current items (and re-fetch when the list
//     `isIncomplete`); a trigger character re-fetches; any other separator closes the widget
//     until the next trigger;
//   - Esc dismisses until the next trigger; Backspace to an empty prefix keeps the widget;
//   - Tab is NOT bound (editor.tabCompletion "off" → Tab inserts indentation — the ported
//     contract); Enter accepts;
//   - stale fetches are dropped by request generation + a model-version recheck (the ported
//     guard); the superseded request is cancelled across the port → the LSP client sends
//     `$/cancelRequest`;
//   - composition suppresses fetches entirely (the 08 composition flag).
//
// Delta notes: one provider is consulted (no merging across providers), no docs side panel, no
// "No suggestions" empty row (the widget hides), no commit characters / partial accept.

import { Disposable, IDisposable, toDisposable } from '../../../../common/base/common/lifecycle.js';
import { Range } from '../../../../common/editor/common/core/range.js';
import { URI } from '../../../../common/base/common/uri.js';
import { addDisposableListener } from '../../../base/browser/dom.js';
import { CommandsRegistry, CommandMetadata } from '../../../platform/commands/common/commands.js';
import { IContextKey, RawContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { KeyCode, KeyMod } from '../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { EditorWidget, IEditorWidgetServices } from '../../browser/editorWidget.js';
import { isWordCharacter } from '../../browser/core/wordHelper.js';
import { SuggestionTriggerKind, ISuggestItem, scoreItem, wordPrefixAt } from './suggest.js';
import { ISuggestAnchor, MAX_VISIBLE_ROWS, SuggestWidget } from './suggestWidget.js';
import type { IWireCompletionItem, IWireCompletionList } from '../../../../common/platform/extensions/common/extensionHostProtocol.js';

const PAGE_SIZE = MAX_VISIBLE_ROWS;

export class SuggestController extends Disposable {

	private readonly _widget: SuggestWidget;
	private readonly _visibleKey: IContextKey<boolean>;

	/** the provider's items (unfiltered) and the current filtered view */
	private _allItems: ISuggestItem[] = [];
	private _items: ISuggestItem[] = [];
	private _selected = 0;
	private _isIncomplete = false;

	/** Esc (or a separator) closes until the next trigger */
	private _dismissed = false;
	/** every fetch bumps this; stale results are dropped */
	private _generation = 0;
	private _requestId = 0;
	private _lastRequest: { handle: number; requestId: number } | null = null;

	constructor(
		private readonly _editor: EditorWidget,
		private readonly _services: IEditorWidgetServices,
		private readonly _getResource: () => URI | undefined
	) {
		super();
		this._widget = new SuggestWidget(this._editor.view.element);
		this._visibleKey = new RawContextKey<boolean>('suggestWidgetVisible', false).bindTo(this._services.contextKeyService);

		this._register(this._editor.onDidEdit(event => this._onDidEdit(event)));
		// a mouse click moves the cursor: the widget follows the cursor, so it goes (real behavior)
		this._register(addDisposableListener(this._editor.view.element, 'mousedown', () => this._hide(false)));
		// reposition without hiding while the viewport moves under the widget
		this._register(this._editor.onDidRender(() => {
			if (this._widget.isVisible) {
				this._widget.reposition(this._anchor());
			}
		}));

		suggestControllers.set(this._editor, this);
		this._register(toDisposable(() => suggestControllers.delete(this._editor)));
		this._register(toDisposable(() => this._widget.dispose()));
	}

	// ---- public surface (commands reach the ACTIVE editor's controller)

	get isVisible(): boolean {
		return this._widget.isVisible;
	}

	trigger(): void {
		if (!this._editor.getModel() || !this._getResource()) {
			return;
		}
		this._dismissed = false;
		void this._fetch(SuggestionTriggerKind.Invoke, undefined);
	}

	selectNext(): void {
		if (!this._items.length) {
			return;
		}
		this._selected = (this._selected + 1) % this._items.length;
		this._widget.setSelected(this._selected);
	}

	selectPrevious(): void {
		if (!this._items.length) {
			return;
		}
		this._selected = (this._selected - 1 + this._items.length) % this._items.length;
		this._widget.setSelected(this._selected);
	}

	selectPageDown(): void {
		this._selectBy(PAGE_SIZE);
	}

	selectPageUp(): void {
		this._selectBy(-PAGE_SIZE);
	}

	selectFirst(): void {
		if (this._items.length) {
			this._selected = 0;
			this._widget.setSelected(0);
		}
	}

	selectLast(): void {
		if (this._items.length) {
			this._selected = this._items.length - 1;
			this._widget.setSelected(this._selected);
		}
	}

	accept(): void {
		const item = this._items[this._selected];
		if (!item || !this._widget.isVisible) {
			return;
		}
		this._hide(false);
		// The accept: replace the item's range with its insert text, cursor after. The provider's
		// range can be one keystroke stale (the item arrived for an earlier prefix): on the
		// item's line the replacement always runs up to the CURSOR, so the typed tail is
		// replaced instead of being doubled up.
		// shortcut: a provider range extending PAST the cursor is truncated to it — mid-word
		// ranges need the real suggest model's per-keystroke range recomputation.
		let range = item.range;
		const position = this._editor.getSelection().getPosition();
		if (range.startLineNumber === range.endLineNumber && range.startLineNumber === position.lineNumber && position.column >= range.startColumn) {
			range = new Range(range.startLineNumber, range.startColumn, range.startLineNumber, position.column);
		}
		this._editor.replaceRange(range, item.insertText);
		this._editor.focus();
	}

	hide(): void {
		this._hide(true);
	}

	dismiss(): void {
		this._hide(true);
	}

	// ---- triggers

	private _onDidEdit(event: { kind: 'type' | 'delete'; text: string }): void {
		const model = this._editor.getModel();
		const resource = this._getResource();
		if (!model || !resource || this._editor.isComposing()) {
			// composition in flight: never fetch mid-composition (the ported guard)
			return;
		}
		if (event.kind === 'delete') {
			if (this._widget.isVisible) {
				this._refilter();
				if (this._isIncomplete && this._items.length === 0) {
					void this._fetch(SuggestionTriggerKind.TriggerForIncompleteCompletions, undefined);
				}
			}
			return;
		}
		const typed = event.text[event.text.length - 1] ?? '';
		if (typed === '') {
			return;
		}

		if (this._widget.isVisible) {
			if (isWordCharacter(typed)) {
				this._refilter();
				if (this._isIncomplete) {
					void this._fetch(SuggestionTriggerKind.TriggerForIncompleteCompletions, undefined);
				}
			} else if (this._isTriggerCharacter(typed)) {
				void this._fetch(SuggestionTriggerKind.TriggerCharacter, typed);
			} else {
				// a separator closes until the next trigger (ported dismiss rule)
				this._hide(true);
			}
			return;
		}

		if (this._isTriggerCharacter(typed)) {
			this._dismissed = false;
			void this._fetch(SuggestionTriggerKind.TriggerCharacter, typed);
		}
		// a plain word char while closed does not trigger: quickSuggestions off (delta, documented)
	}

	private _isTriggerCharacter(character: string): boolean {
		const model = this._editor.getModel();
		const resource = this._getResource();
		if (!model || !resource) {
			return false;
		}
		const languageId = this._services.languageFeatures.languageIdForResource(resource);
		return this._services.languageFeatures.getCompletionTriggerCharacters(languageId).includes(character);
	}

	// ---- fetching

	private async _fetch(triggerKind: SuggestionTriggerKind, triggerCharacter: string | undefined): Promise<void> {
		const model = this._editor.getModel();
		const resource = this._getResource();
		if (!model || !resource) {
			return;
		}
		const languageId = this._services.languageFeatures.languageIdForResource(resource);
		const providers = this._services.languageFeatures.getCompletionProviders(languageId);
		if (!providers.length) {
			return;
		}

		const generation = ++this._generation;
		const version = model.getVersionId();
		const position = this._editor.getSelection().getPosition();
		const requestId = ++this._requestId;
		const provider = providers[0];

		// supersede the previous in-flight request: the host fires its token → LSP $/cancelRequest
		if (this._lastRequest) {
			this._services.languageFeatures.cancelRequest(this._lastRequest.handle, this._lastRequest.requestId);
		}
		this._lastRequest = { handle: provider.handle, requestId };

		let result: IWireCompletionList | null = null;
		try {
			result = await provider.provideCompletionItems(
				resource,
				model,
				{ lineNumber: position.lineNumber, column: position.column },
				{ triggerKind, triggerCharacter },
				requestId
			);
		} catch {
			result = null;
		}
		// stale guard: a newer fetch superseded this one, or the buffer moved on (ported recheck)
		if (generation !== this._generation) {
			return;
		}
		if (version !== model.getVersionId()) {
			// the text moved while we waited: the items are still the language's items, but the
			// replace ranges and the filter prefix are recomputed against the current text
			this._acceptResult(result);
			if (this._widget.isVisible) {
				this._refilter();
			}
			return;
		}
		this._acceptResult(result);
		this._refilter();
	}

	private _acceptResult(result: IWireCompletionList | null): void {
		this._lastRequest = null;
		this._allItems = result ? result.items.map(item => this._toSuggestItem(item)) : [];
		this._isIncomplete = !!result?.isIncomplete;
	}

	private _toSuggestItem(item: IWireCompletionItem): ISuggestItem {
		const model = this._editor.getModel();
		const position = this._editor.getSelection().getPosition();
		const lineText = model?.getLineContent(position.lineNumber) ?? '';
		// the replace range: the provider's textEdit-lite range, else the word prefix at the cursor
		const range = item.textEdit
			? new Range(
				item.textEdit.range.start.line + 1,
				item.textEdit.range.start.character + 1,
				item.textEdit.range.end.line + 1,
				item.textEdit.range.end.character + 1
			)
			: (() => {
				const prefix = wordPrefixAt(lineText, position.column);
				return new Range(position.lineNumber, prefix.startColumn, position.lineNumber, position.column);
			})();
		const insertText = item.insertText ?? item.label;
		return {
			label: item.label,
			kind: item.kind ?? 1,
			detail: item.detail,
			documentation: item.documentation,
			insertText,
			filterText: item.filterText ?? insertText ?? item.label,
			sortText: item.sortText ?? item.filterText ?? item.label,
			range,
			score: 1,
			matched: []
		};
	}

	/** filter the whole provider list against the word prefix (the reference's refilter) */
	private _refilter(): void {
		const model = this._editor.getModel();
		if (!model) {
			return;
		}
		const position = this._editor.getSelection().getPosition();
		const prefix = wordPrefixAt(model.getLineContent(position.lineNumber), position.column).prefix;

		const scored: ISuggestItem[] = [];
		for (const item of this._allItems) {
			const filterResult = scoreItem(item.filterText, prefix);
			if (!filterResult) {
				continue;
			}
			const labelResult = item.filterText === item.label ? filterResult : scoreItem(item.label, prefix);
			item.score = filterResult.score;
			item.matched = labelResult ? labelResult.matched : [];
			scored.push(item);
		}
		scored.sort((a, b) => b.score - a.score || a.sortText.localeCompare(b.sortText) || a.label.localeCompare(b.label));

		if (scored.length === 0) {
			this._hide(false);
			return;
		}
		this._items = scored;
		// selection: keep the top item focused like the reference does after a refilter
		this._selected = 0;
		if (this._widget.isVisible) {
			this._widget.update(scored, this._selected);
		} else {
			this._dismissed = false;
			this._visibleKey.set(true);
			this._widget.show(scored, this._selected, this._anchor());
		}
	}

	private _selectBy(delta: number): void {
		if (!this._items.length) {
			return;
		}
		const max = this._items.length - 1;
		this._selected = Math.max(0, Math.min(max, this._selected + delta));
		this._widget.setSelected(this._selected);
	}

	private _hide(dismissed: boolean): void {
		if (this._widget.isVisible) {
			this._widget.hide();
			this._visibleKey.set(false);
		}
		this._lastRequest = null;
		this._allItems = [];
		this._items = [];
		this._selected = 0;
		this._isIncomplete = false;
		this._dismissed = dismissed;
	}

	private _anchor(): ISuggestAnchor {
		const model = this._editor.getModel();
		const viewModel = this._editor.getViewModel();
		const scrollable = this._editor.view.scrollableElement;
		const position = this._editor.getSelection().getPosition();
		const lineText = model?.getLineContent(position.lineNumber) ?? '';
		const marginWidth = this._editor.view.marginElement.style.display === 'none'
			? 0
			: this._editor.view.marginElement.offsetWidth;
		const left = viewModel.getXForColumn(lineText, position.column) - scrollable.scrollLeft + marginWidth;
		const lineTop = viewModel.getLineTop(position.lineNumber) - scrollable.scrollTop;
		return {
			left,
			lineTop,
			lineHeight: viewModel.getLineHeight(),
			editorWidth: scrollable.clientWidth + marginWidth,
			editorHeight: this._editor.view.element.clientHeight
		};
	}

	/** the Esc flag is readable for tests/debugging */
	get isDismissed(): boolean {
		return this._dismissed;
	}

	override dispose(): void {
		this._widget.dispose();
		super.dispose();
	}
}

// ---- the per-widget lookup (commands resolve the ACTIVE editor's controller, like 09 does)

const suggestControllers = new WeakMap<EditorWidget, SuggestController>();

export function suggestControllerFor(widget: EditorWidget | null): SuggestController | null {
	return widget ? suggestControllers.get(widget) ?? null : null;
}

// ---- commands & keybindings (real IDs where they exist; weight ABOVE EditorCore so the
// widget wins the arrows/Enter/Esc while visible — the ported contract)

export function registerSuggestCommands(getActiveController: () => SuggestController | null): IDisposable {
	const disposables: IDisposable[] = [];
	const visible = new RawContextKey<boolean>('suggestWidgetVisible', false);
	const editorFocus = new RawContextKey<boolean>('editorTextFocus', false);

	const register = (
		id: string,
		title: string,
		category: string,
		run: (controller: SuggestController) => void,
		binding?: { primary?: number; mac?: number }
	): void => {
		const execute = () => {
			const controller = getActiveController();
			if (controller) {
				run(controller);
			}
		};
		disposables.push(CommandsRegistry.registerCommand(id, () => execute()));
		disposables.push(CommandMetadata.register({ id, title, category }));
		const primary = binding?.primary ?? binding?.mac;
		if (primary !== undefined) {
			disposables.push(KeybindingsRegistry.registerKeybindingRule({
				id,
				weight: KeybindingWeight.EditorContrib,
				when: id === 'editor.action.triggerSuggest' ? editorFocus : visible,
				primary: binding?.primary,
				mac: binding?.mac
			}));
		}
	};

	register('editor.action.triggerSuggest', 'Trigger Suggest', 'Suggest', controller => controller.trigger(), {
		primary: KeyMod.WinCtrl | KeyCode.Space
	});
	register('suggest.selectNext', 'Select Next Suggestion', 'Suggest', controller => controller.selectNext(), { primary: KeyCode.DownArrow, mac: KeyCode.DownArrow });
	register('suggest.selectPrevious', 'Select Previous Suggestion', 'Suggest', controller => controller.selectPrevious(), { primary: KeyCode.UpArrow, mac: KeyCode.UpArrow });
	register('suggest.selectPageDown', 'Select Page Down Suggestion', 'Suggest', controller => controller.selectPageDown(), { primary: KeyCode.PageDown, mac: KeyCode.PageDown });
	register('suggest.selectPageUp', 'Select Page Up Suggestion', 'Suggest', controller => controller.selectPageUp(), { primary: KeyCode.PageUp, mac: KeyCode.PageUp });
	register('suggest.selectFirst', 'Select First Suggestion', 'Suggest', controller => controller.selectFirst(), { primary: KeyCode.Home, mac: KeyCode.Home });
	register('suggest.selectLast', 'Select Last Suggestion', 'Suggest', controller => controller.selectLast(), { primary: KeyCode.End, mac: KeyCode.End });
	register('acceptSelectedSuggestion', 'Accept Selected Suggestion', 'Suggest', controller => controller.accept(), { primary: KeyCode.Enter, mac: KeyCode.Enter });
	register('hideSuggestWidget', 'Hide Suggest Widget', 'Suggest', controller => controller.dismiss(), { primary: KeyCode.Escape, mac: KeyCode.Escape });

	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
