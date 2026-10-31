// src/renderer/workbench/contrib/files/browser/tree/explorerTree.ts — the Explorer tree widget,
// ported in spirit from vs/workbench/browser/parts/views/treeView.ts + the explorer's
// explorerViewer.ts:
//
//   - pooled rows (never recreated per render), absolute positioning, ROW_HEIGHT 22;
//   - indentation 8px per level (workbench.tree.indent default) with the twistie on the left;
//   - the twistie ROTATES on expand (CSS transition, like `monaco-tl-twistie`);
//   - hover actions fade in per row (folder rows: New File / New Folder / Refresh);
//   - keyboard: up/down move, right expands (or first child), left collapses (or parent),
//     enter opens (files) / toggles (folders); selection is single-select.

import { Emitter, Event } from '../../../../../../common/base/common/event.js';
import { Disposable } from '../../../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../../../common/base/common/uri.js';
import { addDisposableListener, append, $ } from '../../../../../base/browser/dom.js';
import { InlineInput, IInlineInputOptions } from '../inlineInput.js';
import { fileIcon } from './fileIcons.js';

export interface IExplorerNode {
	readonly resource: URI;
	readonly name: string;
	readonly isDirectory: boolean;
	/** undefined = not loaded yet */
	children: IExplorerNode[] | undefined;
	expanded: boolean;
}

export function newExplorerNode(resource: URI, name: string, isDirectory: boolean): IExplorerNode {
	return { resource, name, isDirectory, children: isDirectory ? undefined : [], expanded: false };
}

export interface IExplorerRowAction {
	readonly id: string;
	readonly label: string;
	readonly icon: string;
	run(): void;
}

export interface IExplorerTreeDelegate {
	/** load a directory's children (already sorted folders-first) */
	getChildren(node: IExplorerNode): Promise<IExplorerNode[] | null>;
	openFile(node: IExplorerNode): void;
	getActions(node: IExplorerNode): readonly IExplorerRowAction[];
}

const ROW_HEIGHT = 22;
const INDENT = 8;
const TWISTY_WIDTH = 16;

interface IRow {
	element: HTMLElement;
	twisty: HTMLElement;
	icon: HTMLElement;
	label: HTMLElement;
	actions: HTMLElement;
	node: IExplorerNode | null;
	actionIds: string;
	indent: HTMLElement;
}

export class ExplorerTree extends Disposable {

	private readonly _element: HTMLElement;
	private readonly _rowsContainer: HTMLElement;
	private readonly _rows: IRow[] = [];
	private _root: IExplorerNode | null = null;
	private _selection: IExplorerNode | null = null;
	private _inlineInput: InlineInput | null = null;

	private readonly _onDidChangeSelection = this._register(new Emitter<IExplorerNode | undefined>());
	readonly onDidChangeSelection: Event<IExplorerNode | undefined> = this._onDidChangeSelection.event;
	private readonly _onDidFocusChange = this._register(new Emitter<boolean>());
	readonly onDidFocusChange: Event<boolean> = this._onDidFocusChange.event;

	constructor(private readonly _container: HTMLElement, private readonly _delegate: IExplorerTreeDelegate) {
		super();
		this._element = append(_container, $('.explorer-tree', { tabindex: '0' }));
		this._rowsContainer = append(this._element, $('.explorer-rows'));

		this._register(addDisposableListener(this._element, 'keydown', (event: KeyboardEvent) => this._onKeyDown(event)));
		this._register(addDisposableListener(this._element, 'focus', () => {
			this._onDidFocusChange.fire(true);
			this.render();
		}));
		this._register(addDisposableListener(this._element, 'blur', () => {
			this._onDidFocusChange.fire(false);
			this.render();
		}));
	}

	// ---- state

	get root(): IExplorerNode | null {
		return this._root;
	}

	get selection(): IExplorerNode | undefined {
		return this._selection ?? undefined;
	}

	setRoot(root: IExplorerNode | null): void {
		this._root = root;
		this._selection = null;
		this.render();
	}

	setSelection(node: IExplorerNode | null, options?: { reveal?: boolean }): void {
		this._selection = node;
		if (node && options?.reveal !== false) {
			this._revealPath(node);
		}
		this.render();
		this._onDidChangeSelection.fire(node ?? undefined);
	}

	focus(): void {
		this._element.focus();
	}

	hasFocus(): boolean {
		return document.activeElement === this._element || this._element.contains(document.activeElement);
	}

