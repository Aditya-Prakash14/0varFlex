// src/renderer/workbench/browser/layout.ts — the WorkbenchLayout: creates the parts, owns the
// geometry pass, persists part state. A much smaller copy of vs/workbench/browser/layout.ts:
// fixed arrangement (no grid, no re-docking), no LayoutClasses yet — the CSS-class toggling
// idea from the reference arrives with the theme hooks.
//
// Geometry:  title (30) | content (activity 48 + hSplit[sidebar | vSplit[editor | panel]]) | status (22)

import { append, position, size, $ } from '../../base/browser/dom.js';
import { Disposable } from '../../../common/base/common/lifecycle.js';
import { IView, Orientation, SplitView } from '../../base/browser/ui/splitview/splitview.js';
import type { ILogService } from '../../../common/platform/log/common/log.js';
import { IContextKey } from '../../platform/contextkey/common/contextkey.js';
import { ContextKeyService } from '../../platform/contextkey/common/contextKeyService.js';
import type { ICommandService } from '../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../common/platform/configuration/common/configuration.js';
import { IStorageService, StorageScope } from '../../../common/platform/storage/common/storage.js';
import { EditorOptionsService } from '../../editor/browser/config.js';
import { CodeEditorService } from '../services/editor/browser/codeEditorService.js';
import type { LanguageFeaturesService } from '../api/common/mainThreadLanguageFeatures.js';
import type { MarkerService } from '../services/markers/browser/markerService.js';
import { PanelVisibleContext, SidebarVisibleContext } from '../contrib/layout/common/layoutContextKeys.js';
import { Part } from './part.js';
import { TitlebarPart } from './parts/titlebar/titlebarPart.js';
import { ActivityBarPart } from './parts/activitybar/activitybarPart.js';
import { SidebarPart } from './parts/sidebar/sidebarPart.js';
import { EditorPart } from './parts/editor/editorPart.js';
import { PanelPart } from './parts/panel/panelPart.js';
import { StatusbarAlignment, StatusbarPart } from './parts/statusbar/statusbarPart.js';

export interface IWorkbenchLayoutState {
	sidebar: { width: number; visible: boolean };
	panel: { height: number; visible: boolean };
}

export const DEFAULT_WORKBENCH_LAYOUT_STATE: IWorkbenchLayoutState = {
	sidebar: { width: 300, visible: true },
	panel: { height: 240, visible: false }
};

export interface IWorkbenchLayoutServices {
	readonly logService: ILogService;
	readonly storage: IStorageService;
	readonly configuration: IConfigurationService;
	readonly contextKeyService: ContextKeyService;
	readonly commandService: ICommandService;
	readonly editorOptions: EditorOptionsService;
	readonly codeEditorService: CodeEditorService;
	readonly languageFeatures: LanguageFeaturesService;
	readonly markerService: MarkerService;
}

/** Adapts a Part to an IView of a SplitView. Hidden parts can hold no space (min and max 0). */
class PartView implements IView {

	constructor(
		readonly element: HTMLElement,
		private readonly _part: Part,
		private readonly _axis: Orientation
	) { }

	get minimumSize(): number {
		if (!this._part.visible) {
			return 0;
		}
		return this._axis === Orientation.HORIZONTAL ? this._part.minimumWidth : this._part.minimumHeight;
	}

	get maximumSize(): number {
		if (!this._part.visible) {
			return 0;
		}
		return this._axis === Orientation.HORIZONTAL ? this._part.maximumWidth : this._part.maximumHeight;
	}

	layout(size: number, offset: number, orthogonalSize: number): void {
		if (this._axis === Orientation.HORIZONTAL) {
			this._part.layout(size, orthogonalSize, 0, offset);
		} else {
			this._part.layout(orthogonalSize, size, offset, 0);
		}
	}
}

/** A plain container view that hosts a nested SplitView (the editor column). */
class SplitLayoutView implements IView {

	constructor(
		readonly element: HTMLElement,
		private readonly _child: SplitView,
		private readonly _minimumSize: number
	) { }

	get minimumSize(): number { return this._minimumSize; }
	get maximumSize(): number { return Number.POSITIVE_INFINITY; }

	layout(size: number, offset: number, orthogonalSize: number): void {
		position(this.element, 0, offset);
		// the child is the vertical editor column: its main axis is the height (our orthogonal)
		this._child.layout(orthogonalSize, size);
	}
}

export class WorkbenchLayout extends Disposable {

	static readonly TITLEBAR_HEIGHT = 30;
	static readonly STATUSBAR_HEIGHT = 22;
	static readonly ACTIVITYBAR_WIDTH = 48;

	readonly titlebar: TitlebarPart;
	readonly activitybar: ActivityBarPart;
	readonly sidebar: SidebarPart;
	readonly editor: EditorPart;
	readonly panel: PanelPart;
	readonly statusbar: StatusbarPart;

