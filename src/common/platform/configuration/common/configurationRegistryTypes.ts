// src/common/platform/configuration/common/configurationRegistryTypes.ts — types split out of
// configurationRegistry.ts so the registry and the default-settings file stay readable.

import { IDisposable } from '../../../base/common/lifecycle.js';

export const enum ConfigurationScope {
	APPLICATION = 1,
	MACHINE,
	WINDOW,
	RESOURCE,
	LANGUAGE_OVERRIDABLE,
	MACHINE_OVERRIDABLE,
}

export interface IConfigurationPropertySchema {
	readonly type?: 'boolean' | 'string' | 'number' | 'integer' | 'array' | 'object' | 'null';
	readonly default?: unknown;
	readonly description?: string;
	readonly enum?: ReadonlyArray<unknown>;
	readonly enumDescriptions?: ReadonlyArray<string>;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly items?: unknown;
	readonly scope?: ConfigurationScope;
	readonly markdownDescription?: string;
}

export interface IConfigurationNode {
	readonly id: string;
	readonly title?: string;
	readonly type?: string;
	readonly properties?: { readonly [key: string]: IConfigurationPropertySchema };
}

export interface IConfigurationRegistry {
	registerConfiguration(configuration: IConfigurationNode): IDisposable;
	/** `editor.fontSize` → 14 */
	getDefaultValue(key: string): unknown;
	/** the flat map of registered properties: key → schema (+ default) */
	getConfigurationProperties(): Map<string, { schema: { [key: string]: unknown }; defaultValue: unknown }>;
}
