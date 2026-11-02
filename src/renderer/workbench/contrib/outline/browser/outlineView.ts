// src/renderer/workbench/contrib/outline/browser/outlineView.ts — the Outline view: the active
// file's symbols as an indented tree, clicking a row reveals the symbol.
//
// Ported in shape from vs/workbench/contrib/outline/browser/{outlinePane,outline.contribution}.ts.
// It owns no fetch: the symbols come from the active editor's BreadcrumbsController, which already
// debounces the provider and refreshes on every document change, so the outline and the crumbs can
// never disagree. The rows come from symbolTree.ts's flattenSymbolTree (tested there).
//
// shortcut: a flat list of depth-indented rows instead of a collapsible tree widget — no
// expand/collapse, no virtualization, no filter box, no "follow cursor" highlight. Upgrade when
// there is a real tree widget (the explorer's list is bespoke too); virtualize if a file ever has
// enough symbols for the row count to matter.

import { Event } from '../../../../../common/base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../../common/base/common/lifecycle.js';
import { flattenSymbolTree, symbolKindName } from '../../../../../common/editor/common/model/symbolTree.js';
import { addDisposableListener, append, $ } from '../../../../base/browser/dom.js';
import type { BreadcrumbsController } from '../../../../editor/contrib/breadcrumbs/breadcrumbsWidget.js';
import { CommandMetadata, CommandsRegistry } from '../../../../platform/commands/common/commands.js';

export interface IOutlineViewOptions {
	/** the active editor's breadcrumbs controller — null when no text editor is active */
	readonly getActiveController: () => BreadcrumbsController | null;
	/** re-bind on a tab switch; `editorService.onDidOpenEditor` is the one the workbench has */
	readonly onDidChangeActiveEditor: Event<unknown>;
	/** `outline.focus` shows the composite before focusing it */
	readonly showOutline?: () => void;
}

/** indentation per level, matching the explorer's tree rows */
const INDENT_PX = 12;

export class OutlineView extends Disposable {

	readonly element: HTMLElement;

	private readonly _list: HTMLElement;
	private readonly _rowDisposables = this._register(new DisposableStore());
	private _symbolsListener: IDisposable | undefined;

	constructor(private readonly _options: IOutlineViewOptions) {
		super();
		this.element = $('.outline-view');
		this._list = append(this.element, $('.outline-list', { role: 'tree', 'aria-label': 'Outline' }));

		this._register(this._options.onDidChangeActiveEditor(() => this._bind()));
		this._register(toDisposable(() => this._symbolsListener?.dispose()));
		this._register(CommandsRegistry.registerCommand(OUTLINE_IDS.Focus, () => this.focus()));
		this._register(CommandMetadata.register({ id: OUTLINE_IDS.Focus, title: 'Focus on Outline View', category: 'View' }));
		this._bind();
	}

	focus(): void {
		this._options.showOutline?.();
		(this._list.firstElementChild as HTMLElement | null)?.focus();
	}

	/** the rendered row labels, in order — for the dev hook */
	getRowLabels(): string[] {
		return Array.from(this._list.querySelectorAll('.outline-name')).map(node => node.textContent ?? '');
	}

	/** follow whichever editor is active now: its controller owns the symbols */
	private _bind(): void {
		this._symbolsListener?.dispose();
		const controller = this._options.getActiveController();
		this._symbolsListener = controller?.onDidChangeSymbols(() => this._render());
		this._render();
	}

	private _render(): void {
		this._rowDisposables.clear();
		this._list.textContent = '';

		const controller = this._options.getActiveController();
		const rows = controller ? flattenSymbolTree(controller.getTree()) : [];
		if (rows.length === 0) {
			// no editor, no provider, or a provider with nothing to say — all the same empty view
			append(this._list, $('.outline-empty', {}, 'No symbols found.'));
			return;
		}

		for (const row of rows) {
			const element = append(this._list, $('.outline-row', {
				role: 'treeitem',
				'aria-level': String(row.depth + 1),
				tabindex: '0'
			}));
			element.style.paddingLeft = `${row.depth * INDENT_PX}px`;
			append(element, $('span.outline-name', {}, row.symbol.name));
			append(element, $('span.outline-kind', {}, symbolKindName(row.symbol.kind)));
			const reveal = (): void => controller?.reveal(row.symbol);
			this._rowDisposables.add(addDisposableListener(element, 'click', reveal));
			this._rowDisposables.add(addDisposableListener(element, 'keydown', (event: KeyboardEvent) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					reveal();
				}
			}));
		}
	}
}

/** the real id from the reference's outline.contribution.ts (a view focusCommand, no keybinding) */
export const OUTLINE_IDS = {
	Focus: 'outline.focus'
} as const;

/** creates the view and registers `outline.focus`; the caller mounts `view.element` in the sidebar */
export function registerOutlineView(options: IOutlineViewOptions): OutlineView {
	return new OutlineView(options);
}
