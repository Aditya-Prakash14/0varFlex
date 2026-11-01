// src/renderer/workbench/contrib/welcome/browser/welcomeEditor.ts — the Welcome page, as a real
// editor tab.
//
// Ported in shape from vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.ts.
// Structurally this is the first NON-TEXT editor in the workbench, which is the point: 09's
// EditorInput/EditorPane pair was built as an extension point and until now had exactly one
// implementation. A welcome page is the canonical second one — it has no model, no file and
// nothing to save.
//
// Sections mirror the real page: Start, Recent, the walkthrough checklist, and the
// show-on-startup toggle.
//
// All text goes in through textContent — the recent list contains folder paths from disk.
//
// delta: no extension-contributed walkthroughs, no per-step media/illustrations, no "New File"
// language picker, no theme picker.

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { DisposableStore } from '../../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../../common/base/common/uri.js';
import { addDisposableListener, append, $ } from '../../../../base/browser/dom.js';
import { EditorInput, EditorInputCapabilities } from '../../../common/editor/editorInput.js';
import { EditorPane, IEditorViewState } from '../../../common/editor/editorPane.js';
import {
	basenameOf,
	dirnameOf,
	IRecentFolder,
	IWalkthroughStep,
	WALKTHROUGH_STEPS,
	walkthroughProgress
} from './welcomeState.js';

export const WELCOME_EDITOR_TYPE_ID = 'workbench.editors.welcomePage';

export interface IWelcomeServices {
	readonly productName: string;
	readonly version: string;
	runCommand(commandId: string): void;
	openFolderAt(path: string): void;
	removeRecentFolder(path: string): void;
	getRecentFolders(): readonly IRecentFolder[];
	getCompletedSteps(): ReadonlySet<string>;
	isShowOnStartup(): boolean;
	setShowOnStartup(show: boolean): void;
	/** fired when a step completes or the recent list changes, so the page repaints */
	readonly onDidChangeState: Event<void>;
}

/**
 * The Welcome input. Not backed by a file, so there is nothing to save, nothing to revert and no
 * dirty state — the base class's defaults are all correct, which is why this is short.
 *
 * On single-instance behaviour: the editor group keys its tabs by INSTANCE (`_tabs.has(input)`),
 * and neither `Singleton` nor `matches()` is consulted on the open path today. So "one Welcome
 * tab" is enforced by the caller reusing one instance (see the workbench wiring), not here.
 * `matches` is still overridden on type, because the base compares resources and this input has
 * none — it would answer false for itself, and the first caller to rely on it would get
 * duplicate tabs.
 */
export class WelcomeEditorInput extends EditorInput {

	constructor(private readonly _services: IWelcomeServices) {
		super();
	}

	getTypeId(): string {
		return WELCOME_EDITOR_TYPE_ID;
	}

	getName(): string {
		return 'Welcome';
	}

	getResource(): URI | undefined {
		return undefined;
	}

	override get capabilities(): EditorInputCapabilities {
		// declarative intent; nothing reads Singleton yet, and Readonly is honoured by the text
		// widget only — a welcome page has no widget to gate
		return EditorInputCapabilities.Singleton | EditorInputCapabilities.Readonly;
	}

	override matches(other: EditorInput | undefined | null): boolean {
		return !!other && other.getTypeId() === WELCOME_EDITOR_TYPE_ID;
	}

	async resolve(): Promise<EditorPane> {
		return new WelcomePane(this, this._services);
	}
}

export class WelcomePane extends EditorPane {

	readonly element: HTMLElement;

	private readonly _body: HTMLElement;
	/** listeners for the CURRENT render; the page is rebuilt whenever state changes */
	private readonly _rowDisposables = this._register(new DisposableStore());

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState: Event<void> = this._onDidChangeState.event;

	constructor(private readonly _input: WelcomeEditorInput, private readonly _services: IWelcomeServices) {
		super();
		this.element = $('.welcome-page');
		this._body = append(this.element, $('.welcome-body'));

		this._register(this._services.onDidChangeState(() => this.render()));
		this.render();
	}

	override getId(): string {
		return WELCOME_EDITOR_TYPE_ID;
	}

	getInput(): WelcomeEditorInput {
		return this._input;
	}

	override layout(_width: number, _height: number): void {
		// the page is a scrolling document: CSS handles it, nothing to measure
	}

	override setVisible(_visible: boolean): void {
		// no model and no view state to park
	}

	override focus(): void {
		this.element.focus();
	}

	override saveViewState(): IEditorViewState | null {
		return null;
	}

	override restoreViewState(_state: IEditorViewState | null): void {
		// nothing to restore
	}

	render(): void {
		this._rowDisposables.clear();
		this._body.textContent = '';

		this._renderHeader();
		const columns = append(this._body, $('.welcome-columns'));
		this._renderStart(append(columns, $('.welcome-column')));
		this._renderWalkthrough(append(columns, $('.welcome-column.wide')));
		this._renderFooter();

		this._onDidChangeState.fire();
	}

