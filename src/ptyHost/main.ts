// src/ptyHost/main.ts — the pty host entry, mirroring 11's extension host: main forks this
// utility process and transfers ONE MessagePort; this file receives it and serves the
// PTY_HOST_CHANNEL. No renderer → host method calls exist beyond the proxied service, and the
// events ride the same channel via `listen` (02's proxy channels).

import { Emitter } from '../common/base/common/event.js';
import { DisposableStore } from '../common/base/common/lifecycle.js';
import { ChannelServer, ProxyChannel } from '../common/base/parts/ipc/ipc.js';
import { PTY_HOST_CHANNEL } from '../common/platform/terminal/common/terminal.js';
import { PtyService } from './ptyService.js';

function log(message: string): void {
	process.stderr.write(`[ptyHost] ${message}\n`);
}

export function runHost(port: Electron.MessagePortMain): void {
	const store = new DisposableStore();
	const service = new PtyService();
	const onMessage = new Emitter<unknown>();
	port.on('message', message => onMessage.fire(message.data));
	port.start();

	const protocol = {
		onMessage: onMessage.event,
		send: (message: unknown): void => port.postMessage(message)
	};
	const server = new ChannelServer<string>(protocol, 'ptyHost');
	server.registerChannel(PTY_HOST_CHANNEL, ProxyChannel.fromService<string>({
		$createProcess: (options: never) => service.createProcess(options),
		$start: (id: number) => service.start(id),
		$input: (id: number, data: string) => service.input(id, data),
		$ackData: (id: number, charCount: number) => service.ackData(id, charCount),
		$resize: (id: number, cols: number, rows: number) => service.resize(id, cols, rows),
		$shutdown: (id: number) => service.shutdown(id),
		$dispose: () => service.dispose(),
		$hasChildProcesses: (id: number) => service.hasChildProcesses(id),
		onProcessData: service.onProcessData,
		onProcessReady: service.onProcessReady,
		onProcessExit: service.onProcessExit
	}, store));

	// the port closing means the window is gone: kill every pty so nothing is orphaned
	port.on('close', () => {
		log('the port closed — disposing all terminals');
		service.dispose();
		store.dispose();
	});
	log('pty host ready');
}

process.on('uncaughtException', error => log(`uncaughtException: ${error.message}`));
process.on('unhandledRejection', reason => log(`unhandledRejection: ${String(reason)}`));

// the port arrives from main (main keeps neither end)
if (typeof process.parentPort !== 'undefined') {
	process.parentPort.once('message', message => {
		const port = message.ports[0];
		if (port) {
			runHost(port);
		}
	});
}

export { log };
