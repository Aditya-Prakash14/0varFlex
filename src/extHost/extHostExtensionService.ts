// src/extHost/extHostExtensionService.ts — module loading + activation, ported in shape from
// vs/workbench/api/common/extHostExtensionService.ts: per-extension state
// (notActivated/activating/activated/failed), one activation per extension (the in-flight
// promise is cached), per-extension error isolation (one throw never takes the host down) and
// `deactivate()` on shutdown.

import * as path from 'node:path';
import type { IExtensionDescription } from '../common/platform/extensions/common/extensions.js';
import { setCurrentExtension } from './currentExtension.js';
import type { IMainThreadLog } from './mainThreadTypes.js';

export const enum ExtensionActivationState {
	NotActivated = 'notActivated',
	Activating = 'activating',
	Activated = 'activated',
	Failed = 'failed'
}

export interface IExtensionModule {
	activate(context: unknown): unknown;
	deactivate?: () => unknown;
}

interface IExtensionEntry {
	readonly description: IExtensionDescription;
	state: ExtensionActivationState;
	module?: IExtensionModule;
	activationPromise?: Promise<{ activationTimeMs: number }>;
}

export class ExtHostExtensionService {

	private readonly _entries = new Map<string, IExtensionEntry>();

	constructor(
		private readonly _log: IMainThreadLog,
		private readonly _createApi: (extension: IExtensionDescription, exports: unknown, require: NodeRequire) => unknown
	) { }

	$initialize(extensions: readonly IExtensionDescription[]): void {
		this._entries.clear();
		for (const description of extensions) {
			this._entries.set(description.identifier, { description, state: ExtensionActivationState.NotActivated });
		}
	}

	getExtensionsState(): { identifier: string; state: ExtensionActivationState }[] {
		return [...this._entries.values()].map(entry => ({ identifier: entry.description.identifier, state: entry.state }));
	}

	/** `$activateExtension` from the renderer: load the module, call activate() */
	async $activateExtension(identifier: string, reason: string): Promise<{ activationTimeMs: number }> {
		const entry = this._entries.get(identifier);
		if (!entry) {
			throw new Error(`unknown extension ${identifier}`);
		}
		if (entry.state === ExtensionActivationState.Activated) {
			return { activationTimeMs: 0 };
		}
		if (entry.activationPromise) {
			return entry.activationPromise; // in-flight activation: one activation, many waiters
		}

		entry.state = ExtensionActivationState.Activating;
		entry.activationPromise = this._doActivate(entry, reason).then(
			result => {
				entry.state = ExtensionActivationState.Activated;
				return result;
			},
			error => {
				entry.state = ExtensionActivationState.Failed;
				entry.activationPromise = undefined; // a retry may succeed after a fix + reload
				throw error;
			}
		);
		return entry.activationPromise;
	}

	private async _doActivate(entry: IExtensionEntry, reason: string): Promise<{ activationTimeMs: number }> {
		const started = Date.now();
		const { description } = entry;

		if (!description.main) {
			throw new Error(`extension ${description.identifier} has activationEvents but no main`);
		}
		const mainPath = path.join(description.extensionLocation, description.main);

		// load the module with the `vscode` module patched in (see main.ts's Module._load hook)
		setCurrentExtension(description.identifier);
		let module: IExtensionModule;
		try {
			module = require(mainPath) as IExtensionModule;
		} finally {
			setCurrentExtension(undefined);
		}
		entry.module = module;
		if (typeof module.activate !== 'function') {
			throw new Error(`extension ${description.identifier} is missing an activate() export`);
		}

		const api = this._createApi(description, module, require);
		const context = {
			subscriptions: [] as { dispose(): void }[],
			extensionPath: description.extensionLocation,
			extensionUri: { scheme: 'file', path: description.extensionLocation, fsPath: description.extensionLocation, toString: () => `file://${description.extensionLocation}` },
			extension: {
				id: description.identifier,
				displayId: description.displayId,
				packageJSON: {},
				extensionPath: description.extensionLocation,
				isActive: true,
				activate: () => this.$activateExtension(description.identifier, 'explicit')
			},
			globalState: makeMemoryState(),
			workspaceState: makeMemoryState(),
			asAbsolutePath: (relative: string) => path.join(description.extensionLocation, relative),
			storagePath: undefined,
			globalStoragePath: undefined,
			logPath: undefined
		};
		setCurrentExtension(description.identifier);
		try {
			await module.activate({ ...context, api });
		} finally {
			setCurrentExtension(undefined);
		}
		await this._log.$log('info', `Extension '${description.identifier}' activate() finished (reason: ${reason})`).catch(() => { /* ignore */ });
		return { activationTimeMs: Date.now() - started };
	}

	async deactivateAll(): Promise<void> {
		for (const entry of this._entries.values()) {
			if (entry.state === ExtensionActivationState.Activated && entry.module?.deactivate) {
				try {
					await entry.module.deactivate();
				} catch (error) {
					await this._log.$log('error', `deactivate() failed for ${entry.description.identifier}: ${(error as Error).message}`).catch(() => { /* ignore */ });
				}
			}
		}
	}
}

function makeMemoryState(): { get(key: string, defaultValue?: unknown): unknown; update(key: string, value: unknown): Promise<void> } {
	const values = new Map<string, unknown>();
	return {
		get: (key, defaultValue) => values.has(key) ? values.get(key) : defaultValue,
		update: async (key, value) => {
			values.set(key, value);
		}
	};
}
