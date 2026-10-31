// src/common/platform/cli/common/cliArgs.ts — the tiny decision table from the real
// `src/vs/code/node/cli.ts` + `cliArgs.ts`: a bare path becomes a file or a folder (decided by
// stat), `--open-file`/`--open-folder` force the kind, unknown flags are ignored.
//
// The real CLI runs the decision in node and forwards to a running instance over a socket; ours
// forwards through Electron's single-instance lock (argv comes back in `second-instance`) — the
// delta is documented in the README.

export type CliPathKind = 'file' | 'folder' | 'missing';

export interface ICliPath {
	readonly path: string;
	readonly kind: CliPathKind;
}

export interface ICliArgs {
	readonly paths: readonly ICliPath[];
	/** true when the process was launched by the `mini` CLI script (any --open-* flag) */
	readonly explicitOpen: boolean;
}

export const OPEN_FILE_FLAG = '--open-file';
export const OPEN_FOLDER_FLAG = '--open-folder';

/**
 * Pure: the caller passes a `stat` classifier so the table is unit-testable.
 * `argv` is already stripped of the Electron binary and (in dev) the app path.
 */
export function parseCliArgs(argv: readonly string[], stat: (path: string) => CliPathKind): ICliArgs {
	const paths: ICliPath[] = [];
	let explicitOpen = false;
	let takeAsFile: string | null = null;
	let takeAsFolder: string | null = null;

	for (const arg of argv) {
		if (takeAsFile !== null) {
			paths.push({ path: arg, kind: 'file' });
			takeAsFile = null;
			continue;
		}
		if (takeAsFolder !== null) {
			paths.push({ path: arg, kind: 'folder' });
			takeAsFolder = null;
			continue;
		}
		if (arg === OPEN_FILE_FLAG || arg === `--open-file=`) {
			explicitOpen = true;
			takeAsFile = arg;
			continue;
		}
		if (arg.startsWith(`${OPEN_FILE_FLAG}=`)) {
			explicitOpen = true;
			paths.push({ path: arg.slice(OPEN_FILE_FLAG.length + 1), kind: 'file' });
			continue;
		}
		if (arg === OPEN_FOLDER_FLAG) {
			explicitOpen = true;
			takeAsFolder = arg;
			continue;
		}
		if (arg.startsWith(`${OPEN_FOLDER_FLAG}=`)) {
			explicitOpen = true;
			paths.push({ path: arg.slice(OPEN_FOLDER_FLAG.length + 1), kind: 'folder' });
			continue;
		}
		if (arg.startsWith('-')) {
			// an unknown flag (Chromium switches, electron internals): ignore
			continue;
		}
		// a bare path: classified by the file system
		paths.push({ path: arg, kind: stat(arg) });
	}

	return { paths, explicitOpen };
}
