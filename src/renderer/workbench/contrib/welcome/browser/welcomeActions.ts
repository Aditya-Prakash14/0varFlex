// src/renderer/workbench/contrib/welcome/browser/welcomeActions.ts — the Welcome page's wiring:
// the command that opens it, the walkthrough's completion tracking, the recent-folder list, and
// the startup decision.
//
// Command id and setting are the real ones from the reference's
// welcomeGettingStarted/browser/gettingStarted.contribution.ts: `workbench.action.openWalkthrough`
// and `workbench.startupEditor`.
//
// The interesting part is how a step completes: the command service publishes every execution,
// so a step ticks when the user ACTUALLY runs the command — from the palette, a keybinding, or
// the page's own button. Marking it done on click would lie whenever the user dismissed the
// dialog that followed.

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../common/base/common/lifecycle.js';
import { IStorageService, StorageScope } from '../../../../../common/platform/storage/common/storage.js';
import { CommandMetadata, CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import {
	addRecentFolder,
	IRecentFolder,
	RECENT_FOLDERS_STORAGE_KEY,
	readCompletedSteps,
	readRecentFolders,
	removeRecentFolder,
	shouldOpenWelcomeOnStartup,
	stepForCommand,
	WALKTHROUGH_STORAGE_KEY
} from './welcomeState.js';

export const OPEN_WALKTHROUGH_ID = 'workbench.action.openWalkthrough';
export const STARTUP_EDITOR_SETTING = 'workbench.startupEditor';

/**
 * Holds the walkthrough and recent-folder state, persisted in APPLICATION scope: both describe
 * the editor rather than one folder, so they must survive switching workspaces.
 */
export class WelcomeStateService extends Disposable {

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState: Event<void> = this._onDidChangeState.event;

	private _completed: Set<string>;
	private _recent: IRecentFolder[];

	constructor(
		private readonly _storage: IStorageService,
		commandService: ICommandService
	) {
		super();
		this._completed = readCompletedSteps(this._storage.getObject(WALKTHROUGH_STORAGE_KEY, StorageScope.APPLICATION));
		this._recent = readRecentFolders(this._storage.getObject(RECENT_FOLDERS_STORAGE_KEY, StorageScope.APPLICATION));

		// a step is done when its command really runs — however the user got there
		this._register(commandService.onDidExecuteCommand(event => {
			const step = stepForCommand(event.commandId);
			if (step && !this._completed.has(step.id)) {
				this._completed.add(step.id);
				this._storage.store(WALKTHROUGH_STORAGE_KEY, [...this._completed], StorageScope.APPLICATION);
				this._onDidChangeState.fire();
			}
		}));
	}

	get completedSteps(): ReadonlySet<string> {
		return this._completed;
	}

	get recentFolders(): readonly IRecentFolder[] {
		return this._recent;
	}

	/** called whenever a folder is opened, so the list reflects real use */
	noteFolderOpened(path: string): void {
		const next = addRecentFolder(this._recent, path);
		// only persist and repaint when the list actually changed
		if (next.length !== this._recent.length || next[0]?.path !== this._recent[0]?.path) {
			this._recent = next;
			this._storage.store(RECENT_FOLDERS_STORAGE_KEY, next, StorageScope.APPLICATION);
			this._onDidChangeState.fire();
		}
	}

	forgetFolder(path: string): void {
		const next = removeRecentFolder(this._recent, path);
		if (next.length !== this._recent.length) {
			this._recent = next;
			this._storage.store(RECENT_FOLDERS_STORAGE_KEY, next, StorageScope.APPLICATION);
			this._onDidChangeState.fire();
		}
	}

	/** the page's checkbox reads and writes `workbench.startupEditor` */
	shouldShowOnStartup(setting: unknown, hasFolder: boolean, hasRestoredEditors: boolean): boolean {
		return shouldOpenWelcomeOnStartup(setting, hasFolder, hasRestoredEditors);
	}
}

export interface IWelcomeActionServices {
	showWelcome(): void;
}

export function registerWelcomeActions(services: IWelcomeActionServices): IDisposable {
	const disposables: IDisposable[] = [];

	disposables.push(CommandsRegistry.registerCommand(OPEN_WALKTHROUGH_ID, () => services.showWelcome()));
	disposables.push(CommandMetadata.register({ id: OPEN_WALKTHROUGH_ID, title: 'Welcome', category: 'Help' }));

	// the id people actually remember from older VS Code, kept as an alias
    disposables.push(CommandsRegistry.registerCommand('workbench.action.showWelcomePage', () => services.showWelcome()));
	disposables.push(CommandMetadata.register({ id: 'workbench.action.showWelcomePage', title: 'Show Welcome Page', category: 'Help' }));

	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
