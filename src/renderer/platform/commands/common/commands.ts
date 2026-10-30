// src/renderer/platform/commands/common/commands.ts — ported from
// vs/platform/commands/common/commands.ts, simplified: one executor per id (upstream stacks a
// LinkedList per id) and palette metadata in a separate registry — the exercise's stand-in for
// upstream's split between CommandsRegistry and MenuRegistry contributions.

import { Emitter, Event } from '../../../../common/base/common/event.js';
import { IDisposable, toDisposable } from '../../../../common/base/common/lifecycle.js';
import { createDecorator, ServicesAccessor } from '../../../../common/platform/instantiation/common/instantiation.js';
import { ContextKeyExpression } from '../../contextkey/common/contextkey.js';

export const ICommandService = createDecorator<ICommandService>('commandService');

export interface ICommandEvent {
	readonly commandId: string;
	readonly args: unknown[];
}

export interface ICommandService {
	readonly _serviceBrand: undefined;
	readonly onWillExecuteCommand: Event<ICommandEvent>;
	readonly onDidExecuteCommand: Event<ICommandEvent>;
	executeCommand<R = unknown>(commandId: string, ...args: unknown[]): Promise<R | undefined>;
}

export type ICommandHandler<Args extends unknown[] = unknown[], R = unknown> = (accessor: ServicesAccessor, ...args: Args) => R;

export interface ICommand<Args extends unknown[] = unknown[], R = unknown> {
	readonly id: string;
	readonly handler: ICommandHandler<Args, R>;
}

/** Palette-facing metadata; the executor lives in CommandsRegistry, the rest lives here. */
export interface ICommandMetadata {
	readonly id: string;
	readonly title: string;
	readonly category?: string;
	/** gates *surfacing* (e.g. the palette), never execution */
	readonly precondition?: ContextKeyExpression;
}

export namespace CommandsRegistry {

	// eslint-disable-next-line local/code-no-any-casts
	const _commands = new Map<string, ICommand<any>>();

	const _onDidRegisterCommand = new Emitter<string>();
	export const onDidRegisterCommand: Event<string> = _onDidRegisterCommand.event;

	export function registerCommand<Args extends unknown[] = unknown[]>(idOrCommand: string | ICommand<Args>, handler?: ICommandHandler<Args>): IDisposable {
		if (!idOrCommand) {
			throw new Error('invalid command');
		}

		const command: ICommand<any> = typeof idOrCommand === 'string'
			? { id: idOrCommand, handler: handler as ICommandHandler<any> }
			: idOrCommand as ICommand<any>;

		_commands.set(command.id, command);
		_onDidRegisterCommand.fire(command.id);

		return toDisposable(() => {
			if (_commands.get(command.id) === command) {
				_commands.delete(command.id);
			}
		});
	}

	export function registerCommandAlias(oldId: string, newId: string): IDisposable {
		return registerCommand(oldId, (accessor: ServicesAccessor, ...args: unknown[]) => accessor.get(ICommandService).executeCommand(newId, ...args));
	}

	export function getCommand(id: string): ICommand | undefined {
		return _commands.get(id);
	}

	export function getCommands(): Map<string, ICommand> {
		return new Map(_commands);
	}
}

export namespace CommandMetadata {

	const _metadata = new Map<string, ICommandMetadata>();

	export function register(metadata: ICommandMetadata): IDisposable {
		_metadata.set(metadata.id, metadata);
		return toDisposable(() => {
			if (_metadata.get(metadata.id) === metadata) {
				_metadata.delete(metadata.id);
			}
		});
	}

	export function get(id: string): ICommandMetadata | undefined {
		return _metadata.get(id);
	}

	export function all(): ICommandMetadata[] {
		return [..._metadata.values()];
	}
}
