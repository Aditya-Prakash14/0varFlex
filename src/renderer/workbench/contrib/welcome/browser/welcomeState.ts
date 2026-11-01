// src/renderer/workbench/contrib/welcome/browser/welcomeState.ts — the Welcome page's data:
// the walkthrough steps, which of them are done, and the recent-folder list.
//
// Ported in shape from vs/workbench/contrib/welcomeGettingStarted/browser/gettingStartedService.ts,
// which also models a walkthrough as steps with a completion event per step. The real one lets
// extensions contribute walkthroughs through `contributes.walkthroughs`; ours has one built-in
// walkthrough, which is the honest subset.
//
// Pure, so the bits that are easy to get wrong — ordering, de-duplication, the cap, and reading
// back state written by an older version — are unit tested without building an editor.

/** a step is done when the user actually runs its command, not when they click its button */
export interface IWalkthroughStep {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	/** run by the step's button, and the command whose execution marks it done */
	readonly commandId: string;
	/** shown on the button */
	readonly actionLabel: string;
	/** the keybinding to show beside the title, as plain text */
	readonly keybindingLabel?: string;
}

/**
 * The built-in walkthrough. Order is the order on screen, and it is deliberate: open a folder
 * first, because almost nothing else in the editor does anything without one.
 */
export const WALKTHROUGH_STEPS: readonly IWalkthroughStep[] = [
	{
		id: 'openFolder',
		title: 'Open a folder',
		description: 'Most of the editor — the explorer, search, source control, tasks and the agent — works on an open folder.',
		commandId: 'workbench.action.files.openFolder',
		actionLabel: 'Open Folder…'
	},
	{
		id: 'commandPalette',
		title: 'Find any command',
		description: 'The command palette lists everything the editor can do, with its keyboard shortcut beside it.',
		commandId: 'workbench.action.showCommands',
		actionLabel: 'Open Command Palette',
		keybindingLabel: 'Ctrl+Shift+P'
	},
	{
		id: 'findInFiles',
		title: 'Search across files',
		description: 'Search the whole folder and jump straight to a match.',
		commandId: 'workbench.action.findInFiles',
		actionLabel: 'Search',
		keybindingLabel: 'Ctrl+Shift+F'
	},
	{
		id: 'terminal',
		title: 'Use the integrated terminal',
		description: 'A real shell inside the editor, in the panel at the bottom.',
		commandId: 'workbench.action.terminal.toggleTerminal',
		actionLabel: 'Open Terminal',
		keybindingLabel: 'Ctrl+`'
	},
	{
		id: 'agent',
		title: 'Ask the built-in agent',
		description: 'Describe a change and the agent reads, searches and edits files in your folder. It cannot touch anything outside it.',
		commandId: 'workbench.action.chat.open',
		actionLabel: 'Open Chat',
		keybindingLabel: 'Ctrl+Alt+I'
	},
	{
		id: 'runTask',
		title: 'Run a task',
		description: 'Your npm scripts are detected automatically; problems in the output become squiggles.',
		commandId: 'workbench.action.tasks.runTask',
		actionLabel: 'Run Task'
	},
	{
		id: 'settings',
		title: 'Make it yours',
		description: 'Settings are a JSON file. Keybindings are another one.',
		commandId: 'workbench.action.openSettingsJson',
		actionLabel: 'Open Settings'
	}
];

/** storage keys (APPLICATION scope: the walkthrough is about the editor, not one folder) */
export const WALKTHROUGH_STORAGE_KEY = 'workbench.welcome.completedSteps';
export const RECENT_FOLDERS_STORAGE_KEY = 'workbench.welcome.recentFolders';
/** the real welcome page shows five; more than that and the list stops being a shortcut */
export const MAX_RECENT_FOLDERS = 8;

/**
 * Read back the completed-step ids.
 *
 * Stored state is untrusted: it may have been written by an older version with different step
 * ids, or hand-edited. Unknown ids are dropped rather than kept, so a renamed step cannot leave
 * a permanently-complete ghost in the list.
 */
