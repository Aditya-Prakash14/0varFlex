// src/main/menu.ts — the application menu. View menu items route through the window channel
// (04/05 build the real menu story; no keybindings yet on purpose — Cmd+B arrives in 05).

import { Menu, MenuItemConstructorOptions } from 'electron';
import { sendMenuCommand } from './parts/ipc/channels.js';

export function installMenu(): void {
	const isMac = process.platform === 'darwin';

	const template: MenuItemConstructorOptions[] = [
		...(isMac ? [{ role: 'appMenu' as const }] : []),
		{ role: 'editMenu' },
		{
			label: 'View',
			submenu: [
				{
					label: 'Toggle Sidebar',
					click: () => sendMenuCommand('toggleSidebar')
				},
				{
					label: 'Toggle Panel',
					click: () => sendMenuCommand('togglePanel')
				},
				{ type: 'separator' },
				{ role: 'reload' },
				{ role: 'forceReload' },
				{ role: 'toggleDevTools' },
				{ type: 'separator' },
				{ role: 'togglefullscreen' }
			]
		},
		{ role: 'windowMenu' }
	];

	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
