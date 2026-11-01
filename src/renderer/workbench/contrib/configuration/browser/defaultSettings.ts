// src/renderer/workbench/contrib/configuration/browser/defaultSettings.ts — the starter set of
// registered settings. Real VS Code splits this across hundreds of *.defaultSettings files
// (delta noted); property names, types, enums and defaults here are the real ones.

import { IDisposable } from '../../../../../common/base/common/lifecycle.js';
import { ConfigurationRegistry, IConfigurationNode } from '../../../../../common/platform/configuration/common/configurationRegistry.js';

const defaultSettings: IConfigurationNode = {
	id: 'defaultSettings',
	title: 'Default Settings',
	properties: {
		// the agent's command tool is OFF by default: letting a model run programs in your
		// workspace is a decision the user makes once, knowingly
		'agent.allowCommands': {
			type: 'boolean',
			default: false,
			description: 'Allow the built-in coding agent to run commands in the workspace folder. Off by default.'
		},
		'editor.fontSize': {
			type: 'number',
			default: 14,
			minimum: 6,
			maximum: 100,
			description: 'Controls the font size in pixels.'
		},
		'editor.tabSize': {
			type: 'number',
			default: 4,
			minimum: 1,
			description: 'The number of spaces a tab is equal to.'
		},
		'editor.lineNumbers': {
			type: 'string',
			enum: ['on', 'off', 'relative', 'interval'],
			default: 'on',
			description: 'Controls the display of line numbers.'
		},
		'workbench.sideBar.visible': {
			type: 'boolean',
			default: true,
			description: 'Controls whether the side bar is visible.'
		},
		'workbench.panel.visible': {
			type: 'boolean',
			default: false,
			description: 'Controls whether the panel is visible.'
		},
		'workbench.colorTheme': {
			type: 'string',
			default: 'Default Dark',
			description: 'Specifies the color theme used in the workbench.'
		},
		'explorer.confirmDelete': {
			type: 'boolean',
			default: true,
			description: 'Controls whether the Explorer should ask for confirmation when deleting a file via the trash.'
		},
		// 13: the terminal settings — real keys, values and ranges (defaults verified against
		// the reference revision; the font family's real default is the editor's font family,
		// the fixed monospace default here is the documented delta)
		'terminal.integrated.fontSize': {
			type: 'number',
			// the reference: `defaultTerminalFontSize = isMacintosh ? 12 : 14`
			default: navigator.platform.startsWith('Mac') ? 12 : 14,
			minimum: 6,
			maximum: 100,
			description: 'Controls the font size in pixels of the terminal.'
		},
		'terminal.integrated.fontFamily': {
			type: 'string',
			default: `Menlo, Monaco, 'Courier New', monospace`,
			description: 'Controls the font family of the terminal.'
		},
		'terminal.integrated.scrollback': {
			type: 'number',
			default: 1000,
			description: 'Controls the maximum number of lines the terminal keeps in its buffer.'
		},
		'terminal.integrated.cursorBlinking': {
			type: 'boolean',
			default: false,
			description: 'Controls whether the terminal cursor blinks.'
		},
		'terminal.integrated.macOptionIsMeta': {
			type: 'boolean',
			default: false,
			description: 'Controls whether option/alt acts as the meta key in the terminal on macOS.'
		},
		'terminal.integrated.confirmOnKill': {
			type: 'string',
			enum: ['never', 'editor', 'panel', 'always'],
			default: 'editor',
			description: 'Controls whether to confirm killing terminals when they have child processes.'
		}
	}
};

export function registerDefaultConfigurations(): IDisposable {
	return ConfigurationRegistry.registerConfiguration(defaultSettings);
}
