// src/main/mainPaths.ts — asar-aware path resolution for the things main SPAWNS.
//
// Electron patches fs so reads inside app.asar work transparently, but `exec` does not: a
// utilityProcess.fork or child_process.spawn of a script inside the asar fails. The bundles
// listed in `asarUnpack` (electron-builder.config.cjs) exist at `<app.asar.unpacked>/<relative>`
// — this maps an app-relative path there. In dev there is no asar: the replace is a no-op.

import { app } from 'electron';
import path from 'node:path';

/** `<app>/out/extHost.cjs` → `<app>/out/extHost.cjs` (dev) or the app.asar.unpacked sibling */
export function unpackedPath(...relative: string[]): string {
	const absolute = path.join(app.getAppPath(), ...relative);
	return absolute.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}
