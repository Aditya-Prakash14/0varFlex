// src/common/platform/log/common/logIpc.ts — the log channel shape (renderer → main).

import { LogLevel } from './log.js';

export interface ILogChannel {
	// a wire round trip: the promise lets the renderer swallow "main is gone"
	log(level: LogLevel, message: string): Promise<void>;
}
