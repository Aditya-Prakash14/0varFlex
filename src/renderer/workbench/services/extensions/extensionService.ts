// src/renderer/workbench/services/extensions/extensionService.ts — the extension registry and
// activation engine, ported in shape from vs/workbench/services/extensions/common/extensionService.ts
// + extensionsActivator.ts:
//
//   - contributions register BEFORE activation (extensionRegistries does that at initialize);
//   - activation events (`onCommand:`, `onLanguage:`, `onStartupFinished`, `*`) map to extensions,
//     and each extension activates ONCE (the in-flight promise is cached — palette double-fire
//     must not double-activate);
//   - a failed activation never retries implicitly, never crashes the workbench, and is logged
//     with the extension id; the "activated in Nms" line is the ported user-visible one.

import { Emitter, Event } from '../../../../common/base/common/event.js';
import { Disposable, IDisposable } from '../../../../common/base/common/lifecycle.js';
import type { ILogService } from '../../../../common/platform/log/common/log.js';
import type { IScannedExtension } from '../../../../common/platform/extensions/common/extensionScanner.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import type { IExtensionDescription } from '../../../../common/platform/extensions/common/extensions.js';
import type { ExtensionHostManager } from './extensionHostManager.js';

export const enum ExtensionActivationState {
	NotActivated = 'notActivated',
	Activating = 'activating',
	Activated = 'activated',
	Failed = 'failed',
	/** the extension host is dead (crashed or never started) */
	Unavailable = 'unavailable'
}

export interface IExtensionActivationRecord {
	readonly identifier: string;
	state: ExtensionActivationState;
	activationTimeMs?: number;
}

export class ExtensionService extends Disposable {

	private _scanned: readonly IScannedExtension[] = [];
	private readonly _descriptions = new Map<string, IExtensionDescription>();
	private readonly _states = new Map<string, IExtensionActivationRecord>();
	private readonly _activationPromises = new Map<string, Promise<boolean>>();
	/** activation event → extension identifiers */
	private readonly _activationEvents = new Map<string, Set<string>>();
	private readonly _registeredCommands = new Map<string, IDisposable>();
	private _host: ExtensionHostManager | undefined;
	private _initializePromise: Promise<void> | undefined;

	private readonly _onDidChangeActivation = this._register(new Emitter<string>());
	readonly onDidChangeActivation: Event<string> = this._onDidChangeActivation.event;
	/** 11: the toast hook — bootstrap shows "Extension activation failed" for these */
	private readonly _onDidFailActivation = this._register(new Emitter<{ identifier: string; error: string }>());
	readonly onDidFailActivation: Event<{ identifier: string; error: string }> = this._onDidFailActivation.event;

	constructor(private readonly _logService: ILogService) {
		super();
	}

	get extensions(): readonly IExtensionDescription[] {
		return [...this._descriptions.values()];
	}

	get scanned(): readonly IScannedExtension[] {
		return this._scanned;
	}

	getExtension(identifier: string): IExtensionDescription | undefined {
		return this._descriptions.get(identifier);
	}

	getActivationState(identifier: string): ExtensionActivationState {
		return this._states.get(identifier)?.state ?? ExtensionActivationState.NotActivated;
	}

	getActivationRecords(): readonly IExtensionActivationRecord[] {
		return [...this._states.values()];
	}

	// ---- initialization (scan results → registries → host handshake)

	async initialize(options: {
		scanned: readonly IScannedExtension[];
		host: ExtensionHostManager;
		registerContributions: (extensions: readonly IScannedExtension[]) => void;
		initData: unknown;
	}): Promise<void> {
		if (this._initializePromise) {
			return this._initializePromise;
		}
		this._initializePromise = this._doInitialize(options);
		return this._initializePromise;
	}

	private async _doInitialize(options: {
		scanned: readonly IScannedExtension[];
		host: ExtensionHostManager;
		registerContributions: (extensions: readonly IScannedExtension[]) => void;
		initData: unknown;
	}): Promise<void> {
		this._scanned = options.scanned;
		this._host = options.host;
		for (const { description } of options.scanned) {
			this._descriptions.set(description.identifier, description);
			this._states.set(description.identifier, { identifier: description.identifier, state: ExtensionActivationState.NotActivated });
			for (const event of description.activationEvents) {
				let set = this._activationEvents.get(event);
				if (!set) {
					set = new Set();
					this._activationEvents.set(event, set);
				}
				set.add(description.identifier);
			}
		}

		// contributions first: the palette already lists extension commands before any activation
		options.registerContributions(options.scanned);

		// then the host: fork + port transfer + the initialize/ready handshake; failures leave
		// the app fully functional (the ported "host did not become ready" path)
		try {
			await options.host.start();
			await options.host.initialize(options.initData);
		} catch (error) {
			this._logService.error(`the extension host did not become ready: ${(error as Error).message}`);
			for (const record of this._states.values()) {
				record.state = ExtensionActivationState.Unavailable;
			}
		}
	}

