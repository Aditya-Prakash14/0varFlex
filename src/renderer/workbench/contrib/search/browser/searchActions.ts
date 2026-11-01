// src/renderer/workbench/contrib/search/browser/searchActions.ts — the Search commands with the
// REAL ids, read from vs/workbench/contrib/search/common/constants.ts:
//
//   workbench.action.findInFiles          cmd/ctrl+shift+f  — show the view and focus the input
//   search.action.focusSearchList                           — move focus into the results
//   search.action.refreshSearchResults                      — re-run the query
//   search.action.clearSearchResults                        — drop input + results
//   search.action.cancel                  Escape (in view)  — stop a running search
//   toggleSearchCaseSensitive             alt+cmd/ctrl+c
//   toggleSearchWholeWord                 alt+cmd/ctrl+w
//   toggleSearchRegex                     alt+cmd/ctrl+r
//
// shortcut: no "find in folder" from the explorer context menu and no search-editor commands.

import { IDisposable, toDisposable } from '../../../../../common/base/common/lifecycle.js';
import { CommandMetadata, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { KeyCode, KeyMod } from '../../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { SearchViewFocusContext } from './searchView.js';
import type { SearchView } from './searchView.js';

export const SEARCH_VIEW_ID = 'workbench.view.search';
export const FIND_IN_FILES_ID = 'workbench.action.findInFiles';
export const FOCUS_SEARCH_LIST_ID = 'search.action.focusSearchList';
export const REFRESH_SEARCH_ID = 'search.action.refreshSearchResults';
export const CLEAR_SEARCH_ID = 'search.action.clearSearchResults';
export const CANCEL_SEARCH_ID = 'search.action.cancel';
export const TOGGLE_CASE_ID = 'toggleSearchCaseSensitive';
export const TOGGLE_WORD_ID = 'toggleSearchWholeWord';
export const TOGGLE_REGEX_ID = 'toggleSearchRegex';

export interface ISearchActionServices {
	/** the view is created with the workbench; these commands drive it */
	getView(): SearchView;
	/** make the Search composite the visible one in the sidebar */
	showSearchView(): void;
}

export function registerSearchActions(services: ISearchActionServices): IDisposable {
	const disposables: IDisposable[] = [];

	const register = (id: string, title: string, handler: () => unknown): void => {
		disposables.push(CommandsRegistry.registerCommand(id, () => handler()));
		disposables.push(CommandMetadata.register({ id, title, category: 'Search' }));
	};

	register(SEARCH_VIEW_ID, 'Show Search', () => {
		services.showSearchView();
		services.getView().focusInput();
	});

	register(FIND_IN_FILES_ID, 'Find in Files', () => {
		services.showSearchView();
		services.getView().focusInput();
	});

	register(FOCUS_SEARCH_LIST_ID, 'Focus on Search Results View', () => {
		services.showSearchView();
		services.getView().focusResults();
	});

	register(REFRESH_SEARCH_ID, 'Refresh', () => services.getView().refresh());
	register(CLEAR_SEARCH_ID, 'Clear Search Results', () => services.getView().clear());
	register(CANCEL_SEARCH_ID, 'Cancel Search', () => services.getView().cancelSearch());

	register(TOGGLE_CASE_ID, 'Toggle Match Case', () => services.getView().toggleCaseSensitive());
	register(TOGGLE_WORD_ID, 'Toggle Match Whole Word', () => services.getView().toggleWordMatch());
	register(TOGGLE_REGEX_ID, 'Toggle Use Regular Expression', () => services.getView().toggleRegExp());

	// ---- bindings

	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: FIND_IN_FILES_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyF
	}));

	// Escape only when the Search view owns focus, so it does not eat the editor's Escape
	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: CANCEL_SEARCH_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		when: SearchViewFocusContext,
		primary: KeyCode.Escape
	}));

	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: TOGGLE_CASE_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		when: SearchViewFocusContext,
		primary: KeyMod.Alt | KeyMod.CtrlCmd | KeyCode.KeyC
	}));
	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: TOGGLE_WORD_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		when: SearchViewFocusContext,
		primary: KeyMod.Alt | KeyMod.CtrlCmd | KeyCode.KeyW
	}));
	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: TOGGLE_REGEX_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		when: SearchViewFocusContext,
		primary: KeyMod.Alt | KeyMod.CtrlCmd | KeyCode.KeyR
	}));

	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
