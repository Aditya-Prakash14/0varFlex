// src/common/platform/configuration/common/configuration.ts — the public contract, ported from
// vs/platform/configuration/common/configuration.ts. Implemented here: DEFAULT + USER targets
// (WORKSPACE arrives when 10 knows folders).

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const enum ConfigurationTarget {
	APPLICATION = 1,
	USER,
	USER_LOCAL,
	USER_REMOTE,
	WORKSPACE,
	WORKSPACE_FOLDER,
	DEFAULT,
	MEMORY
}

export function ConfigurationTargetToString(configurationTarget: ConfigurationTarget): string {
	switch (configurationTarget) {
		case ConfigurationTarget.APPLICATION: return 'APPLICATION';
		case ConfigurationTarget.USER: return 'USER';
		case ConfigurationTarget.WORKSPACE: return 'WORKSPACE';
		case ConfigurationTarget.WORKSPACE_FOLDER: return 'WORKSPACE_FOLDER';
		case ConfigurationTarget.DEFAULT: return 'DEFAULT';
		default: return 'MEMORY';
	}
}

export interface IConfigurationChange {
	/** the changed leaf key paths, e.g. ['editor.fontSize'] */
	readonly keys: string[];
	readonly overrides: [string, string[]][];
}

export interface IConfigurationChangeEvent {
	readonly source: ConfigurationTarget;
	readonly affectedKeys: ReadonlySet<string>;
	readonly change: IConfigurationChange;
	affectsConfiguration(configuration: string): boolean;
}

/**
 * The shape `inspect()` returns. This is the classic per-target view (defaultValue/userValue/…);
 * the reference revision moved to a thinner shape — the course's acceptance pins this one.
 */
export interface IInspectValue<T> {
	readonly defaultValue?: T;
	readonly userValue?: T;
	readonly workspaceValue?: T;
	readonly value?: T;
}

export interface IConfigurationService {
	readonly _serviceBrand: undefined;

	getValue<T>(key: string): T | undefined;
	inspect<T>(key: string): IInspectValue<T>;
	updateValue(key: string, value: unknown, target?: ConfigurationTarget): Promise<void>;

	readonly onDidChangeConfiguration: Event<IConfigurationChangeEvent>;
}

export const IConfigurationService = createDecorator<IConfigurationService>('configurationService');

// ---- value-tree helpers (ported from the reference)

export function toValuesTree(properties: { [key: string]: unknown }, conflictReporter: (message: string) => void): { [key: string]: unknown } {
	const root = Object.create(null);
	for (const key of Object.keys(properties)) {
		addToValueTree(root, key, properties[key], conflictReporter);
	}
	return root;
}

export function addToValueTree(settingsTreeRoot: { [key: string]: unknown }, key: string, value: unknown, conflictReporter: (message: string) => void): void {
	const segments = key.split('.');
	const last = segments.pop()!;

	let current = settingsTreeRoot;
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		let obj = current[segment];
		switch (typeof obj) {
			case 'undefined':
				obj = current[segment] = Object.create(null);
				break;
			case 'object':
				if (obj === null) {
					conflictReporter(`Ignoring ${key} as ${segments.slice(0, i + 1).join('.')} is null`);
					return;
				}
				break;
			default:
				conflictReporter(`Ignoring ${key} as ${segments.slice(0, i + 1).join('.')} is ${JSON.stringify(obj)}`);
				return;
		}
		current = obj as { [key: string]: unknown };
	}

	if (typeof current === 'object' && current !== null) {
		try {
			current[last] = value;
		} catch {
			conflictReporter(`Ignoring ${key} as ${segments.join('.')} is ${JSON.stringify(current)}`);
		}
	} else {
		conflictReporter(`Ignoring ${key} as ${segments.join('.')} is ${JSON.stringify(current)}`);
	}
}

export function removeFromValueTree(valueTree: { [key: string]: unknown }, key: string): void {
	const segments = key.split('.');
	const doRemove = (node: { [key: string]: unknown }, index: number): boolean => {
		if (index === segments.length) {
			return true;
		}
		const segment = segments[index];
		const child = node[segment];
		if (!child || typeof child !== 'object') {
			return false;
		}
		const shouldDelete = doRemove(child as { [key: string]: unknown }, index + 1);
		if (shouldDelete && Object.keys(child).length === 0) {
			delete node[segment];
		}
		return false;
	};
	doRemove(valueTree, 0);
}
