// src/renderer/workbench/contrib/debug/browser/debugActions.ts — the Debug commands with the
// REAL ids and bindings, read from vs/workbench/contrib/debug/browser/debugCommands.ts:
//
//   workbench.action.debug.start        F5        (when not already debugging)
//   workbench.action.debug.continue     F5        (when stopped — same key, context-gated)
//   workbench.action.debug.stepOver     F10
//   workbench.action.debug.stop         Shift+F5
//   editor.debug.action.toggleBreakpoint F9
//   workbench.view.debug                          show the composite
//
// F5 doing two things is the real behaviour, and it falls out of the context keys: `inDebugMode`
// decides whether the key means "start" or "continue".

import { IDisposable, toDisposable } from '../../../../../common/base/common/lifecycle.js';
import { CommandMetadata, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeyCode, KeyMod } from '../../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import type { DebugService } from '../../../services/debug/browser/debugService.js';
import { InDebugModeContext } from './debugView.js';
import type { DebugView } from './debugView.js';

export const DEBUG_VIEW_ID = 'workbench.view.debug';
export const DEBUG_START_ID = 'workbench.action.debug.start';
export const DEBUG_CONTINUE_ID = 'workbench.action.debug.continue';
export const DEBUG_STEP_OVER_ID = 'workbench.action.debug.stepOver';
export const DEBUG_STOP_ID = 'workbench.action.debug.stop';
export const TOGGLE_BREAKPOINT_ID = 'editor.debug.action.toggleBreakpoint';

export interface IDebugActionServices {
	readonly debugService: DebugService;
	getView(): DebugView;
	showDebugView(): void;
	/** start the hardcoded configuration (there is no launch.json) */
	start(): void;
	/** toggle a breakpoint on the active editor's cursor line */
	toggleBreakpointAtCursor(): void;
}

export function registerDebugActions(services: IDebugActionServices): IDisposable {
	const disposables: IDisposable[] = [];

	const register = (id: string, title: string, handler: () => unknown): void => {
		disposables.push(CommandsRegistry.registerCommand(id, () => handler()));
		disposables.push(CommandMetadata.register({ id, title, category: 'Debug' }));
	};

	register(DEBUG_VIEW_ID, 'Show Run and Debug', () => {
		services.showDebugView();
		services.getView().focus();
	});

	register(DEBUG_START_ID, 'Start Debugging', () => {
		services.showDebugView();
		services.start();
	});

	register(DEBUG_CONTINUE_ID, 'Continue', () => services.debugService.continue());
	register(DEBUG_STEP_OVER_ID, 'Step Over', () => services.debugService.next());
	register(DEBUG_STOP_ID, 'Stop', () => services.debugService.stop());
	register(TOGGLE_BREAKPOINT_ID, 'Toggle Breakpoint', () => services.toggleBreakpointAtCursor());

	// F5 is start when idle and continue when stopped — the same key, split by context
	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: DEBUG_START_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		when: ContextKeyExpr.not(InDebugModeContext.key),
		primary: KeyCode.F5
	}));
	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: DEBUG_CONTINUE_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		when: InDebugModeContext,
		primary: KeyCode.F5
	}));

	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: DEBUG_STEP_OVER_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		when: InDebugModeContext,
		primary: KeyCode.F10
	}));
	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: DEBUG_STOP_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		when: InDebugModeContext,
		primary: KeyMod.Shift | KeyCode.F5
	}));
	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: TOGGLE_BREAKPOINT_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		primary: KeyCode.F9
	}));

	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
