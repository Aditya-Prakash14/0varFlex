// src/main/menu.ts — the application menu. View menu items route through the window channel.
//
// 09 note: the Window menu is OURS, not `role: 'windowMenu'`, and "Close Window" carries NO
// accelerator — the default role would register Cmd+W and swallow the editor's closeActiveEditor
// binding before the renderer ever sees it (the classic Electron/macOS trap; the real VS Code
// menu summarizes its keybinding-owned shortcuts instead of racing them).

import { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';
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
				{
					label: 'Open Sample File',
					click: () => sendMenuCommand('openSampleFile')
				},
				{ type: 'separator' },
				{ role: 'reload' },
				{ role: 'forceReload' },
				{ role: 'toggleDevTools' },
				{ type: 'separator' },
				{ role: 'togglefullscreen' }
			]
		},
		{
			// no `role: 'windowMenu'`: see the file comment about Cmd+W
			label: 'Window',
			submenu: [
				{ role: 'minimize' },
				{ role: 'zoom' },
				{ type: 'separator' },
				{
					label: 'Close Window',
					click: () => BrowserWindow.getFocusedWindow()?.close()
				}
			]
		}
	];

	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
