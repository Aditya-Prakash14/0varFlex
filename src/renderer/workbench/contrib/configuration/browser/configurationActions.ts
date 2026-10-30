// src/renderer/workbench/contrib/configuration/browser/configurationActions.ts — the settings
// command with the real ID; it reveals User/settings.json in the file manager (the full settings
// UI editor is a delta).

import { CommandMetadata, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import type { IWindowChannel } from '../../../../../common/platform/window/common/window.js';

export const OPEN_SETTINGS_JSON_ID = 'workbench.action.openSettingsJson';

export function registerConfigurationActions(settingsPath: string, windowChannel: IWindowChannel): void {

	CommandsRegistry.registerCommand(OPEN_SETTINGS_JSON_ID, () => {
		void windowChannel.showItemInFolder(settingsPath);
	});
	CommandMetadata.register({
		id: OPEN_SETTINGS_JSON_ID,
		title: 'Open User Settings (JSON)',
		category: 'Preferences'
	});
}
