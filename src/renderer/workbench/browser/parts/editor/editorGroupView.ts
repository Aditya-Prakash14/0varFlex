// src/renderer/workbench/browser/parts/editor/editorGroupView.ts — one editor group: the tab
// strip (title area), the pane container and the empty-state watermark. Ported in shape from
// vs/workbench/browser/parts/editor/editorGroupView.ts + the tabs control:
//
//   - tabs live as DOM nodes created once per open editor; dirty is a CLASS flip (the dot ⇄ ✕
//     swap is CSS-driven — nodes are never recreated on hover);
//   - the active tab only looks active; the GROUP being inactive dims it (editorgroupview.css);
//   - close requests (✕, middle click) are events — the service owns the dirty confirmation;
//   - an EMPTY group shows the watermark with real command hints.

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { Disposable, IDisposable } from '../../../../../common/base/common/lifecycle.js';
import { addDisposableListener, append, $ } from '../../../../base/browser/dom.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { OPEN_SETTINGS_JSON_ID } from '../../../contrib/configuration/browser/configurationActions.js';
import { SHOW_ALL_COMMANDS_ID } from '../../../contrib/layout/browser/layoutActions.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorPanes, IPaneServices } from './editorPanes.js';

export interface IEditorGroupViewServices extends IPaneServices {
	readonly commandService: ICommandService;
}

interface ITabEntry {
	readonly element: HTMLElement;
	readonly label: HTMLElement;
	readonly disposables: IDisposable[];
}

const TITLE_HEIGHT = 35;

interface IWatermarkHint {
	readonly label: string;
	readonly keys: string[];
	readonly command?: string;
	readonly disabledReason?: string;
}

/** ported from editorGroupWatermark.ts: real commands for the entries this course has */
const WATERMARK_HINTS: IWatermarkHint[] = [
	{ label: 'Show All Commands', keys: ['⇧', '⌘', 'P'], command: SHOW_ALL_COMMANDS_ID },
	{ label: 'Open File', keys: ['⌘', 'P'], disabledReason: 'Quick Open arrives with the file explorer (A1)' },
	{ label: 'Open Settings', keys: ['⌘', ','], command: OPEN_SETTINGS_JSON_ID }
];

export class EditorGroupView extends Disposable {

	readonly element: HTMLElement;
	readonly onDidActivate: Event<void>;
	readonly onDidActiveEditorChange: Event<EditorInput | null>;
	readonly onDidRequestCloseEditor: Event<EditorInput>;

	private readonly _onDidActivate = this._register(new Emitter<void>());
	private readonly _onDidActiveEditorChange = this._register(new Emitter<EditorInput | null>());
	private readonly _onDidRequestCloseEditor = this._register(new Emitter<EditorInput>());

	private readonly _titleArea: HTMLElement;
	private readonly _tabsElement: HTMLElement;
	private readonly _contentElement: HTMLElement;
	private readonly _watermark: HTMLElement;
	private readonly _panes: EditorPanes;

	private readonly _tabs = new Map<EditorInput, ITabEntry>();
	private _editors: EditorInput[] = [];
	private _active: EditorInput | null = null;
	private _width = 0;
	private _height = 0;

	constructor(readonly id: number, private readonly _services: IEditorGroupViewServices) {
		super();
		this.element = $('.editor-group');
		this.element.dataset.groupId = String(id);

		this._titleArea = append(this.element, $('.editor-group-title'));
		this._tabsElement = append(this._titleArea, $('.tabs-container'));
		this._contentElement = append(this.element, $('.editor-group-content'));
		this._panes = this._register(new EditorPanes(this._contentElement));
		this._watermark = this._createWatermark();

		// any click inside the group activates it (the part dims inactive groups)
		this._register(addDisposableListener(this.element, 'mousedown', () => this._onDidActivate.fire(), true));

		this.onDidActivate = this._onDidActivate.event;
		this.onDidActiveEditorChange = this._onDidActiveEditorChange.event;
		this.onDidRequestCloseEditor = this._onDidRequestCloseEditor.event;
	}

	// ---- opening / closing

	async openEditor(input: EditorInput, options?: { focus?: boolean }): Promise<boolean> {
		await this._panes.setInput(input);
		if (!this._tabs.has(input)) {
			this._addTab(input);
			this._editors.push(input);
		}
		this.setActive(input, options);
		return true;
	}

	contains(input: EditorInput): boolean {
		return this._tabs.has(input);
	}

	get editors(): readonly EditorInput[] {
		return this._editors;
	}

	get activeEditor(): EditorInput | null {
		return this._active;
	}

	get activePane() {
		return this._panes.activePane;
	}

	/** the cached pane of any input in this group (10's reload/mark-deleted passes) */
	getPane(input: EditorInput) {
		return this._panes.getPane(input) ?? null;
	}

	/** 10: deleting a file strikes its tab through until it is closed or saved again */
	setEditorDeleted(input: EditorInput, deleted: boolean): void {
		this._tabs.get(input)?.element.classList.toggle('deleted', deleted);
	}