	/** the parent chain from the root to `node` (root first), or null when not in the tree */
	pathOf(node: IExplorerNode): IExplorerNode[] | null {
		if (!this._root) {
			return null;
		}
		const path: IExplorerNode[] = [];
		const walk = (candidate: IExplorerNode): boolean => {
			path.push(candidate);
			if (candidate === node) {
				return true;
			}
			for (const child of candidate.children ?? []) {
				if (walk(child)) {
					return true;
				}
			}
			path.pop();
			return false;
		};
		return walk(this._root) ? path : null;
	}

	findNode(resource: URI): IExplorerNode | null {
		const walk = (node: IExplorerNode): IExplorerNode | null => {
			if (node.resource.toString() === resource.toString()) {
				return node;
			}
			for (const child of node.children ?? []) {
				const found = walk(child);
				if (found) {
					return found;
				}
			}
			return null;
		};
		return this._root ? walk(this._root) : null;
	}

	/** expand every ancestor so the node is visible */
	private _revealPath(node: IExplorerNode): void {
		const path = this.pathOf(node);
		if (!path) {
			return;
		}
		for (const ancestor of path.slice(0, -1)) {
			ancestor.expanded = true;
		}
	}

	// ---- expand/collapse

	async toggle(node: IExplorerNode, expand?: boolean): Promise<void> {
		if (!node.isDirectory) {
			return;
		}
		const shouldExpand = expand ?? !node.expanded;
		if (shouldExpand) {
			if (node.children === undefined) {
				node.children = (await this._delegate.getChildren(node)) ?? undefined;
			}
			node.expanded = true;
		} else {
			node.expanded = false;
		}
		this.render();
	}

	// ---- rendering

	render(): void {
		const visible: { node: IExplorerNode; depth: number }[] = [];
		const collect = (node: IExplorerNode, depth: number): void => {
			visible.push({ node, depth });
			if (node.isDirectory && node.expanded) {
				for (const child of node.children ?? []) {
					collect(child, depth + 1);
				}
			}
		};
		if (this._root) {
			collect(this._root, 0);
		}

		this._rowsContainer.style.height = `${visible.length * ROW_HEIGHT}px`;

		for (let i = 0; i < visible.length; i++) {
			const row = this._row(i);
			this._renderRow(row, visible[i].node, visible[i].depth, i);
		}
		for (let i = visible.length; i < this._rows.length; i++) {
			this._rows[i].element.style.display = 'none';
		}
	}

	private _row(index: number): IRow {
		let row = this._rows[index];
		if (row) {
			return row;
		}
		const element = append(this._rowsContainer, $('.tree-row'));
		const indent = append(element, $('.monaco-tl-indent'));
		const twisty = append(element, $('.monaco-tl-twistie'));
		const contents = append(element, $('.monaco-tl-contents'));
		const icon = append(contents, $('.file-icon'));
		const label = append(contents, $('.label-name'));
		const actions = append(element, $('.row-actions'));
		row = { element, indent, twisty, icon, label, actions, node: null, actionIds: '', };

		this._register(addDisposableListener(element, 'mousedown', (event: MouseEvent) => {
			if (event.button !== 0 || !row!.node) {
				return;
			}
			event.preventDefault();
			this.focus();
			this.setSelection(row!.node, { reveal: false });
		}));
		this._register(addDisposableListener(element, 'dblclick', () => {
			if (row!.node) {
				void this._activate(row!.node);
			}
		}));
		this._register(addDisposableListener(twisty, 'mousedown', (event: MouseEvent) => {
			if (row!.node?.isDirectory) {
				event.preventDefault();
				event.stopPropagation();
				this.focus();
				void this.toggle(row!.node);
			}
		}));

		this._rows[index] = row;
		return row;
	}

	private _renderRow(row: IRow, node: IExplorerNode, depth: number, index: number): void {
		const changed = row.node !== node;
		row.element.style.display = '';
		row.element.style.top = `${index * ROW_HEIGHT}px`;
		row.element.classList.toggle('selected', this._selection === node);
		row.element.classList.toggle('focused', this.hasFocus());

		if (changed) {
			row.node = node;
			row.indent.style.width = `${depth * INDENT}px`;
			row.twisty.style.display = node.isDirectory ? '' : 'none';
			const icon = fileIcon(node.name, node.isDirectory, node.expanded);
			row.icon.innerHTML = icon.svg;
			row.icon.style.color = icon.color;
			row.label.textContent = node.name;
			row.element.title = node.resource.fsPath;
			this._renderActions(row, node);
		}
		row.twisty.classList.toggle('expanded', node.expanded);
		row.twisty.classList.toggle('collapsible', node.isDirectory);
	}

