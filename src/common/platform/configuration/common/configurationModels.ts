// src/common/platform/configuration/common/configurationModels.ts — ConfigurationModel (deep
// merged content, dotted getValue), the merge nuance (objects deep-merge; arrays and scalars
// replace) and ConfigurationChangeEvent with affectsConfiguration(). Simplified from
// vs/platform/configuration/common/configurationModels.ts (no override identifiers, no policy).

import { IConfigurationChange, IConfigurationChangeEvent } from './configuration.js';
import { ConfigurationTarget } from './configuration.js';

function isObject(value: unknown): value is { [key: string]: unknown } {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ConfigurationModel {

	private readonly _content: { [key: string]: unknown };

	constructor(content: { [key: string]: unknown } | undefined) {
		this._content = content ?? Object.create(null);
	}

	getContents(): { [key: string]: unknown } {
		return this._content;
	}

	/** dotted read: getValue('editor.fontSize') walks { editor: { fontSize } } */
	getValue(key: string): unknown {
		const segments = key.split('.');
		let current: unknown = this._content;
		for (const segment of segments) {
			if (!isObject(current)) {
				return undefined;
			}
			current = current[segment];
		}
		return current;
	}

	/** `other` wins: objects deep-merge, arrays and scalars replace */
	merge(other: ConfigurationModel): ConfigurationModel {
		return new ConfigurationModel(ConfigurationModel.mergeContents(this._content, other.getContents()));
	}

	private static mergeContents(base: { [key: string]: unknown }, over: { [key: string]: unknown }): { [key: string]: unknown } {
		const result: { [key: string]: unknown } = Object.create(null);
		for (const key of Object.keys(base)) {
			result[key] = base[key];
		}
		for (const key of Object.keys(over)) {
			const baseValue = result[key];
			const overValue = over[key];
			if (isObject(baseValue) && isObject(overValue)) {
				result[key] = ConfigurationModel.mergeContents(baseValue, overValue);
			} else {
				result[key] = overValue;
			}
		}
		return result;
	}

	compare(other: ConfigurationModel): IConfigurationChange {
		const keys: string[] = [];
		ConfigurationModel._compare(this._content, other.getContents(), '', keys);
		keys.sort();
		return { keys, overrides: [] };
	}

	private static _compare(a: { [key: string]: unknown }, b: { [key: string]: unknown }, prefix: string, keys: string[]): void {
		for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
			const aValue = a[key];
			const bValue = b[key];
			const path = prefix ? `${prefix}.${key}` : key;

			if (isObject(aValue) && isObject(bValue)) {
				ConfigurationModel._compare(aValue, bValue, path, keys);
				continue;
			}
			if (!equals(aValue, bValue)) {
				// a changed leaf, or a key that appeared/vanished
				keys.push(path);
			}
		}
	}
}

function equals(a: unknown, b: unknown): boolean {
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((element, index) => element === b[index]);
	}
	return a === b;
}

export class ConfigurationChangeEvent implements IConfigurationChangeEvent {

	constructor(
		readonly source: ConfigurationTarget,
		readonly change: IConfigurationChange
	) { }

	get affectedKeys(): ReadonlySet<string> {
		return new Set(this.change.keys);
	}

	affectsConfiguration(section: string): boolean {
		for (const key of this.change.keys) {
			if (key === section || key.startsWith(`${section}.`) || section.startsWith(`${key}.`)) {
				return true;
			}
		}
		return false;
	}
}
