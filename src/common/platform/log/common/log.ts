// src/common/platform/log/common/log.ts — the first real service.
// Simplified ILogService: info/warn/error/trace + onDidLog.
// Skipped upstream: log levels configuration, file outputs, ILogger/ILoggerService split.

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const ILogService = createDecorator<ILogService>('logService');

export type LogLevel = 'trace' | 'info' | 'warn' | 'error';

export interface ILogMessage {
	readonly level: LogLevel;
	readonly message: string;
}

export interface ILogService {

	readonly _serviceBrand: undefined;

	readonly onDidLog: Event<ILogMessage>;

	trace(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string | Error, ...args: unknown[]): void;
}
