// src/common/platform/fileIO/common/fileIO.ts — the file I/O channel: the interface both sides
// share and the hand-written client. (Contrast with log/window, which go through ProxyChannel —
// this one shows the manual layer the proxy abstracts when a channel needs per-path `arg`
// subscriptions.)
//
// shortcut: everything crossing the wire is JSON-safe — paths are plain strings, so this channel
// needs no IURITransformer (upstream's URI marshalling problem, not ours yet).

import { Event } from '../../../base/common/event.js';
import { IChannel } from '../../../base/parts/ipc/ipc.js';

export interface IFileIOChannel {

	readTextFile(path: string): Promise<string | null>;
	writeTextFile(path: string, content: string): Promise<void>;
	exists(path: string): Promise<boolean>;

	// the dev hooks and state persistence need a place to write to
	getHomePath(): Promise<string>;
	getUserDataPath(): Promise<string>;

	deleteFile(path: string): Promise<void>;

	// per-path watch: the path travels as the `arg` of IServerChannel.listen
	onDidChangeFile(path: string): Event<void>;
}

export class FileIOChannelClient implements IFileIOChannel {

	constructor(private readonly channel: IChannel) { }

	readTextFile(path: string): Promise<string | null> {
		return this.channel.call('readTextFile', [path]);
	}

	writeTextFile(path: string, content: string): Promise<void> {
		return this.channel.call('writeTextFile', [path, content]);
	}

	exists(path: string): Promise<boolean> {
		return this.channel.call('exists', [path]);
	}

	getHomePath(): Promise<string> {
		return this.channel.call('getHomePath', []);
	}

	getUserDataPath(): Promise<string> {
		return this.channel.call('getUserDataPath', []);
	}

	deleteFile(path: string): Promise<void> {
		return this.channel.call('deleteFile', [path]);
	}

	onDidChangeFile(path: string): Event<void> {
		return this.channel.listen('onDidChangeFile', path);
	}
}
