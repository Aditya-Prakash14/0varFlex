// src/main/update/updateService.ts — the update loop, shaped after
// vs/platform/update/electron-main/abstractUpdateService.ts + updateService.darwin.ts:
//
//   - a small state machine (the real one has Uninitialized/Idle/CheckingForUpdates/
//     AvailableForDownload/Downloading/Downloaded/Ready/Restarting — this keeps the subset a
//     generic-provider app needs and names the states the same way);
//   - checks on a timer (30s in this build) and on demand; a downloaded update becomes Ready and
//     the workbench offers "Restart to Update" (the real one badges the gear / shows a
//     notification);
//   - the actual install is electron-updater's `quitAndInstall()` — the standard consumer of the
//     same feed contract VS Code's own updater implements (latest-mac.yml + a static server).
//
// Only runs in a PACKAGED app: electron-updater refuses to update a dev run, and a dev run has
// no app-update.yml to read the feed from.

import { Event, Emitter } from '../../common/base/common/event.js';
import type { ILogService } from '../../common/platform/log/common/log.js';
import { app } from 'electron';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export type UpdateStateType =
	| 'uninitialized'
	| 'idle'
	| 'checking'
	| 'available'
	| 'downloading'
	| 'ready'
	| 'updating';

export interface IUpdateState {
	readonly type: UpdateStateType;
	/** set for available/downloading/ready/updating */
	readonly version?: string;
	/** the last error message (idle carries it so the UI can log/ignore quietly) */
	readonly error?: string;
	/** true when the user asked for the check (drives the "no updates" toast) */
	readonly explicit?: boolean;
}

export interface IUpdateService {
	readonly onDidChangeState: Event<IUpdateState>;
	readonly state: IUpdateState;
	checkForUpdates(explicit: boolean): Promise<IUpdateState>;
	/** Ready → quit and install (electron-updater swaps the zip and relaunches) */
	restartToUpdate(): void;
	/** starts the periodic checks (packaged apps only) */
	start(): void;
}

export interface IUpdateServiceOptions {
	readonly logService: ILogService;
	readonly isPackaged: boolean;
	/** the ported 30s dev cadence; a real app checks every few hours */
	readonly checkIntervalMs?: number;
}

/**
 * 14: the ad-hoc install fallback. Squirrel.Mac derives its requirement from the RUNNING app's
 * code signature — for an ad-hoc signature that requirement is the cdhash, which no rebuilt app
 * can satisfy, so a local ad-hoc-signed build can download but never install through the native
 * updater. When the signature check rejects a downloaded update we take the cached zip, replace
 * the .app after this process exits, and relaunch. A Developer-ID-signed build takes the normal
 * quitAndInstall path and never lands here (delta documented in build/README.md).
 */
function describeSignature(bundle: string): string {
	try {
		const result = spawnSync('codesign', ['-dv', bundle], { encoding: 'utf8' });
		// codesign -dv writes its report to stderr
		return `${result.stdout ?? ''}${result.stderr ?? ''}`;
	} catch {
		return '';
	}
}

function installDownloadedZip(version: string | undefined): boolean {
	if (process.platform !== 'darwin') {
		return false;
	}
	// electron-updater's cache dir: the platform cache dir + updaterCacheDirName (app-update.yml)
	const pending = path.join(app.getPath('home'), 'Library', 'Caches', '0varflex-updater', 'pending');
	let zipPath: string | undefined;
	try {
		const candidates = readdirSync(pending)
			.filter(name => name.endsWith('.zip'))
			.map(name => path.join(pending, name))
			.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
		zipPath = candidates.find(candidate => !version || candidate.includes(version)) ?? candidates[0];
	} catch {
		// no cache directory: nothing downloaded yet
	}
	if (!zipPath) {
		return false;
	}
	// exe = <bundle>/Contents/MacOS/<name>
	const bundle = path.dirname(path.dirname(path.dirname(app.getPath('exe'))));
	// relaunch with the same argv the app was started with (electron-updater does the same):
	// a `--remote-debugging-port` or protocol arg survives the update
	const relaunchArgs = process.argv.slice(1).filter(argument => argument !== '.').map(argument => JSON.stringify(argument)).join(' ');
	const script = [
		`while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done`,
		`rm -rf ${JSON.stringify(bundle)}`,
		`ditto -x -k ${JSON.stringify(zipPath)} ${JSON.stringify(path.dirname(bundle))}`,
		`open -a ${JSON.stringify(bundle)}${relaunchArgs ? ` --args ${relaunchArgs}` : ''}`
	].join(' && ');
	spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref();
	return true;
}

