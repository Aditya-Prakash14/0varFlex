// src/renderer/editor/contrib/codeAction/codeActionController.ts — Quick Fix (Ctrl+.): ask the
// code action provider at the cursor and offer the titles in a small keyboard-driven menu.
//
// Ported in shape from vs/editor/contrib/codeAction/browser/codeActionCommands.ts (the
// `editor.action.quickFix` action and its Ctrl+. binding) plus the four menu commands of
// vs/platform/actionWidget/browser/actionWidget.ts (hideCodeActionWidget / selectPrevCodeAction /
// selectNextCodeAction / acceptSelectedCodeAction, with the `codeActionMenuVisible` context key).
// The widget anatomy and the anchor-or-flip positioning are the suggest widget's, next door.
//
// The pure half — wire DTO (0-based LSP) to editor-space items, and which resources an action
// touches — is exported at the bottom of this file and unit tested in tests/codeAction.test.ts;
// the DOM is not tested, per the house rule.
//
// shortcut: no action *kinds* UI — no grouping headers, no `only`-filtered variants
// (Refactor…, Source Action…, Organize Imports, Fix All), no preview-on-arrow, no auto-apply of a
// single preferred fix, no filter box. Upgrade when a provider ships more than quickfixes.
// shortcut: an action is applied only when every edit lands in the ACTIVE file; one touching
// another resource is refused with a message instead of being half applied, because this build
// has no bulk-edit service that can open and undo across files. Upgrade when one exists.

