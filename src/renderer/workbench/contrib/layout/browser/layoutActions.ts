// src/renderer/workbench/contrib/layout/browser/layoutActions.ts — the layout commands, with the
// real action IDs from vs/workbench/browser/actions/layoutActions.ts (+ showCommands from the
// quick access actions).

import { CommandMetadata, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import type { IWindowChannel } from '../../../../../common/platform/window/common/window.js';
import type { WorkbenchLayout } from '../../../browser/layout.js';

export const TOGGLE_SIDEBAR_VISIBILITY_ID = 'workbench.action.toggleSidebarVisibility';
export const TOGGLE_PANEL_ID = 'workbench.action.togglePanel';
export const TOGGLE_FULL_SCREEN_ID = 'workbench.action.toggleFullScreen';
export const SHOW_ALL_COMMANDS_ID = 'workbench.action.showCommands';

export function registerLayoutCommands(layout: WorkbenchLayout, windowChannel: IWindowChannel): void {

	CommandsRegistry.registerCommand(TOGGLE_SIDEBAR_VISIBILITY_ID, () => layout.toggleSidebar());
	CommandMetadata.register({
		id: TOGGLE_SIDEBAR_VISIBILITY_ID,
		title: 'Toggle Sidebar Visibility',
		category: 'View'
	});

	// note: upstream registers togglePanel with dynamic titles and `panelVisible`/`!panelVisible`
	// precondition variants; this is the simple static version
	CommandsRegistry.registerCommand(TOGGLE_PANEL_ID, () => layout.togglePanel());
	CommandMetadata.register({
		id: TOGGLE_PANEL_ID,
		title: 'Toggle Panel',
		category: 'View'
	});

	CommandsRegistry.registerCommand(TOGGLE_FULL_SCREEN_ID, () => {
		void windowChannel.toggleFullScreen();
	});
	CommandMetadata.register({
		id: TOGGLE_FULL_SCREEN_ID,
		title: 'Toggle Full Screen',
		category: 'View'
	});
}
