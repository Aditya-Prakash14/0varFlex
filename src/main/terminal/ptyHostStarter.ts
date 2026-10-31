// src/main/terminal/ptyHostStarter.ts — spawn the pty host utility process + the port handoff,
// ported in shape from vs/platform/terminal/node/nodePtyHostStarter.ts:
//
//   - one utility process per window; the MessagePort dance mirrors 11's extension host
//     (main keeps neither end: port1 → child, port2 → the renderer's preload);
//   - the exit watchdog tells the renderer (all terminals die together);
//   - `// shortcut: no reconnect` — the real starter restarts the host and the workbench offers
//     "restore terminals"; here the renderer lazily respawns on the next createTerminal.

import { app, MessageChannelMain, utilityProcess, UtilityProcess, WebContents } from 'electron';
import * as path from 'node:path';
import { Emitter, Event } from '../../common/base/common/event.js';
import { MINI_PTY_HOST_CHANNEL } from '../../common/base/parts/ipc/ipc.electron.js';

export { MINI_PTY_HOST_CHANNEL };

export class PtyHostStarter {

	private _child: UtilityProcess | null = null;

	private readonly _onDidExit = new Emitter<number | undefined>();
	readonly onDidExit: Event<number | undefined> = this._onDidExit.event;

	constructor(private readonly _getWebContents: () => WebContents | undefined) { }

	isRunning(): boolean {
		return this._child !== null;
	}

	start(): void {
		const webContents = this._getWebContents();
		if (!webContents || webContents.isDestroyed()) {
			return;
		}
		if (this._child) {
			// a duplicate start (the renderer reloaded): the old port is dead — restart cleanly
			this.kill();
		}

		const { port1, port2 } = new MessageChannelMain();
		const hostPath = path.join(app.getAppPath(), 'out', 'ptyHost.cjs');
		const child = utilityProcess.fork(hostPath, [], {
			serviceName: 'mini-vscode pty host',
			stdio: 'inherit',
			// the host stamps TERM_PROGRAM_VERSION from this
			env: { ...process.env, MINI_VSCODE_VERSION: app.getVersion() }
		});
		this._child = child;

		child.on('exit', code => {
			if (this._child === child) {
				this._child = null;
			}
			this._onDidExit.fire(code);
			if (!webContents.isDestroyed()) {
				webContents.send(MINI_PTY_HOST_CHANNEL, { type: 'exit', code });
			}
		});

		// the documented direction: port1 → the child, port2 → the renderer
		child.postMessage({ type: 'port' }, [port1]);
		webContents.postMessage(MINI_PTY_HOST_CHANNEL, { type: 'port' }, [port2]);
		child.once('spawn', () => console.log(`[main] pty host started (pid ${child.pid})`));
	}

	kill(): void {
		if (this._child) {
			try {
				this._child.kill();
			} catch {
				// already gone
			}
			this._child = null;
		}
	}
}
