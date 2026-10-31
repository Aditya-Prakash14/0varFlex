// src/extHost/extHostCommands.ts — `commands.registerCommand` semantics, ported from
// vs/workbench/api/common/extHostCommands.ts:
//
//   - one handler per id; a duplicate from the SAME extension replaces (disposable discipline),
//     a duplicate from ANOTHER extension is ignored with a warning (first wins);
//   - registering notifies the renderer (`MainThreadCommands.$registerCommand`) so the palette
//     and the command service see the command BEFORE activation;
//   - `$executeContributedCommand` is the renderer's entry to run the handler.

import type { IMainThreadCommands } from './mainThreadTypes.js';
import { setCurrentExtension } from './currentExtension.js';
import { Disposable } from './extHostTypes.js';

interface ICommandEntry {
	readonly handler: (...args: unknown[]) => unknown;
	readonly extensionId: string;
}

export class ExtHostCommands {

	private readonly _commands = new Map<string, ICommandEntry>();
	/** the ids this host registered, in order (debug/acceptance view) */
	readonly registeredIds: string[] = [];

	constructor(private readonly _proxy: IMainThreadCommands) { }

	registerCommand(extensionId: string, id: string, handler: (...args: unknown[]) => unknown): Disposable {
		const existing = this._commands.get(id);
		if (existing) {
			if (existing.extensionId === extensionId) {
				// same extension re-registering: replace, keeping one disposable per id
				this._commands.set(id, { handler, extensionId });
				return new Disposable(() => this._unregister(extensionId, id));
			}
			// first wins — the real ext host logs exactly this shape
			console.warn(`[${extensionId}] Command '${id}' already exists and is owned by '${existing.extensionId}'; registering it again has no effect.`);
			return new Disposable(() => { /* the command is not ours */ });
		}

		this._commands.set(id, { handler, extensionId });
		this.registeredIds.push(id);
		void this._proxy.$registerCommand(id).catch(error => {
			console.error(`[${extensionId}] could not register command ${id}: ${(error as Error).message}`);
		});
		return new Disposable(() => this._unregister(extensionId, id));
	}

	private _unregister(extensionId: string, id: string): void {
		const entry = this._commands.get(id);
		if (entry && entry.extensionId === extensionId) {
			this._commands.delete(id);
			const index = this.registeredIds.indexOf(id);
			if (index >= 0) {
				this.registeredIds.splice(index, 1);
			}
			void this._proxy.$unregisterCommand(id).catch(() => { /* renderer may be gone */ });
		}
	}

	/** the renderer's `$executeContributedCommand` */
	async $executeContributedCommand(id: string, args: unknown[]): Promise<unknown> {
		const entry = this._commands.get(id);
		if (!entry) {
			throw new Error(`command '${id}' not found`);
		}
		// errors propagate back to the renderer's executeCommand promise (and the log);
		// console output during the handler carries the owning extension's prefix
		setCurrentExtension(entry.extensionId);
		try {
			return await entry.handler(...(args ?? []));
		} finally {
			setCurrentExtension(undefined);
		}
	}

	hasCommand(id: string): boolean {
		return this._commands.has(id);
	}
}
