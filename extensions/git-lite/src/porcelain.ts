// extensions/git-lite/src/porcelain.ts — the `git status --porcelain -z` parser.
//
// Pure, so it is unit tested (tests/gitPorcelain.test.ts). Separated from extension.ts so the
// test does not drag in the `vscode` module or spawn anything.
//
// The real extension (extensions/git/src/git.ts) parses `--porcelain=v2 -z --branch`, which also
// carries ahead/behind counts, submodule state and rename scores. v1 carries everything the
// status list needs and is far smaller to parse — the delta is noted in the extension README.
//
// Record format with -z: "XY <path>\0", where X is the INDEX status and Y the WORKTREE status.
// -z means paths are raw (never quoted or octal-escaped), which is the whole reason to use it.
// A rename/copy record is followed by a SECOND NUL-terminated field holding the original path.

export interface IGitStatusEntry {
	/** path relative to the repository root, exactly as git printed it */
	readonly path: string;
	/** the single badge letter the SCM view renders */
	readonly letter: string;
	/** set for renames and copies: where the file came from */
	readonly originalPath?: string;
	readonly indexStatus: string;
	readonly worktreeStatus: string;
}

/**
 * Collapse git's two-axis status into the one letter the view shows.
 *
 * We have no staging area, so there is nothing to gain from showing index and worktree
 * separately: the worktree state is what the user is looking at, and the index state is the
 * fallback for a file that is staged and otherwise unchanged.
 */
export function statusLetter(indexStatus: string, worktreeStatus: string): string {
	// untracked and ignored are worktree-only states
	if (indexStatus === '?' && worktreeStatus === '?') {
		return 'U';
	}
	if (indexStatus === '!' && worktreeStatus === '!') {
		return 'I';
	}
	// unmerged: either side 'U', or the both-added / both-deleted pairs git reports for conflicts
	if (indexStatus === 'U' || worktreeStatus === 'U'
		|| (indexStatus === 'A' && worktreeStatus === 'A')
		|| (indexStatus === 'D' && worktreeStatus === 'D')) {
		return 'C';
	}
	const worktree = worktreeStatus.trim();
	if (worktree) {
		return worktree;
	}
	return indexStatus.trim() || 'M';
}

export function parsePorcelain(stdout: string): IGitStatusEntry[] {
	// -z terminates every field with NUL, so the final split produces a trailing empty string
	const fields = stdout.split('\0');
	const entries: IGitStatusEntry[] = [];

	for (let i = 0; i < fields.length; i++) {
		const record = fields[i];
		// a record needs at least "XY " plus one path character
		if (record.length < 4) {
			continue;
		}

		const indexStatus = record[0];
		const worktreeStatus = record[1];
		const path = record.slice(3);
		if (!path) {
			continue;
		}

		let originalPath: string | undefined;
		if (indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C') {
			// the next field is the ORIGINAL path of the rename/copy — consume it
			const next = fields[i + 1];
			if (next !== undefined && next !== '') {
				originalPath = next;
				i++;
			}
		}

		entries.push({
			path,
			letter: statusLetter(indexStatus, worktreeStatus),
			originalPath,
			indexStatus,
			worktreeStatus
		});
	}

	return entries;
}