	setHostUnavailable(): void {
		for (const record of this._states.values()) {
			// an activated extension whose host died cannot serve commands anymore: its state is
			// unavailable until the next reload respawns the host (a FAILED extension stays failed)
			if (record.state !== ExtensionActivationState.Failed) {
				record.state = ExtensionActivationState.Unavailable;
				this._onDidChangeActivation.fire(record.identifier);
			}
		}
	}

	// ---- contributed commands (registered by extensionRegistries AND by MainThreadCommands)

	/**
	 * Registers the command id in the workbench BEFORE activation. The handler activates the
	 * owning extension by `onCommand:${id}` and then dispatches into the host — the same seam
	 * CommandService uses (see its activation hook).
	 */
	ensureExtensionCommand(id: string): void {
		if (this._registeredCommands.has(id)) {
			return;
		}
		const disposable = CommandsRegistry.registerCommand(id, (_accessor, ...args: unknown[]) => {
			return this.activateByEvent(`onCommand:${id}`).then(activated => {
				if (!activated) {
					throw new Error(`command '${id}' could not run: its extension is not available`);
				}
				return this._host?.executeCommand(id, args);
			});
		});
		this._registeredCommands.set(id, disposable);
	}

	// ---- activation

	/**
	 * The activation entry point. `*` activates everything; other events activate their set
	 * (each extension at most once, in-flight activations shared).
	 */
	async activateByEvent(event: string): Promise<boolean> {
		if (!this._host?.isAlive) {
			return false;
		}
		let anyActivated = false;
		if (event === '*') {
			const results = await Promise.all([...this._descriptions.keys()].map(identifier => this.tryActivateExtension(identifier, event)));
			anyActivated = results.some(Boolean);
			return anyActivated;
		}
		const identifiers = this._activationEvents.get(event);
		if (!identifiers || identifiers.size === 0) {
			return false;
		}
		const results = await Promise.all([...identifiers].map(identifier => this.tryActivateExtension(identifier, event)));
		anyActivated = results.some(Boolean);
		return anyActivated;
	}

	/** resolves true when the extension ends up Activated (already-active counts) */
	async tryActivateExtension(identifier: string, reason: string): Promise<boolean> {
		const record = this._states.get(identifier);
		const host = this._host;
		if (!record || !host) {
			return false;
		}
		if (record.state === ExtensionActivationState.Activated) {
			return true;
		}
		if (record.state === ExtensionActivationState.Unavailable || !host.isAlive) {
			return false;
		}

		// the in-flight cache: two triggers racing must produce ONE activation
		const existing = this._activationPromises.get(identifier);
		if (existing) {
			return existing;
		}

		const promise = this._doActivate(identifier, reason, record, host);
		this._activationPromises.set(identifier, promise);
		const result = await promise;
		this._activationPromises.delete(identifier);
		return result;
	}

	private async _doActivate(identifier: string, reason: string, record: IExtensionActivationRecord, host: ExtensionHostManager): Promise<boolean> {
		record.state = ExtensionActivationState.Activating;
		this._onDidChangeActivation.fire(identifier);
		const started = Date.now();
		try {
			await host.activateExtension(identifier, reason);
			record.state = ExtensionActivationState.Activated;
			record.activationTimeMs = Date.now() - started;
			// the ported user-visible line
			this._logService.info(`Extension '${identifier}' activated in ${record.activationTimeMs}ms`);
			this._onDidChangeActivation.fire(identifier);
			return true;
		} catch (error) {
			record.state = ExtensionActivationState.Failed;
			const message = error instanceof Error ? error.message : String(error);
			this._logService.error(`Extension '${identifier}' activation FAILED: ${message}`);
			this._onDidFailActivation.fire({ identifier, error: message });
			this._onDidChangeActivation.fire(identifier);
			return false;
		}
	}

	/** `onStartupFinished` fires after the first render pass (bootstrap calls this) */
	async activateStartupFinished(): Promise<void> {
		await this.activateByEvent('onStartupFinished');
	}

	/** the documents service reports a newly opened document's language */
	async activateForLanguage(languageId: string): Promise<void> {
		await this.activateByEvent(`onLanguage:${languageId}`);
	}

	// ---- shutdown

	async shutdown(): Promise<void> {
		await this._host?.terminate();
	}
}
