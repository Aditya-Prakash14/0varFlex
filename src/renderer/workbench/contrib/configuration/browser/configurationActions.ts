// src/renderer/workbench/contrib/configuration/browser/configurationActions.ts — the settings
// command with the real ID; 09 opens settings.json in the editor (it used to reveal it in the
// file manager), and the real cmd+, binding comes along.

import { CommandMetadata, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { KeyCode, KeyMod } from '../../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';

export const OPEN_SETTINGS_JSON_ID = 'workbench.action.openSettingsJson';

export function registerConfigurationActions(settingsPath: string, openFile: (fsPath: string) => void): void {

	CommandsRegistry.registerCommand(OPEN_SETTINGS_JSON_ID, () => {
		// 09: settings open IN THE EDITOR (real behavior); the file-manager reveal remains
		// available through the command registry for whoever needs the old path
		openFile(settingsPath);
	});
	CommandMetadata.register({
		id: OPEN_SETTINGS_JSON_ID,
		title: 'Open User Settings (JSON)',
		category: 'Preferences'
	});
	// the real binding for opening settings
	KeybindingsRegistry.registerKeybindingRule({
		id: OPEN_SETTINGS_JSON_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		primary: KeyMod.CtrlCmd | KeyCode.Comma
	});
}
