// src/main/extensionHost.ts — the extension host launcher, ported in shape from
// vs/workbench/services/extensions/electron-browser/extensionHost.ts:
//
//   - MAIN forks the utility process and creates ONE MessageChannelMain;
//   - the child gets `port1` (the transfer direction is documented here because getting it
//     wrong is silent: the renderer NEVER receives `port1`, and main keeps NEITHER end);
//   - the renderer gets `port2` through its preload, which wraps the MessagePort in plain
//     functions (a port cannot cross contextBridge directly);
//   - main keeps an exit watchdog: child exit → the renderer hears about it, the host is
//     respawned on the next start (reload).

import { app, MessageChannelMain, utilityProcess, UtilityProcess, WebContents } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Emitter, Event } from '../common/base/common/event.js';
import { MINI_EXT_HOST_CHANNEL } from '../common/base/parts/ipc/ipc.electron.js';
import { unpackedPath } from './mainPaths.js';
import { IExtensionScanResult, IScannerFileSystem, parseManifestCache, scanExtensions } from '../common/platform/extensions/common/extensionScanner.js';
import type { ILogService } from '../common/platform/log/common/log.js';

export { MINI_EXT_HOST_CHANNEL };

export class ExtensionHostLauncher {

	private _child: UtilityProcess | null = null;

	private readonly _onDidExit = new Emitter<number | undefined>();
	readonly onDidExit: Event<number | undefined> = this._onDidExit.event;

	constructor(private readonly _getWebContents: () => WebContents | undefined) { }

	isRunning(): boolean {
		return this._child !== null;
	}

	/**
	 * One utility process per window; a reload asks again, and the previous child is killed on
	 * renderer navigation (see channels.ts), so five reloads never accumulate processes.
	 */
	start(): void {
		const webContents = this._getWebContents();
		if (!webContents || webContents.isDestroyed()) {
			return;
		}
		if (this._child) {
			// already running (a duplicate start): hand a fresh port pair to the same child? The
			// renderer reloaded, so the child's old port is dead — restart cleanly instead.
			this.kill();
		}

		const { port1, port2 } = new MessageChannelMain();
		// the bundle lives OUTSIDE the asar (asarUnpack): exec cannot read inside it
		const hostPath = unpackedPath('out', 'extHost.cjs');
		const child = utilityProcess.fork(hostPath, [], {
			serviceName: 'mini-vscode extension host',
			stdio: 'inherit'
		});
		this._child = child;

		child.on('exit', code => {
			if (this._child === child) {
				this._child = null;
			}
			this._onDidExit.fire(code);
			// the renderer's lifecycle note (the port itself is dead at this point)
			if (!webContents.isDestroyed()) {
				webContents.send(MINI_EXT_HOST_CHANNEL, { type: 'exit', code });
			}
		});

		// the documented direction: port1 → the child, port2 → the renderer
		child.postMessage({ type: 'port' }, [port1]);
		webContents.postMessage(MINI_EXT_HOST_CHANNEL, { type: 'port' }, [port2]);
		child.once('spawn', () => console.log(`[main] extension host started (pid ${child.pid})`));
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

// ---- the scanner endpoint (main owns the file system; the renderer asks for results)

const nodeScannerFileSystem: IScannerFileSystem = {
	async readdir(directoryPath) {
		const entries = await fs.readdir(directoryPath, { withFileTypes: true });
		return entries.map(entry => ({ name: entry.name, isDirectory: entry.isDirectory() }));
	},
	readFile: filePath => fs.readFile(filePath, 'utf8'),
	async stat(filePath) {
		const info = await fs.stat(filePath);
		return { mtimeMs: info.mtimeMs };
	}
};

/** scans `<app>/extensions` (builtin) + `<userData>/extensions` (user), cache in userData */
export async function scanExtensionsMain(logService: ILogService): Promise<IExtensionScanResult> {
	const userDataPath = app.getPath('userData');
	const cachePath = path.join(userDataPath, 'extensions.json');
	const cacheText = await fs.readFile(cachePath, 'utf8').then(text => text, () => null);
	const cache = parseManifestCache(cacheText);

	const started = Date.now();
	const { result, cache: nextCache } = await scanExtensions(nodeScannerFileSystem, {
		directories: [
			{ path: path.join(app.getAppPath(), 'extensions'), kind: 'builtin' },
			{ path: path.join(userDataPath, 'extensions'), kind: 'user' }
		],
		currentVersion: app.getVersion(),
		cache,
		log: {
			info: message => logService.info(`[extensions] ${message}`),
			warn: message => logService.warn(`[extensions] ${message}`),
			error: message => logService.error(`[extensions] ${message}`)
		}
	});

	await fs.writeFile(cachePath, JSON.stringify(nextCache, undefined, '\t'), 'utf8').catch(() => { /* cache is best-effort */ });
	logService.info(`[extensions] scan finished: ${result.extensions.length} extension(s) out of ${result.scanned} director(ies) in ${Date.now() - started}ms (${result.cacheHits} cached)`);
	return result;
}
