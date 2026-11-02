// src/renderer/editor/contrib/breadcrumbs/breadcrumbsWidget.ts — the breadcrumbs strip at the top
// of the editor, and the per-widget document-symbol fetch behind it.
//
// Ported in shape from vs/workbench/browser/parts/editor/breadcrumbsControl.ts (the strip and the
// `breadcrumbs.*` commands) over vs/workbench/contrib/codeEditor/browser/outline's OutlineModel
// (the provider fetch). The tree building and the "which symbols contain the cursor" answer are in
// common/editor/common/model/symbolTree.ts and tested there; this file is the fetch, the DOM and
// the reveal. The outline view (workbench/contrib/outline) reads the SAME controller, so a file's
// symbols are fetched once and both surfaces agree.
//
// shortcut: the strip is an overlay on the editor's view element (the find widget's attachment
// pattern) rather than a row in the editor group's layout, so it floats over the first line
// instead of pushing the text down. Upgrade when the editor group reserves vertical space for
// decorations above the editor.
// shortcut: no file/folder crumbs, no picker dropdown per crumb, no crumb focus navigation
// (breadcrumbs.focus / focusNext / focusPreviousWithPicker), so only the real `breadcrumbs.toggle`
// command exists. Upgrade when there is a tree picker widget to drop down.