	private _renderActions(row: IRow, node: IExplorerNode): void {
		const actions = this._delegate.getActions(node);
		const ids = actions.map(action => action.id).join(',');
		if (row.actionIds === ids) {
			return;
		}
		row.actionIds = ids;
		row.actions.textContent = '';
		for (const action of actions) {
			const button = append(row.actions, $('.row-action', { title: action.label }, $('span.row-action-icon')));
			(button.querySelector('.row-action-icon') as HTMLElement).innerHTML = action.icon;
			this._register(addDisposableListener(button, 'mousedown', (event: MouseEvent) => {
				event.preventDefault();
				event.stopPropagation();
				action.run();
			}));
		}
	}

	// ---- keyboard

	private _visibleNodes(): IExplorerNode[] {
		const result: IExplorerNode[] = [];
		const collect = (node: IExplorerNode): void => {
			result.push(node);
			if (node.isDirectory && node.expanded) {
				for (const child of node.children ?? []) {
					collect(child);
				}
			}
		};
		if (this._root) {
			collect(this._root);
		}
		return result;
	}

	private _onKeyDown(event: KeyboardEvent): void {
		if (this._inlineInput) {
			return; // the input owns the keyboard
		}
		const visible = this._visibleNodes();
		if (visible.length === 0) {
			return;
		}
		const index = this._selection ? visible.indexOf(this._selection) : -1;

		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				this.setSelection(visible[Math.min(visible.length - 1, index + 1)]);
				break;
			case 'ArrowUp':
				event.preventDefault();
				this.setSelection(visible[Math.max(0, index - 1)]);
				break;
			case 'ArrowRight':
				event.preventDefault();
				if (this._selection?.isDirectory && !this._selection.expanded) {
					void this.toggle(this._selection, true);
				} else if (index >= 0 && index + 1 < visible.length && visible[index + 1] !== undefined) {
					const next = visible[index + 1];
					const parent = this.pathOf(next);
					if (parent && parent[parent.length - 2] === this._selection) {
						this.setSelection(next, { reveal: false });
					}
				}
				break;
			case 'ArrowLeft':
				event.preventDefault();
				if (this._selection?.isDirectory && this._selection.expanded) {
					void this.toggle(this._selection, false);
				} else if (this._selection) {
					const path = this.pathOf(this._selection);
					if (path && path.length > 1) {
						this.setSelection(path[path.length - 2], { reveal: false });
					}
				}
				break;
			case 'Enter':
				event.preventDefault();
				if (this._selection) {
					void this._activate(this._selection);
				}
				break;
		}
	}

	private async _activate(node: IExplorerNode): Promise<void> {
		if (node.isDirectory) {
			await this.toggle(node);
		} else {
			this._delegate.openFile(node);
		}
	}

	// ---- inline input

	/** the input flow's placement helpers */
	visibleIndexOf(node: IExplorerNode): number {
		return this._visibleNodes().indexOf(node);
	}

	depthOf(node: IExplorerNode): number {
		const path = this.pathOf(node);
		return path ? path.length - 1 : 0;
	}

	/** shows the input at a node's row (rename) or right below it (create) */
	showInput(options: Omit<IInlineInputOptions, 'container' | 'top' | 'left' | 'width'> & { rowIndex: number; depth: number }): InlineInput {
		this._inlineInput?.cancel();
		const input = InlineInput.show({
			...options,
			container: this._element,
			top: (options.rowIndex + 1) * ROW_HEIGHT,
			left: (options.depth + 1) * INDENT + TWISTY_WIDTH,
			width: Math.max(120, this._element.clientWidth - (options.depth + 2) * INDENT - TWISTY_WIDTH - 16)
		});
		this._inlineInput = input;
		const disposable = input.onDidDispose(() => {
			disposable.dispose();
			this._inlineInput = null;
			this.focus();
		});
		return input;
	}

	get inlineInput(): InlineInput | null {
		return this._inlineInput;
	}

	override dispose(): void {
		this._inlineInput?.cancel();
		super.dispose();
	}
}
