// src/common/platform/log/common/logService.ts — writes to the console (dev) and forwards every
// line to the main process through the log channel.

import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogMessage, ILogService, LogLevel } from './log.js';
import { ILogChannel } from './logIpc.js';

const PREFIX = '[renderer]';

// dev: keep the renderer console too (upstream forwards and keeps local console in dev);
// prod: main is the only home
const MODE: 'dev' | 'prod' = 'dev';

export class LogService extends Disposable implements ILogService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidLog = this._register(new Emitter<ILogMessage>());
	readonly onDidLog = this._onDidLog.event;

	constructor(private readonly logChannel: ILogChannel) {
		super();
	}

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
		this._log('error', message instanceof Error ? message.message : message, args);
	}

	private _log(level: LogLevel, message: string, args: unknown[]): void {
		if (MODE === 'dev') {
			console[level](PREFIX, message, ...args);
		}
		this._onDidLog.fire({ level, message });

		// shortcut: log args are dropped at the wire (they must be JSON-safe anyway) — main gets
		// the message only
		void this.logChannel.log(level, message).catch(() => { /* main is gone — nothing left to log to */ });
	}
}