import { Emitter, Event } from '../../../../common/base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../common/base/common/lifecycle.js';
import { Position } from '../../../../common/editor/common/core/position.js';
import { URI } from '../../../../common/base/common/uri.js';
import {
	breadcrumbPathFor, buildSymbolTree, DocumentSymbol, OutlineNode, symbolKindName
} from '../../../../common/editor/common/model/symbolTree.js';
import type { IWireDocumentSymbol } from '../../../../common/platform/extensions/common/extensionHostProtocol.js';
import type { ILanguageFeaturesService } from '../../../workbench/api/common/mainThreadLanguageFeatures.js';
import { toEditorRange } from '../../../workbench/api/common/mainThreadLanguageFeatures.js';
import { append, $ } from '../../../base/browser/dom.js';
import { CommandMetadata, CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { Selection } from '../../browser/core/selection.js';
import type { EditorWidget } from '../../browser/editorWidget.js';

/**
 * One fetch per 300ms of quiet typing. The reference's LanguageFeatureRequestDelays starts at
 * ~350ms and adapts to how slow the provider actually is; a fixed delay is enough here and 300ms
 * is below the ~400ms at which a stale breadcrumb starts to feel wrong, while still collapsing a
 * burst of keystrokes into one request.
 */
export const SYMBOL_FETCH_DEBOUNCE_MS = 300;

/**
 * Wire symbols (0-based LSP ranges) to the editor's 1-based symbols, children included. This is
 * the whole 0-vs-1 boundary for the outline: get it wrong and every reveal and every crumb is one
 * line/column off.
 */
export function toOutlineSymbols(wire: readonly IWireDocumentSymbol[] | null | undefined): DocumentSymbol[] {
	if (!wire) {
		return [];
	}
	return wire.map(symbol => ({
		name: symbol.name,
		detail: symbol.detail,
		kind: symbol.kind,
		range: toEditorRange(symbol.range),
		selectionRange: toEditorRange(symbol.selectionRange),
		children: symbol.children ? toOutlineSymbols(symbol.children) : undefined
	}));
}

/** identity of a rendered path, so cursor moves inside the same symbol do not rebuild the DOM */
export function breadcrumbPathKey(path: readonly DocumentSymbol[]): string {
	return path.map(symbol => `${symbol.kind}:${symbol.name}@${symbol.range.startLineNumber}`).join('/');
}

export class BreadcrumbsController extends Disposable {

	private readonly _element: HTMLElement;
	private readonly _onDidChangeSymbols = this._register(new Emitter<void>());
	/** fires when the symbol tree is replaced — the outline view renders off this */
	readonly onDidChangeSymbols: Event<void> = this._onDidChangeSymbols.event;

	private _tree: readonly OutlineNode[] = [];
	private _renderedKey: string | undefined;
	private _timer: ReturnType<typeof setTimeout> | undefined;
	private _requestId = 0;
	private _pending: { handle: number; requestId: number } | undefined;
	private _enabled = true;

	constructor(
		private readonly _editor: EditorWidget,
		private readonly _languageFeatures: ILanguageFeaturesService,
		private readonly _getResource: () => URI | undefined
	) {
		super();
		this._element = append(this._editor.view.element, $('.editor-breadcrumbs', {
			role: 'navigation',
			'aria-label': 'Breadcrumbs'
		}));
		this._element.style.display = 'none';

		const model = this._editor.getModel();
		if (model) {
			this._register(model.onDidChangeContent(() => this._scheduleFetch()));
		}
		// Extension activation is asynchronous, so the provider for this language almost always
		// registers AFTER this editor opened. Without this the immediate fetch below finds nothing,
		// caches an empty tree, and the outline stays empty until the user happens to type.
		this._register(this._languageFeatures.onDidChangeProviders(() => this._scheduleFetch()));
		// the widget has no cursor event; a cursor move always schedules a render, which is what
		// sticky scroll follows too
		this._register(this._editor.onDidRender(() => this._render()));
		this._register(toDisposable(() => {
			if (this._timer !== undefined) {
				clearTimeout(this._timer);
			}
		}));

		// the first fetch is immediate: opening a file should not show an empty strip for 300ms
		void this._fetch();
	}

	/** the symbol tree for this editor's document — what the outline view renders */
	getTree(): readonly OutlineNode[] {
		return this._tree;
	}

	/** the symbols containing the cursor, outermost first — for the tests and the dev hook */
	getPath(): DocumentSymbol[] {
		return breadcrumbPathFor(this._tree, this._editor.getSelection().getPosition());
	}

	isEnabled(): boolean {
		return this._enabled;
	}

	/** `breadcrumbs.toggle` — the reference stores this in a setting; we have no such setting yet */
	toggle(): void {
		this._enabled = !this._enabled;
		this._renderedKey = undefined;
		this._render();
	}

	/** select a symbol's NAME and scroll to it — what a crumb and an outline row both do */
	reveal(symbol: DocumentSymbol): void {
		const { startLineNumber, startColumn, endLineNumber, endColumn } = symbol.selectionRange;
		this._editor.setSelection(new Selection(startLineNumber, startColumn, endLineNumber, endColumn));
		// centred: a symbol revealed at the very bottom of the viewport shows none of its body
		this._editor.revealPosition(new Position(startLineNumber, startColumn), 'center');
		this._editor.focus();
	}

	private _scheduleFetch(): void {
		if (this._timer !== undefined) {
			clearTimeout(this._timer);
		}
		this._timer = setTimeout(() => {
			this._timer = undefined;
			void this._fetch();
		}, SYMBOL_FETCH_DEBOUNCE_MS);
	}

	private async _fetch(): Promise<void> {
		const resource = this._getResource();
		const adapter = resource
			? this._languageFeatures.getDocumentSymbolProviders(this._languageFeatures.languageIdForResource(resource))[0]
			: undefined;
		if (!resource || !adapter) {
			// no provider for this language: empty, and nothing on screen
			this._setTree([]);
			return;
		}

		// nothing supersedes automatically — tell the provider its last answer is no longer wanted
		if (this._pending) {
			this._languageFeatures.cancelRequest(this._pending.handle, this._pending.requestId);
		}
		const requestId = ++this._requestId;
		this._pending = { handle: adapter.handle, requestId };
		let wire: readonly IWireDocumentSymbol[] | null = null;
		try {
			wire = await adapter.provideDocumentSymbols(resource, requestId);
		} catch {
			wire = null; // the adapter answers null for failure; a throw is the same outcome
		}
		if (requestId !== this._requestId) {
			return; // superseded while in flight
		}
		this._pending = undefined;
		this._setTree(buildSymbolTree(toOutlineSymbols(wire)));
	}

	private _setTree(tree: readonly OutlineNode[]): void {
		this._tree = tree;
		this._renderedKey = undefined;
		this._render();
		this._onDidChangeSymbols.fire();
	}

	private _render(): void {
		const path = this._enabled ? this.getPath() : [];
		const key = breadcrumbPathKey(path);
		if (key === this._renderedKey) {
			return;
		}
		this._renderedKey = key;
		this._element.textContent = '';
		this._element.style.display = path.length > 0 ? '' : 'none';
		for (let i = 0; i < path.length; i++) {
			if (i > 0) {
				append(this._element, $('span.breadcrumb-separator', {}, '›'));
			}
			const symbol = path[i];
			const crumb = append(this._element, $('span.breadcrumb-item', {
				title: `${symbol.name} (${symbolKindName(symbol.kind)})`,
				tabindex: '0'
			}, symbol.name));
			// the listeners die with the node; the node dies on the next render
			crumb.addEventListener('click', () => this.reveal(symbol));
		}
	}
}

// ---- the per-widget lookup, the same shape the other contribs use

const controllers = new WeakMap<EditorWidget, BreadcrumbsController>();

export function registerBreadcrumbsController(widget: EditorWidget, controller: BreadcrumbsController): void {
	controllers.set(widget, controller);
}

export function breadcrumbsControllerFor(widget: EditorWidget | null): BreadcrumbsController | null {
	return widget ? controllers.get(widget) ?? null : null;
}

/** the real id from the reference's breadcrumbsControl.ts (it has no default keybinding) */
export const BREADCRUMBS_IDS = {
	Toggle: 'breadcrumbs.toggle'
} as const;

export function registerBreadcrumbsCommands(getActiveController: () => BreadcrumbsController | null): IDisposable {
	const disposables: IDisposable[] = [
		CommandsRegistry.registerCommand(BREADCRUMBS_IDS.Toggle, () => {
			getActiveController()?.toggle();
		}),
		CommandMetadata.register({ id: BREADCRUMBS_IDS.Toggle, title: 'Toggle Breadcrumbs', category: 'View' })
	];
	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