export function createUpdateService(options: IUpdateServiceOptions): IUpdateService {
	const checkIntervalMs = options.checkIntervalMs ?? 30_000;
	const log = (message: string) => options.logService.info(`[update] ${message}`);

	let state: IUpdateState = { type: options.isPackaged ? 'idle' : 'uninitialized', ...(options.isPackaged ? {} : { error: 'the app is not packaged: updates are disabled' }) };
	const onDidChangeState = new Emitter<IUpdateState>();
	let updater: typeof import('electron-updater').autoUpdater | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	/** Squirrel rejected the download's ad-hoc signature: Restart installs the cached zip instead */
	let squirrelRejected = false;
	// exe = <bundle>/Contents/MacOS/<name>
	const bundlePath = path.dirname(path.dirname(path.dirname(app.getPath('exe'))));
	/** this build's signature is ad-hoc → Squirrel.Mac will reject every update's requirement */
	const adHocSigned = options.isPackaged && /Signature=adhoc/i.test(describeSignature(bundlePath));

	const setState = (next: IUpdateState): IUpdateState => {
		state = next;
		onDidChangeState.fire(next);
		return next;
	};

	if (options.isPackaged) {
		// the require is deferred to the packaged path so a dev run never loads the updater
		// (electron-updater reads app-update.yml on import)
		void import('electron-updater').then(({ autoUpdater }) => {
			updater = autoUpdater;
			autoUpdater.autoDownload = true;
			// the user owns the Restart click: installing silently on quit would hide the
			// "accept → quit → update → relaunch" story (and the fallback needs a clean exit)
			autoUpdater.autoInstallOnAppQuit = false;
			autoUpdater.on('checking-for-update', () => setState({ type: 'checking' }));
			autoUpdater.on('update-available', info => {
				log(`available: ${info.version}`);
				setState({ type: 'available', version: info.version });
			});
			autoUpdater.on('update-not-available', () => {
				log('no update available');
				setState({ type: 'idle' });
			});
			autoUpdater.on('download-progress', progress => {
				setState({ type: 'downloading', version: state.version, error: `${Math.round(progress.percent)}%` });
			});
			autoUpdater.on('update-downloaded', info => {
				log(`downloaded: ${info.version}`);
				setState({ type: 'ready', version: info.version });
			});
			autoUpdater.on('error', error => {
				const message = error.message;
				log(`error: ${message}`);
				// a downloaded update rejected by Squirrel's signature check: keep the state at
				// "ready" so Restart stays visible — the click installs the cached zip locally
				if ((state.type === 'ready' || state.type === 'updating') && /code signature/i.test(message)) {
					squirrelRejected = true;
					log('the native installer rejected the ad-hoc signature; Restart will install the zip locally');
					setState({ type: 'ready', version: state.version });
					return;
				}
				// offline servers must fail QUIETLY: log the line, stay idle
				setState({ type: 'idle', error: message });
			});
		}).catch(error => {
			log(`the updater failed to load: ${(error as Error).message}`);
		});
	}

	return {
		onDidChangeState: onDidChangeState.event,
		get state() {
			return state;
		},
		async checkForUpdates(explicit: boolean): Promise<IUpdateState> {
			if (!updater) {
				if (explicit) {
					setState({ type: 'idle', error: 'updates are unavailable in this build', explicit });
				}
				return state;
			}
			// already downloaded and waiting for the Restart click: re-checking would only
			// re-download the same zip (the periodic timer must not loop on it)
			if (state.type === 'ready' || state.type === 'updating') {
				return state;
			}
			setState({ type: 'checking', explicit });
			try {
				await updater.checkForUpdates();
			} catch (error) {
				// the 'error' event above usually fires first; this catches the promise path
				log(`check failed: ${(error as Error).message}`);
				setState({ type: 'idle', error: (error as Error).message, explicit });
			}
			return state;
		},
		restartToUpdate(): void {
			if (!updater || state.type !== 'ready') {
				return;
			}
			setState({ type: 'updating', version: state.version });
			if (adHocSigned || squirrelRejected) {
				// a real Developer ID signature takes the native path; an ad-hoc one cannot (its
				// designated requirement is the cdhash), so install the cached zip ourselves
				log(`local install fallback for ${state.version} (ad-hoc signature)`);
				if (installDownloadedZip(state.version)) {
					setTimeout(() => app.quit(), 100);
					return;
				}
				setState({ type: 'idle', error: 'the downloaded update could not be located in the cache' });
				return;
			}
			log(`quitAndInstall for ${state.version}`);
			// isSilent=false, isForceRunAfter=true: quit, swap, relaunch — the ported flow
			setTimeout(() => updater!.quitAndInstall(false, true), 100);
		},
		start(): void {
			if (!options.isPackaged || timer !== undefined) {
				return;
			}
			timer = setInterval(() => void this.checkForUpdates(false), checkIntervalMs);
			// the first check shortly after launch (the real one also staggers)
			setTimeout(() => void this.checkForUpdates(false), 5_000);
		}
	};
}