	private _renderHeader(): void {
		const header = append(this._body, $('.welcome-header'));
		append(header, $('h1.welcome-title', {}, this._services.productName));
		append(header, $('.welcome-subtitle', {}, `Version ${this._services.version} — a code editor built from scratch`));
	}

	private _renderStart(column: HTMLElement): void {
		append(column, $('h2.welcome-section-title', {}, 'Start'));
		const start = append(column, $('.welcome-links'));
		this._addLink(start, 'New File…', 'explorer.newFile');
		this._addLink(start, 'Open Folder…', 'workbench.action.files.openFolder');
		this._addLink(start, 'Open Settings', 'workbench.action.openSettingsJson');

		append(column, $('h2.welcome-section-title', {}, 'Recent'));
		const recent = this._services.getRecentFolders();
		if (recent.length === 0) {
			append(column, $('.welcome-empty', {}, 'No recent folders yet.'));
			return;
		}

		const list = append(column, $('.welcome-recent'));
		for (const folder of recent) {
			const row = append(list, $('.welcome-recent-row', { title: folder.path }));
			const open = append(row, $('span.welcome-recent-open', { tabindex: '0' }));
			append(open, $('span.welcome-recent-name', {}, folder.name || basenameOf(folder.path)));
			const directory = dirnameOf(folder.path);
			if (directory) {
				append(open, $('span.welcome-recent-dir', {}, directory));
			}
			const remove = append(row, $('span.welcome-recent-remove', { title: 'Remove from Recent', tabindex: '0' }, '✕'));

			const path = folder.path;
			this._rowDisposables.add(addDisposableListener(open, 'click', () => this._services.openFolderAt(path)));
			this._rowDisposables.add(addDisposableListener(open, 'keydown', (event: KeyboardEvent) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					this._services.openFolderAt(path);
				}
			}));
			this._rowDisposables.add(addDisposableListener(remove, 'click', (event: MouseEvent) => {
				event.stopPropagation();
				this._services.removeRecentFolder(path);
			}));
		}
	}

	private _renderWalkthrough(column: HTMLElement): void {
		const completed = this._services.getCompletedSteps();
		const progress = walkthroughProgress(completed);

		const titleRow = append(column, $('.welcome-walkthrough-header'));
		append(titleRow, $('h2.welcome-section-title', {}, 'Get Started with 0varflex'));
		append(titleRow, $('span.welcome-progress', {},
			progress.allDone ? 'All done' : `${progress.done} of ${progress.total}`));

		const bar = append(column, $('.welcome-progress-bar'));
		const fill = append(bar, $('.welcome-progress-fill'));
		fill.style.width = `${progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100)}%`;

		const steps = append(column, $('.welcome-steps'));
		for (const step of WALKTHROUGH_STEPS) {
			this._renderStep(steps, step, completed.has(step.id));
		}
	}

	private _renderStep(parent: HTMLElement, step: IWalkthroughStep, done: boolean): void {
		const row = append(parent, $('.welcome-step'));
		row.classList.toggle('done', done);

		const tick = append(row, $('span.welcome-step-tick'));
		tick.textContent = done ? '✓' : '';

		const text = append(row, $('.welcome-step-text'));
		const heading = append(text, $('.welcome-step-title'));
		append(heading, $('span', {}, step.title));
		if (step.keybindingLabel) {
			append(heading, $('span.welcome-step-key', {}, step.keybindingLabel));
		}
		append(text, $('.welcome-step-description', {}, step.description));

		const button = append(text, $('span.welcome-step-action', { tabindex: '0' }, step.actionLabel));
		const run = () => this._services.runCommand(step.commandId);
		this._rowDisposables.add(addDisposableListener(button, 'click', run));
		this._rowDisposables.add(addDisposableListener(button, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				run();
			}
		}));
	}

	private _renderFooter(): void {
		const footer = append(this._body, $('.welcome-footer'));
		const label = append(footer, $('label.welcome-startup'));
		const checkbox = append(label, $<HTMLInputElement>('input', { type: 'checkbox' }));
		checkbox.checked = this._services.isShowOnStartup();
		append(label, $('span', {}, 'Show welcome page on startup'));
		this._rowDisposables.add(addDisposableListener(checkbox, 'change', () => {
			this._services.setShowOnStartup(checkbox.checked);
		}));
	}

	private _addLink(parent: HTMLElement, label: string, commandId: string): void {
		const link = append(parent, $('span.welcome-link', { tabindex: '0' }, label));
		const run = () => this._services.runCommand(commandId);
		this._rowDisposables.add(addDisposableListener(link, 'click', run));
		this._rowDisposables.add(addDisposableListener(link, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				run();
			}
		}));
	}
}