	/** 10: the input's resource changed (rename/remap) — refresh the tab label */
	updateEditor(input: EditorInput): void {
		const entry = this._tabs.get(input);
		if (!entry) {
			return;
		}
		entry.label.textContent = input.getName();
		entry.element.title = input.getResource()?.fsPath ?? input.getName();
	}

	closeEditor(input: EditorInput): void {
		const entry = this._tabs.get(input);
		if (!entry) {
			return;
		}
		const index = this._editors.indexOf(input);
		for (const disposable of entry.disposables) {
			disposable.dispose();
		}
		entry.element.remove();
		this._tabs.delete(input);
		if (index >= 0) {
			this._editors.splice(index, 1);
		}
		this._panes.closeInput(input);

		if (this._active === input) {
			this._active = null;
			const next = this._editors[Math.min(index, this._editors.length - 1)] ?? null;
			if (next) {
				this.setActive(next, { focus: true });
			} else {
				this._panes.clearActive();
				this._watermark.style.display = '';
				this._onDidActiveEditorChange.fire(null);
			}
		}
	}

	// ---- navigation

	activateNext(): boolean {
		return this._activateAt(1);
	}

	activatePrevious(): boolean {
		return this._activateAt(-1);
	}

	private _activateAt(delta: number): boolean {
		if (this._editors.length === 0) {
			return false;
		}
		const current = this._active ? this._editors.indexOf(this._active) : -1;
		const next = this._editors[(current + delta + this._editors.length) % this._editors.length];
		this.setActive(next, { focus: true });
		return true;
	}

	setActive(input: EditorInput, options?: { focus?: boolean }): void {
		if (this._active === input) {
			if (options?.focus) {
				this.focus();
			}
			return;
		}
		this._active = input;
		for (const [tabInput, entry] of this._tabs) {
			entry.element.classList.toggle('active', tabInput === input);
		}
		this._watermark.style.display = 'none';
		// reactivate the cached pane (a close may have cleared the active pane)
		this._panes.activate(input);
		this._panes.layout(this._contentWidth(), this._contentHeight());
		if (options?.focus !== false) {
			this.focus();
		}
		this._onDidActiveEditorChange.fire(input);
	}

	/** the part toggles this when the active group changes: inactive groups dim their active tab */
	setActiveGroupLook(active: boolean): void {
		this.element.classList.toggle('active-group', active);
	}

	focus(): void {
		this._panes.activePane?.focus();
	}

	layout(width: number, height: number): void {
		this._width = width;
		this._height = height;
		this._titleArea.style.height = `${TITLE_HEIGHT}px`;
		this._contentElement.style.top = `${TITLE_HEIGHT}px`;
		this._panes.layout(this._contentWidth(), this._contentHeight());
	}

	private _contentWidth(): number {
		return this._width;
	}

	private _contentHeight(): number {
		return Math.max(0, this._height - TITLE_HEIGHT);
	}

	// ---- tabs

	private _addTab(input: EditorInput): void {
		const element = $('.tab');
		element.title = input.getResource()?.fsPath ?? input.getName();
		const label = append(element, $('.tab-label', {}, input.getName()));
		const actions = append(element, $('.tab-actions'));
		const close = append(actions, $('.tab-action-close'));
		close.setAttribute('role', 'button');
		close.setAttribute('aria-label', 'Close');

		const dirtyListener = input.onDidChangeDirty(() => element.classList.toggle('dirty', input.isDirty()));
		element.classList.toggle('dirty', input.isDirty());

		const closeListener = addDisposableListener(close, 'mousedown', (e: MouseEvent) => {
			if (e.button !== 0) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			this._onDidRequestCloseEditor.fire(input);
		});
		const tabListener = addDisposableListener(element, 'mousedown', (e: MouseEvent) => {
			if (e.button === 1) {
				// middle click closes (port: tabs control behavior)
				e.preventDefault();
				this._onDidRequestCloseEditor.fire(input);
				return;
			}
			if (e.button === 0) {
				this.setActive(input, { focus: true });
			}
		});

		this._tabs.set(input, { element, label, disposables: [dirtyListener, closeListener, tabListener] });
		append(this._tabsElement, element);
	}

	// ---- watermark

	private _createWatermark(): HTMLElement {
		const watermark = append(this._contentElement, $('.editor-watermark'));
		append(watermark, $('.watermark-title', {}, 'mini-vscode'));
		for (const hint of WATERMARK_HINTS) {
			const entry = $('.watermark-entry');
			if (hint.disabledReason) {
				entry.classList.add('disabled');
				entry.title = hint.disabledReason;
			} else {
				entry.title = hint.command ?? '';
				this._register(addDisposableListener(entry, 'click', () => {
					if (hint.command) {
						void this._services.commandService.executeCommand(hint.command);
					}
				}));
			}
			append(entry,
				$('.watermark-label', {}, hint.label),
				$('.watermark-keys', {}, ...hint.keys.map(key => $('kbd.key', {}, key)))
			);
			append(watermark, entry);
		}
		return watermark;
	}
}