	private readonly _hSplit: SplitView;
	private readonly _vSplit: SplitView;
	private readonly _contentElement: HTMLElement;
	private readonly _hSplitContainerElement: HTMLElement;

	private _state: IWorkbenchLayoutState;
	private _stateApplied = false;
	private readonly _sidebarVisibleKey: IContextKey<boolean>;
	private readonly _panelVisibleKey: IContextKey<boolean>;

	constructor(container: HTMLElement, private readonly _services: IWorkbenchLayoutServices) {
		super();

		this._state = {
			sidebar: { width: DEFAULT_WORKBENCH_LAYOUT_STATE.sidebar.width, visible: DEFAULT_WORKBENCH_LAYOUT_STATE.sidebar.visible },
			panel: { height: DEFAULT_WORKBENCH_LAYOUT_STATE.panel.height, visible: DEFAULT_WORKBENCH_LAYOUT_STATE.panel.visible }
		};

		// ---- the fixed arrangement, built from nested split views:
		// .workbench
		//   .part.titlebar
		//   .content  (hSplit: sidebar | editor column)
		//     .part.activitybar
		//     vSplit: editor | panel
		//   .part.statusbar

		const titlebarContainer = append(container, $('div'));
		this.titlebar = this._register(new TitlebarPart());
		this.titlebar.create(titlebarContainer);

		const contentContainer = append(container, $('.content'));
		this._contentElement = contentContainer;

		const activitybarContainer = append(contentContainer, $('div'));
		this.activitybar = this._register(new ActivityBarPart());
		this.activitybar.create(activitybarContainer);

		// the split area sits next to the activity bar inside the content row
		const splitContainer = append(contentContainer, $('.split-area'));
		this._hSplitContainerElement = splitContainer;

		this._hSplit = this._register(new SplitView(splitContainer, { orientation: Orientation.HORIZONTAL, proportionalLayout: false }));

		const sidebarContainer = $('div');
		this.sidebar = this._register(new SidebarPart());
		this.sidebar.create(sidebarContainer);
		this._hSplit.addView(new PartView(sidebarContainer, this.sidebar, Orientation.HORIZONTAL), this._state.sidebar.width);

		const editorColumnContainer = $('div');
		this._vSplit = this._register(new SplitView(editorColumnContainer, { orientation: Orientation.VERTICAL, proportionalLayout: false, resetIndex: 1 }));
		this._hSplit.addView(new SplitLayoutView(editorColumnContainer, this._vSplit, 300), 0);

		const editorContainer = $('div');
		this.editor = this._register(new EditorPart({
			options: _services.editorOptions,
			configuration: _services.configuration,
			contextKeyService: _services.contextKeyService,
			codeEditorService: _services.codeEditorService,
			commandService: _services.commandService,
			languageFeatures: _services.languageFeatures,
			markers: _services.markerService
		}));
		this.editor.create(editorContainer);
		this._vSplit.addView(new PartView(editorContainer, this.editor, Orientation.VERTICAL), 0);

		const panelContainer = $('div');
		this.panel = this._register(new PanelPart());
		this.panel.create(panelContainer);
		this._vSplit.addView(new PartView(panelContainer, this.panel, Orientation.VERTICAL), 0);

		const statusbarContainer = append(container, $('div'));
		this.statusbar = this._register(new StatusbarPart());
		this.statusbar.create(statusbarContainer);

		// placeholder entries — these become live in 07/08/10
		this.statusbar.addEntry('remote', { text: '⌥', alignment: StatusbarAlignment.LEFT, priority: 0 });
		this.statusbar.addEntry('position', { text: 'Ln 1, Col 1', alignment: StatusbarAlignment.RIGHT, priority: 30 });
		this.statusbar.addEntry('encoding', { text: 'UTF-8', alignment: StatusbarAlignment.RIGHT, priority: 20 });
		this.statusbar.addEntry('eol', { text: 'LF', alignment: StatusbarAlignment.RIGHT, priority: 10 });

		// visibility from state (before the first layout pass sizes the splits)
		this.sidebar.setVisible(this._state.sidebar.visible);
		this.panel.setVisible(this._state.panel.visible);

		// context keys track part visibility (bound at startup, updated on every change)
		this._sidebarVisibleKey = SidebarVisibleContext.bindTo(_services.contextKeyService);
		this._panelVisibleKey = PanelVisibleContext.bindTo(_services.contextKeyService);
		this._updateContextKeys();

		// sash changes → persisted state
		this._register(this._hSplit.onDidSashChange(sizes => {
			if (this.sidebar.visible) {
				this._state.sidebar.width = sizes[0];
				this._services.storage.store('workbench.layout.sidebar.width', sizes[0], StorageScope.APPLICATION);
			}
		}));
		this._register(this._vSplit.onDidSashChange(sizes => {
			if (this.panel.visible) {
				this._state.panel.height = sizes[1];
				this._services.storage.store('workbench.layout.panel.height', sizes[1], StorageScope.APPLICATION);
			}
		}));
	}

