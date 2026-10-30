// src/common/platform/configuration/common/configurationRegistry.ts — the settings registry,
// ported from vs/platform/configuration/common/configurationRegistry.ts (simplified: no policies,
// no language overrides, no allOf).

import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { IConfigurationNode, IConfigurationRegistry } from './configurationRegistryTypes.js';

export { IConfigurationNode, IConfigurationPropertySchema, ConfigurationScope } from './configurationRegistryTypes.js';

class ConfigurationRegistryImpl {

	private readonly _properties = new Map<string, { schema: { [key: string]: unknown }; defaultValue: unknown }>();
	private readonly _configurations = new Set<IConfigurationNode>();

	registerConfiguration(configuration: IConfigurationNode): IDisposable {
		if (!configuration.id) {
			throw new Error('Invalid configuration: missing id');
		}
		this._configurations.add(configuration);

		for (const [key, schema] of Object.entries(configuration.properties ?? {})) {
			if (this._properties.has(key)) {
				// ported message shape (the reference revision rewords this; the course pins this)
				console.warn(`Configuration '${key}' is already registered.`);
				continue;
			}
			this._properties.set(key, { schema: schema as { [key: string]: unknown }, defaultValue: (schema as { default?: unknown }).default });
		}

		return toDisposable(() => {
			this._configurations.delete(configuration);
			for (const key of Object.keys(configuration.properties ?? {})) {
				this._properties.delete(key);
			}
		});
	}

	/** `editor.fontSize` → 14 */
	getDefaultValue(key: string): unknown {
		return this._properties.get(key)?.defaultValue;
	}

	/** the flat map of registered properties: key → schema (+ default) */
	getConfigurationProperties(): Map<string, { schema: { [key: string]: unknown }; defaultValue: unknown }> {
		return new Map(this._properties);
	}
}

export const ConfigurationRegistry: IConfigurationRegistry = new ConfigurationRegistryImpl();
