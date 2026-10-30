// src/renderer/platform/log/common/logService.ts — writes to console with a [renderer] prefix.

import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogMessage, ILogService, LogLevel } from './log.js';

const PREFIX = '[renderer]';

export class LogService extends Disposable implements ILogService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidLog = this._register(new Emitter<ILogMessage>());
	readonly onDidLog = this._onDidLog.event;

	trace(message: string, ...args: unknown[]): void {
		this._log('trace', message, args);
	}

	info(message: string, ...args: unknown[]): void {
		this._log('info', message, args);
	}

	warn(message: string, ...args: unknown[]): void {
		this._log('warn', message, args);
	}

	error(message: string | Error, ...args: unknown[]): void {
		this._log('error', message instanceof Error ? message.message : message, args, message);
	}

	private _log(level: LogLevel, message: string, args: unknown[], original?: unknown): void {
		console[level](PREFIX, original ?? message, ...args);
		this._onDidLog.fire({ level, message });
	}
}
