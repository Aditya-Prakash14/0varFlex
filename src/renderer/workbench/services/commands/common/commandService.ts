// src/renderer/workbench/services/commands/common/commandService.ts — ported in spirit from
// vs/workbench/services/commands/common/commandService.ts: the registry knows *executors*, this
// service adds *execution policy* (events, error handling, activation later).

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { Disposable } from '../../../../../common/base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../common/platform/instantiation/common/instantiation.js';
import type { ILogService } from '../../../../../common/platform/log/common/log.js';
import { CommandsRegistry, ICommandEvent, ICommandService } from '../../../../platform/commands/common/commands.js';

export class CommandService extends Disposable implements ICommandService {

	declare readonly _serviceBrand: undefined;

	private readonly _onWillExecuteCommand = this._register(new Emitter<ICommandEvent>());
	readonly onWillExecuteCommand: Event<ICommandEvent> = this._onWillExecuteCommand.event;

	private readonly _onDidExecuteCommand = this._register(new Emitter<ICommandEvent>());
	readonly onDidExecuteCommand: Event<ICommandEvent> = this._onDidExecuteCommand.event;

	constructor(
		private readonly _instantiationService: IInstantiationService,
		private readonly _logService: ILogService
	) {
		super();
	}

	async executeCommand<R = unknown>(id: string, ...args: unknown[]): Promise<R | undefined> {
		this._logService.trace(`CommandService#executeCommand ${id}`);

		// TODO(11): this is where extension activation hooks in — upstream activates
		// 'onCommand:${id}' before dispatching to a command an extension might own
		const command = CommandsRegistry.getCommand(id);
		if (!command) {
			const error = new Error(`command '${id}' not found`);
			this._logService.error(error.message);
			return Promise.reject(error);
		}

		try {
			this._onWillExecuteCommand.fire({ commandId: id, args });
			const result = this._instantiationService.invokeFunction(command.handler, ...args);
			return Promise.resolve(result).then(
				value => {
					this._onDidExecuteCommand.fire({ commandId: id, args });
					return value as R;
				},
				error => {
					// error path: fire, log (a notification layer arrives in 11), reject
					this._onDidExecuteCommand.fire({ commandId: id, args });
					this._logService.error(`command '${id}' failed: ${error instanceof Error ? error.message : String(error)}`);
					throw error;
				}
			);
		} catch (error) {
			this._onDidExecuteCommand.fire({ commandId: id, args });
			this._logService.error(`command '${id}' failed: ${error instanceof Error ? error.message : String(error)}`);
			return Promise.reject(error);
		}
	}
}
