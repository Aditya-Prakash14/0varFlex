// src/renderer/workbench/contrib/files/browser/explorerView.ts — the Explorer view inside the
// sidebar composite: the workspace label (the open folder's name, bold like the real explorer's
// root label), the tree container, and the focus context key the tree commands are scoped on.
// The real view is a TreeView contribution with a title toolbar; ours is the shape.

import { append, $ } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../../common/base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ExplorerFocusContext } from './fileCommands.js';
import type { ExplorerService } from './explorerService.js';

export interface IExplorerViewServices {
	readonly commandService: ICommandService;
	readonly contextKeyService: IContextKeyService;
}

export class ExplorerView extends Disposable {

	readonly element: HTMLElement;
	/** the container ExplorerService mounts the tree in */
	readonly treeContainer: HTMLElement;

	private readonly _workspaceLabel: HTMLElement;
	private readonly _focusKey: IContextKey<boolean>;
	private _service: ExplorerService | undefined;

	constructor(container: HTMLElement, services: IExplorerViewServices) {
		super();
		this.element = append(container, $('.explorer-view'));
		this._workspaceLabel = append(this.element, $('.explorer-workspace-label'));
		this.treeContainer = append(this.element, $('.explorer-tree-container'));
		this._focusKey = ExplorerFocusContext.bindTo(services.contextKeyService);
		void services.commandService;
	}

	/** the service arrives after construction (the view owns the container it mounts in) */
	attach(service: ExplorerService): void {
		this._service = service;
		this._register(service.onDidChangeFolder(uri => this.setFolderName(uri ? service.root?.name : undefined)));
		this._register(service.tree.onDidFocusChange(focused => this._focusKey.set(focused)));
		this.setFolderName(service.root?.name);
	}

	setFolderName(name: string | undefined): void {
		this._workspaceLabel.textContent = name ? name.toUpperCase() : '';
		this._workspaceLabel.classList.toggle('empty', !name);
	}
}