import { Disposable, IDisposable, toDisposable } from '../../../../common/base/common/lifecycle.js';
import { Range } from '../../../../common/editor/common/core/range.js';
import { URI } from '../../../../common/base/common/uri.js';
import {
	IWorkspaceTextEdit,
	prepareWorkspaceEdit
} from '../../../../common/editor/common/model/workspaceEdit.js';
import type {
	IWireCodeAction,
	IWireUri,
	IWireWorkspaceEdit
} from '../../../../common/platform/extensions/common/extensionHostProtocol.js';
import { CodeActionTriggerType } from '../../../../common/platform/extensions/common/extensionHostProtocol.js';
import { addDisposableListener, append, $ } from '../../../base/browser/dom.js';
import { CommandMetadata, CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { RawContextKey, IContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { KeyCode, KeyMod } from '../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { toEditorRange } from '../../../workbench/api/common/mainThreadLanguageFeatures.js';
import type { EditorWidget, IEditorWidgetServices } from '../../browser/editorWidget.js';

const ROW_HEIGHT = 22;
const MAX_VISIBLE_ROWS = 8;
const WIDGET_WIDTH = 320;

export class CodeActionController extends Disposable {

	private readonly _element: HTMLElement;
	private readonly _list: HTMLElement;
	private readonly _rows: HTMLElement[] = [];
	private readonly _visibleKey: IContextKey<boolean>;

	private _items: readonly ICodeActionItem[] = [];
	private _selected = 0;
	/** a message replaces the list (a refusal); there is nothing to accept while it shows */
	private _message = '';

	/** every trigger bumps this; a superseded fetch is dropped AND cancelled at the provider */
	private _generation = 0;
	private _requestId = 0;
	private _pending: { handle: number; requestId: number } | null = null;

	constructor(
		private readonly _editor: EditorWidget,
		private readonly _services: IEditorWidgetServices,
		private readonly _getResource: () => URI | undefined
	) {
		super();
		this._element = append(this._editor.view.element, $('.code-action-widget', { style: 'display: none;' }));
		this._element.setAttribute('role', 'listbox');
		this._element.setAttribute('aria-label', 'Code actions');
		this._list = append(this._element, $('.code-action-list'));
		this._visibleKey = new RawContextKey<boolean>('codeActionMenuVisible', false).bindTo(this._services.contextKeyService);

		// the menu belongs to ONE position: an edit or a click elsewhere invalidates it
		this._register(this._editor.onDidEdit(() => this.hide()));
		this._register(addDisposableListener(this._editor.view.element, 'mousedown', event => {
			if (!this._element.contains(event.target as Node)) {
				this.hide();
			}
		}));
		this._register(this._editor.onDidRender(() => {
			if (this.isVisible) {
				this._position();
			}
		}));

		controllers.set(this._editor, this);
		this._register(toDisposable(() => controllers.delete(this._editor)));
		this._register(toDisposable(() => this._element.remove()));
	}

	get isVisible(): boolean {
		return this._element.style.display !== 'none';
	}

	get items(): readonly ICodeActionItem[] {
		return this._items;
	}

	get selectedIndex(): number {
		return this._selected;
	}

	/** Ctrl+.: ask the provider at the cursor. No provider and no actions both show nothing. */
	async trigger(): Promise<void> {
		const model = this._editor.getModel();
		const resource = this._getResource();
		// `precondition: EditorContextKeys.writable` in the reference — a fix cannot be applied
		if (!model || !resource || this._editor.isReadonly) {
			return;
		}
		const languageId = this._services.languageFeatures.languageIdForResource(resource);
		const providers = this._services.languageFeatures.getCodeActionProviders(languageId);
		const provider = providers[0];
		if (!provider) {
			return;
		}

		const generation = ++this._generation;
		const requestId = ++this._requestId;
		if (this._pending) {
			this._services.languageFeatures.cancelRequest(this._pending.handle, this._pending.requestId);
		}
		this._pending = { handle: provider.handle, requestId };

		// the selection, so a fix for a selected range is offered too (the reference's behaviour)
		const selection = this._editor.getSelection();
		let result: readonly IWireCodeAction[] | null = null;
		try {
			result = await provider.provideCodeActions(resource, {
				startLineNumber: selection.startLineNumber,
				startColumn: selection.startColumn,
				endLineNumber: selection.endLineNumber,
				endColumn: selection.endColumn
			}, { trigger: CodeActionTriggerType.Invoke }, requestId);
		} catch {
			result = null;
		}
		this._pending = null;
		if (generation !== this._generation) {
			return;
		}

		const items = toCodeActionItems(result);
		if (items.length === 0) {
			this.hide();
			return;
		}
		this._items = items;
		this._selected = 0;
		this._message = '';
		this._show();
	}

	selectNext(): void {
		this._select(1);
	}

	selectPrevious(): void {
		this._select(-1);
	}

	/** apply the selected action's edit as ONE undo step */
	accept(): void {
		const item = this._items[this._selected];
		if (!this.isVisible || !item) {
			return;
		}
		const model = this._editor.getModel();
		const resource = this._getResource();
		if (!model || !resource) {
			return;
		}

		if (item.edits.length === 0) {
			// a command-only action (the reference runs `action.command` through the command
			// service). Nothing here executes it yet, and saying so beats appearing to do nothing.
			// shortcut: command-carrying code actions are not executed; upgrade when the
			// workbench can run an extension's command with arguments.
			this._showMessage(`"${item.title}" runs a command, which this build cannot execute yet`);
			return;
		}

		const foreign = foreignResources(item.edits, resource);
		if (foreign.length > 0) {
			this._showMessage(`"${item.title}" also edits ${foreign.length === 1 ? foreign[0] : `${foreign.length} other files`}, which is not supported yet`);
			return;
		}

		const prepared = prepareWorkspaceEdit(item.edits, () => model);
		if (!prepared.isApplied) {
			this._showMessage(prepared.rejectReason ?? 'Made no edits');
			return;
		}

		this.hide();
		// one undo step for the whole action, applied back-to-front so an earlier edit cannot
		// shift the ranges of the later ones — the find widget's replace-all rule
		model.pushStackElement();
		for (const group of prepared.groups) {
			for (let i = group.edits.length - 1; i >= 0; i--) {
				const edit = group.edits[i];
				this._editor.replaceRange(edit.range, edit.text ?? '');
			}
		}
		model.pushStackElement();
		this._editor.focus();
	}

	hide(): void {
		if (!this.isVisible) {
			return;
		}
		this._element.style.display = 'none';
		this._visibleKey.set(false);
		this._items = [];
		this._selected = 0;
		this._message = '';
	}

	// ---- the widget (not unit tested, per the house rule)

	private _select(delta: number): void {
		if (!this.isVisible || this._items.length === 0) {
			return;
		}
		this._selected = nextIndex(this._selected, delta, this._items.length);
		this._updateSelection();
	}

	private _showMessage(text: string): void {
		this._items = [];
		this._selected = 0;
		this._message = text;
		this._show();
	}

	private _show(): void {
		this._renderRows();
		this._element.style.display = '';
		this._position();
		this._visibleKey.set(true);
	}

	private _renderRows(): void {
		const labels = this._message ? [this._message] : this._items.map(item => item.title);
		for (let i = 0; i < Math.max(labels.length, this._rows.length); i++) {
			let row = this._rows[i];
			if (!row) {
				row = append(this._list, $('.code-action-row'));
				this._rows[i] = row;
				this._register(addDisposableListener(row, 'mousedown', event => {
					event.preventDefault();
					if (this._items[i]) {
						this._selected = i;
						this.accept();
					}
				}));
			}
			if (i >= labels.length) {
				row.style.display = 'none';
				continue;
			}
			row.style.display = '';
			row.style.top = `${i * ROW_HEIGHT}px`;
			row.textContent = labels[i];
			row.title = labels[i];
			row.setAttribute('role', this._message ? 'status' : 'option');
			row.classList.toggle('message', !!this._message);
		}
		this._list.style.height = `${labels.length * ROW_HEIGHT}px`;
		this._list.style.maxHeight = `${MAX_VISIBLE_ROWS * ROW_HEIGHT}px`;
		this._updateSelection();
	}

	private _updateSelection(): void {
		for (let i = 0; i < this._rows.length; i++) {
			const selected = !this._message && i === this._selected && i < this._items.length;
			this._rows[i].classList.toggle('selected', selected);
			this._rows[i].setAttribute('aria-selected', String(selected));
		}
		// keep the selected row in view when the list scrolls (8 rows visible)
		const top = this._selected * ROW_HEIGHT;
		const maxHeight = MAX_VISIBLE_ROWS * ROW_HEIGHT;
		if (top < this._list.scrollTop) {
			this._list.scrollTop = top;
		} else if (top + ROW_HEIGHT > this._list.scrollTop + maxHeight) {
			this._list.scrollTop = top + ROW_HEIGHT - maxHeight;
		}
	}

	/** below the caret, flipped above the line when there is no room — the suggest widget's rule */
	private _position(): void {
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
		const lineHeight = viewModel.getLineHeight();
		const editorWidth = scrollable.clientWidth + marginWidth;
		const editorHeight = this._editor.view.element.clientHeight;

		const rows = Math.min(this._message ? 1 : this._items.length, MAX_VISIBLE_ROWS);
		const height = rows * ROW_HEIGHT + 4;
		this._element.style.left = `${Math.max(0, Math.min(left, editorWidth - WIDGET_WIDTH - 10))}px`;

		const below = lineTop + lineHeight;
		if (below + height <= editorHeight || lineTop < height) {
			this._element.style.top = `${below}px`;
			this._element.style.bottom = '';
		} else {
			this._element.style.top = '';
			this._element.style.bottom = `${Math.max(0, editorHeight - lineTop) + 2}px`;
		}
	}
}

// ---- the pure half: the wire DTOs become editor-space items (0-based LSP → 1-based editor)

export interface ICodeActionItem {
	readonly title: string;
	readonly kind?: string;
	readonly isPreferred: boolean;
	/** empty for a command-only action */
	readonly edits: readonly IWorkspaceTextEdit[];
	readonly commandId?: string;
}

/** a wire uri back to a URI; every provider here answers with file paths */
function toResource(wire: IWireUri): URI {
	return wire.scheme === 'file' ? URI.file(wire.path) : URI.parse(`${wire.scheme}:${wire.path}`);
}

/** the flat IWorkspaceTextEdit arm of a WorkspaceEdit, converted to editor ranges */
export function toWorkspaceTextEdits(edit: IWireWorkspaceEdit | undefined): IWorkspaceTextEdit[] {
	if (!edit) {
		return [];
	}
	return edit.edits.map(entry => {
		const range = toEditorRange(entry.textEdit.range);
		return {
			resource: toResource(entry.resource),
			range: new Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn),
			text: entry.textEdit.newText
		};
	});
}

/**
 * The provider's actions as menu items. A null result (empty OR failed — the SPI does not
 * distinguish) and an action with neither an edit nor a command both give nothing to offer, so
 * the menu never opens empty. Provider order is kept, except that preferred actions come first,
 * which is the order the reference's menu shows.
 */
export function toCodeActionItems(actions: readonly IWireCodeAction[] | null): ICodeActionItem[] {
	if (!actions) {
		return [];
	}
	const items: ICodeActionItem[] = [];
	for (const action of actions) {
		if (!action.title || (!action.edit && !action.command)) {
			continue;
		}
		items.push({
			title: action.title,
			kind: action.kind,
			isPreferred: !!action.isPreferred,
			edits: toWorkspaceTextEdits(action.edit),
			commandId: action.command?.id
		});
	}
	// a stable partition, so equally-ranked actions stay in provider order
	return [...items.filter(item => item.isPreferred), ...items.filter(item => !item.isPreferred)];
}

/** the resources an action touches other than `resource`, as display names */
export function foreignResources(edits: readonly IWorkspaceTextEdit[], resource: URI): string[] {
	const seen = new Set<string>();
	const names: string[] = [];
	const own = resource.toString();
	for (const edit of edits) {
		const key = edit.resource.toString();
		if (key === own || seen.has(key)) {
			continue;
		}
		seen.add(key);
		names.push(edit.resource.path.split('/').pop() || key);
	}
	return names;
}

/** menu navigation wraps in both directions */
export function nextIndex(index: number, delta: number, length: number): number {
	if (length <= 0) {
		return 0;
	}
	return ((index + delta) % length + length) % length;
}

// ---- the per-widget lookup, the same shape find/suggest/gotoError use

const controllers = new WeakMap<EditorWidget, CodeActionController>();

export function registerCodeActionController(widget: EditorWidget, controller: CodeActionController): void {
	controllers.set(widget, controller);
}

export function codeActionControllerFor(widget: EditorWidget | null): CodeActionController | null {
	return widget ? controllers.get(widget) ?? null : null;
}

// ---- commands & keybindings, with the real ids (codeAction.ts's quickFixCommandId and the four
// action-widget command ids) and the reference's bindings

export const CODE_ACTION_IDS = {
	QuickFix: 'editor.action.quickFix',
	HideCodeActionWidget: 'hideCodeActionWidget',
	SelectPrevCodeAction: 'selectPrevCodeAction',
	SelectNextCodeAction: 'selectNextCodeAction',
	AcceptSelectedCodeAction: 'acceptSelectedCodeAction'
} as const;

/** true while the menu is open, so Escape, the arrows and Enter go to it and not the editor */
export const CodeActionMenuVisibleContext = new RawContextKey<boolean>('codeActionMenuVisible', false);

export function registerCodeActionCommands(getActiveController: () => CodeActionController | null): IDisposable {
	const disposables: IDisposable[] = [];
	const editorFocus = new RawContextKey<boolean>('editorTextFocus', false);

	const register = (
		id: string,
		title: string,
		run: (controller: CodeActionController) => void,
		binding: { primary: number; secondary?: number; when: RawContextKey<boolean> }
	): void => {
		disposables.push(CommandsRegistry.registerCommand(id, () => {
			const controller = getActiveController();
			if (controller) {
				run(controller);
			}
		}));
		disposables.push(CommandMetadata.register({ id, title, category: 'Refactor' }));
		disposables.push(KeybindingsRegistry.registerKeybindingRule({
			id,
			// above EditorCore so the open menu wins Escape, the arrows and Enter
			weight: KeybindingWeight.WorkbenchContrib,
			when: binding.when as never,
			primary: binding.primary,
			secondary: binding.secondary
		}));
	};

	register(CODE_ACTION_IDS.QuickFix, 'Quick Fix...', controller => void controller.trigger(), {
		primary: KeyMod.CtrlCmd | KeyCode.Period,
		when: editorFocus
	});
	register(CODE_ACTION_IDS.HideCodeActionWidget, 'Hide action widget', controller => controller.hide(), {
		primary: KeyCode.Escape,
		secondary: KeyMod.Shift | KeyCode.Escape,
		when: CodeActionMenuVisibleContext
	});
	register(CODE_ACTION_IDS.SelectPrevCodeAction, 'Select previous action', controller => controller.selectPrevious(), {
		primary: KeyCode.UpArrow,
		secondary: KeyMod.CtrlCmd | KeyCode.UpArrow,
		when: CodeActionMenuVisibleContext
	});
	register(CODE_ACTION_IDS.SelectNextCodeAction, 'Select next action', controller => controller.selectNext(), {
		primary: KeyCode.DownArrow,
		secondary: KeyMod.CtrlCmd | KeyCode.DownArrow,
		when: CodeActionMenuVisibleContext
	});
	register(CODE_ACTION_IDS.AcceptSelectedCodeAction, 'Accept selected action', controller => controller.accept(), {
		primary: KeyCode.Enter,
		secondary: KeyMod.CtrlCmd | KeyCode.Period,
		when: CodeActionMenuVisibleContext
	});

	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