export function readCompletedSteps(stored: unknown, steps: readonly IWalkthroughStep[] = WALKTHROUGH_STEPS): Set<string> {
	if (!Array.isArray(stored)) {
		return new Set();
	}
	const known = new Set(steps.map(step => step.id));
	return new Set(stored.filter((id): id is string => typeof id === 'string' && known.has(id)));
}

/** how far through the walkthrough the user is, for the "3 of 7" progress line */
export function walkthroughProgress(completed: ReadonlySet<string>, steps: readonly IWalkthroughStep[] = WALKTHROUGH_STEPS): {
	done: number;
	total: number;
	allDone: boolean;
} {
	let done = 0;
	for (const step of steps) {
		if (completed.has(step.id)) {
			done++;
		}
	}
	return { done, total: steps.length, allDone: done === steps.length && steps.length > 0 };
}

/** the step a command completes, if any — the hook that ticks a step when it is really used */
export function stepForCommand(commandId: string, steps: readonly IWalkthroughStep[] = WALKTHROUGH_STEPS): IWalkthroughStep | undefined {
	return steps.find(step => step.commandId === commandId);
}

// ---- recent folders

export interface IRecentFolder {
	readonly path: string;
	/** the basename, for the label */
	readonly name: string;
}

export function readRecentFolders(stored: unknown): IRecentFolder[] {
	if (!Array.isArray(stored)) {
		return [];
	}
	const seen = new Set<string>();
	const result: IRecentFolder[] = [];
	for (const entry of stored) {
		const path = typeof entry === 'string'
			? entry
			: typeof (entry as { path?: unknown })?.path === 'string' ? (entry as { path: string }).path : undefined;
		if (!path || seen.has(path)) {
			continue;
		}
		seen.add(path);
		result.push({ path, name: basenameOf(path) });
		if (result.length >= MAX_RECENT_FOLDERS) {
			break;
		}
	}
	return result;
}

/**
 * Put `path` at the front, remove any earlier copy, and cap the list.
 *
 * Re-opening a folder you already have in the list must MOVE it rather than add a second entry —
 * otherwise the list fills with one folder.
 */
export function addRecentFolder(existing: readonly IRecentFolder[], path: string): IRecentFolder[] {
	if (!path) {
		return [...existing];
	}
	const withoutDuplicate = existing.filter(entry => entry.path !== path);
	return [{ path, name: basenameOf(path) }, ...withoutDuplicate].slice(0, MAX_RECENT_FOLDERS);
}

export function removeRecentFolder(existing: readonly IRecentFolder[], path: string): IRecentFolder[] {
	return existing.filter(entry => entry.path !== path);
}

/** the last segment, with either separator, and no trailing-slash surprises */
export function basenameOf(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, '');
	if (!trimmed) {
		return path;
	}
	const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
	return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/** the containing directory, shown dimmed beside the name like the real recent list */
export function dirnameOf(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, '');
	const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
	return index > 0 ? trimmed.slice(0, index) : '';
}

// ---- the startup decision

/** the values of `workbench.startupEditor` this build understands */
export type StartupEditor = 'none' | 'welcomePage' | 'welcomePageInEmptyWorkbench';

/**
 * Whether to open the Welcome page on startup.
 *
 * `welcomePageInEmptyWorkbench` is the setting most people actually want: help when you have
 * nothing open, and straight to work when you do. An unknown value falls back to the default
 * rather than showing nothing, so a typo in settings.json does not silently disable it.
 */
export function shouldOpenWelcomeOnStartup(setting: unknown, hasFolder: boolean, hasRestoredEditors: boolean): boolean {
	// anything restored from the previous session wins: the real setting says "if none are
	// restored from the previous session"
	if (hasRestoredEditors) {
		return false;
	}
	const value: StartupEditor = setting === 'none' || setting === 'welcomePage' || setting === 'welcomePageInEmptyWorkbench'
		? setting
		: 'welcomePage';

	switch (value) {
		case 'none': return false;
		case 'welcomePage': return true;
		case 'welcomePageInEmptyWorkbench': return !hasFolder;
	}
}