	// ---- the single geometry pass: everything in pixels, writes only

	layout(width: number, height: number): void {
		const titleHeight = WorkbenchLayout.TITLEBAR_HEIGHT;
		const statusHeight = WorkbenchLayout.STATUSBAR_HEIGHT;
		const contentHeight = Math.max(0, height - titleHeight - statusHeight);

		this.titlebar.layout(width, titleHeight, 0, 0);
		this.statusbar.layout(width, statusHeight, height - statusHeight, 0);

		const contentWidth = Math.max(0, width - WorkbenchLayout.ACTIVITYBAR_WIDTH);
		this.activitybar.layout(WorkbenchLayout.ACTIVITYBAR_WIDTH, contentHeight, 0, 0);

		// the split area (and therefore every split view coordinate) starts after the activity bar
		size(this._contentElement, width, contentHeight);
		position(this._contentElement, titleHeight, 0);
		size(this._hSplitContainerElement, contentWidth, contentHeight);
		position(this._hSplitContainerElement, 0, WorkbenchLayout.ACTIVITYBAR_WIDTH);
		this._hSplit.layout(contentWidth, contentHeight);

		// the loaded state sizing lands after the first pass, when the split views have real
		// container dimensions to move space within
		if (!this._stateApplied) {
			this._stateApplied = true;
			this._hSplit.setViewSize(0, this.sidebar.visible ? this._state.sidebar.width : 0);
			this._vSplit.setViewSize(1, this.panel.visible ? this._state.panel.height : 0);
		}
	}

	// ---- visibility

	toggleSidebar(): void {
		this.setSidebarVisible(!this.sidebar.visible);
	}

	setSidebarVisible(visible: boolean): void {
		if (this.sidebar.visible === visible) {
			return;
		}
		// hidden parts must be size 0 in the split math or the sash clamps wrong
		const width = visible ? Math.max(this._state.sidebar.width, this.sidebar.minimumWidth) : 0;
		this.sidebar.setVisible(visible);
		this._state.sidebar.visible = visible;
		this._sidebarVisibleKey.set(visible);
		this._hSplit.setViewSize(0, width);
		this._services.storage.store('workbench.layout.sidebar.visible', visible, StorageScope.APPLICATION);
	}

	togglePanel(): void {
		this.setPanelVisible(!this.panel.visible);
	}

	setPanelVisible(visible: boolean): void {
		if (this.panel.visible === visible) {
			return;
		}
		const height = visible ? Math.max(this._state.panel.height, this.panel.minimumHeight) : 0;
		this.panel.setVisible(visible);
		this._state.panel.visible = visible;
		this._panelVisibleKey.set(visible);
		this._vSplit.setViewSize(1, height);
		this._services.storage.store('workbench.layout.panel.visible', visible, StorageScope.APPLICATION);
	}

	// ---- persisted state (storage) + explicit settings precedence
	// settings win over remembered state when explicitly set, then storage, then defaults

	load(): void {
		const storage = this._services.storage;

		const storedSidebarWidth = storage.getNumber('workbench.layout.sidebar.width', StorageScope.APPLICATION);
		if (storedSidebarWidth !== undefined) {
			this._state.sidebar.width = storedSidebarWidth;
		}
		const sidebarVisibleSetting = this._services.configuration.inspect<boolean>('workbench.sideBar.visible').userValue;
		const storedSidebarVisible = storage.getBoolean('workbench.layout.sidebar.visible', StorageScope.APPLICATION);
		if (sidebarVisibleSetting !== undefined) {
			this._state.sidebar.visible = sidebarVisibleSetting;
		} else if (storedSidebarVisible !== undefined) {
			this._state.sidebar.visible = storedSidebarVisible;
		}

		const storedPanelHeight = storage.getNumber('workbench.layout.panel.height', StorageScope.APPLICATION);
		if (storedPanelHeight !== undefined) {
			this._state.panel.height = storedPanelHeight;
		}
		const panelVisibleSetting = this._services.configuration.inspect<boolean>('workbench.panel.visible').userValue;
		const storedPanelVisible = storage.getBoolean('workbench.layout.panel.visible', StorageScope.APPLICATION);
		if (panelVisibleSetting !== undefined) {
			this._state.panel.visible = panelVisibleSetting;
		} else if (storedPanelVisible !== undefined) {
			this._state.panel.visible = storedPanelVisible;
		}

		this.sidebar.setVisible(this._state.sidebar.visible);
		this.panel.setVisible(this._state.panel.visible);
		this._updateContextKeys();
	}

	private _updateContextKeys(): void {
		this._sidebarVisibleKey.set(this.sidebar.visible);
		this._panelVisibleKey.set(this.panel.visible);
	}
}
