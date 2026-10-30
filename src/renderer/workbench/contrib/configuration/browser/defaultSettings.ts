// src/renderer/workbench/contrib/configuration/browser/defaultSettings.ts — the starter set of
// registered settings. Real VS Code splits this across hundreds of *.defaultSettings files
// (delta noted); property names, types, enums and defaults here are the real ones.

import { IDisposable } from '../../../../../common/base/common/lifecycle.js';
import { ConfigurationRegistry, IConfigurationNode } from '../../../../../common/platform/configuration/common/configurationRegistry.js';

const defaultSettings: IConfigurationNode = {
	id: 'defaultSettings',
	title: 'Default Settings',
	properties: {
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
		}
	}
};

export function registerDefaultConfigurations(): IDisposable {
	return ConfigurationRegistry.registerConfiguration(defaultSettings);
}
