// src/renderer/workbench/contrib/terminal/browser/terminalActions.ts — the terminal commands +
// their REAL bindings, ported from vs/workbench/contrib/terminal/browser/terminalActions.ts:
//
//   toggleTerminal   ctrl+backtick (mac: ctrl+backtick too)       — the view's open command
//   new              ctrl+shift+backtick (mac: ctrl+shift+backtick)
//   clear            mac cmd+k, weight WorkbenchContrib + 1       — the reference's comment:
//                    "higher than workbench contributions so the keybinding remains highest
//                    priority when chords are registered afterwards"
//   focusNext        mac cmd+shift+], when terminalFocus && !editorFocus
//   focusPrevious    mac cmd+shift+[
//   kill             no default binding (the tab's ✕ / the trash button call it too)
//
// THE CHORD INTERPLAY: `cmd+k cmd+a` (05's demo chords) must NOT hijack cmd+k while the
// terminal is focused. The reference's ordering is weight + when-clause specificity; the chord
// rules are editor bindings, so they carry `editorTextFocus` (05 registered them unconditionally
// — the fix lands there) and the clear binding wins inside the terminal on its own weight.

import { Disposable, IDisposable, toDisposable } from '../../../../../common/base/common/lifecycle.js';
import { CommandsRegistry, CommandMetadata } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { KeyCode, KeyMod } from '../../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import type { TerminalPanel } from './terminalPanel.js';

interface ITerminalActionBinding {
	readonly primary?: number;
	readonly mac?: number;
	readonly weight?: number;
	readonly when?: RawContextKey<boolean>;
}

export function registerTerminalActions(panel: TerminalPanel, contextKeyService: IContextKeyService): IDisposable {
	const disposables: IDisposable[] = [];
	const terminalFocus = new RawContextKey<boolean>('terminalFocus', false);
	// bound so the toggle command can READ the focus state (bind tracks the same key id)
	const terminalFocusValue = terminalFocus.bindTo(contextKeyService);

	const register = (
		id: string,
		title: string,
		run: () => void | Promise<void>,
		binding?: ITerminalActionBinding
	): void => {
		disposables.push(CommandsRegistry.registerCommand(id, () => run()));
		disposables.push(CommandMetadata.register({ id, title, category: 'Terminal' }));
		if (binding && binding.primary !== undefined) {
			disposables.push(KeybindingsRegistry.registerKeybindingRule({
				id,
				weight: binding.weight ?? KeybindingWeight.WorkbenchContrib,
				when: binding.when,
				primary: binding.primary,
				mac: binding.mac
			}));
		}
	};

	register('workbench.action.terminal.toggleTerminal', 'Toggle Terminal', async () => {
		if (!panel.isVisible) {
			await panel.show();
		} else if (terminalFocusValue.get() ?? false) {
			await panel.hide();
		} else {
			panel.focusActive();
		}
	}, { primary: KeyMod.WinCtrl | KeyCode.Backquote, mac: KeyMod.WinCtrl | KeyCode.Backquote });

	register('workbench.action.terminal.new', 'Create New Terminal', async () => {
		await panel.show();
		await panel.newTerminal();
	}, { primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.Backquote, mac: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.Backquote });

	register('workbench.action.terminal.focus', 'Focus Terminal', () => panel.focusActive(), {
		when: terminalFocus
	});

	register('workbench.action.terminal.kill', 'Kill Terminal', () => panel.killActive());

	register('workbench.action.terminal.clear', 'Clear', () => panel.clearActive(), {
		// the reference binds clear on mac cmd+k ONLY; weight 201 beats the chord contributions
		primary: 0,
		mac: KeyMod.CtrlCmd | KeyCode.KeyK,
		weight: KeybindingWeight.WorkbenchContrib + 1,
		when: terminalFocus
	});

	register('workbench.action.terminal.focusNext', 'Focus Next Terminal', () => panel.focusNext(), {
		primary: KeyMod.CtrlCmd | KeyCode.PageDown,
		mac: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.BracketRight,
		// the reference adds `&& !editorFocus`; the flat context key is the ported subset
		when: terminalFocus
	});

	register('workbench.action.terminal.focusPrevious', 'Focus Previous Terminal', () => panel.focusPrevious(), {
		primary: KeyMod.CtrlCmd | KeyCode.PageUp,
		mac: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.BracketLeft,
		when: terminalFocus
	});

	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
