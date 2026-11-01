// extensions/git-lite/src/extension.ts — source control as an EXTENSION.
//
// The lesson this file exists to prove: the workbench contains no git code. Everything
// git-shaped lives here, in a process that happens to be Node (the extension host), which is
// why shelling out to `git` needs no pty host and no main-process help.
//
// Ported in spirit from extensions/git/src/{repository,git}.ts, at roughly 1% of the size:
//   - `git status --porcelain -z` on a timer and after document saves;
//   - resources carry a COMMAND id, so clicking a row runs git-lite's own diff command;
//   - commit shells out to `git commit -m`;
//   - the diff is shown by asking the workbench for a readonly tab — the workbench never learns
//     that the text is a diff.
//
// delta: no staging, no hunks, no merge-conflict UX, no blame, no branch/ahead-behind status bar,
// no git detection UI, no API for other extensions (extensions/git/src/api/).
// shortcut: full re-status on every tick rather than incremental; a status list is small.
// shortcut: polling at 5s + save events, because the host has no file-watcher API. The real
// extension watches .git/ and the worktree. Noted as a kernel gap in docs/ARCHITECTURE.md.

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { parsePorcelain } from './porcelain.js';

const POLL_INTERVAL_MS = 5000;
/** the same debounce the search box uses — one status call per typing run, not per keystroke */
const EDIT_DEBOUNCE_MS = 300;

/** letters → a human tooltip, mirroring the real decorations' tooltips */
const TOOLTIPS: { [letter: string]: string } = {
	M: 'Modified',
	A: 'Added',
	D: 'Deleted',
	R: 'Renamed',
	C: 'Conflict',
	U: 'Untracked',
	I: 'Ignored',
	T: 'Type changed'
};

function run(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise(resolve => {
		execFile(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = error && typeof (error as { code?: unknown }).code === 'number'
				? (error as unknown as { code: number }).code
				: error ? 1 : 0;
			resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
		});
	});
}

export async function activate(context: {
	extensionPath: string;
	subscriptions: { dispose(): void }[];
}): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		console.log('git-lite: no folder open — nothing to track');
		return;
	}
	const root = folder.uri.fsPath;

	// is this a repository at all? `rev-parse` is the real extension's probe too
	const probe = await run('git', ['rev-parse', '--show-toplevel'], root);
	if (probe.code !== 0) {
		console.log(`git-lite: ${root} is not a git repository (${probe.stderr.trim()})`);
		return;
	}
	const repoRoot = probe.stdout.trim() || root;

	const sourceControl = vscode.scm.createSourceControl('git-lite', 'Git', vscode.Uri.file(repoRoot));
	const changes = sourceControl.createResourceGroup('changes', 'Changes');
	sourceControl.acceptInputCommand = { command: 'git-lite.commit' };
	context.subscriptions.push(sourceControl);

	// ---- the diff command a resource row runs

	context.subscriptions.push(vscode.commands.registerCommand('git-lite.openDiff', async (relativePath?: string) => {
		if (typeof relativePath !== 'string' || !relativePath) {
			return;
		}
		const result = await run('git', ['diff', '--no-color', '--', relativePath], repoRoot);
		let content = result.stdout;
		if (!content.trim()) {
			// untracked (or staged-only) files have no worktree diff — say so instead of a blank tab
			content = `# No unstaged changes for ${relativePath}\n`
				+ (result.stderr.trim() ? `#\n# git said: ${result.stderr.trim()}\n` : '');
		}
		// the workbench shows text it knows nothing about: no diff concept crosses this call
		await vscode.commands.executeCommand('workbench.action.openReadonlyContent', {
			key: `git-lite/${relativePath}`,
			name: `${path.basename(relativePath)} (diff)`,
			content
		});
	}));

	// ---- commit

	context.subscriptions.push(vscode.commands.registerCommand('git-lite.commit', async () => {
		const message = sourceControl.inputBox.value.trim();
		if (!message) {
			await vscode.window.showWarningMessage('Nothing to commit: type a commit message first.');
			return;
		}
		// Clear the box NOW, not after the commit returns. `git commit` takes a moment, and a
		// clear that lands afterwards would wipe whatever the user had started typing in the
		// meantime. On failure the message is handed straight back.
		sourceControl.inputBox.value = '';

		// -a so the lack of a staging area is not a dead end: commit every tracked change
		const result = await run('git', ['commit', '-a', '-m', message], repoRoot);
		if (result.code !== 0) {
			sourceControl.inputBox.value = message;
			const detail = (result.stderr.trim() || result.stdout.trim() || 'unknown error').split('\n')[0];
			await vscode.window.showErrorMessage(`Commit failed: ${detail}`);
			return;
		}
		await vscode.window.showInformationMessage(`Committed: ${message.split('\n')[0]}`);
		await refresh();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('git-lite.refresh', () => refresh()));

	// ---- the status poll

	let refreshing = false;
	let pending = false;
	/** the last status we published, as `letter path` lines — used to skip no-op updates */
	let lastSignature = '';

	async function refresh(): Promise<void> {
		if (refreshing) {
			pending = true; // coalesce: one more pass after the current one
			return;
		}
		refreshing = true;
		try {
			const result = await run('git', ['status', '--porcelain', '-z'], repoRoot);
			if (result.code !== 0) {
				console.log(`git-lite: status failed: ${result.stderr.trim()}`);
				return;
			}
			const entries = parsePorcelain(result.stdout);

			// Assigning resourceStates always fires a change, which costs an RPC round trip and a
			// full repaint of the view. Polling every 5s means that happened forever even when
			// nothing had changed, so compare first and only publish real changes.
			// originalPath is in here because the tooltip shows it: a rename whose SOURCE changed
			// while its letter and path stayed the same would otherwise keep a stale tooltip.
			const signature = entries.map(entry => `${entry.letter} ${entry.path} ${entry.originalPath ?? ''}`).join('\n');
			if (signature === lastSignature) {
				return;
			}
			lastSignature = signature;

			changes.resourceStates = entries.map(entry => ({
				resourceUri: vscode.Uri.file(path.join(repoRoot, entry.path)),
				decorations: {
					letter: entry.letter,
					tooltip: entry.originalPath
						? `${TOOLTIPS[entry.letter] ?? entry.letter} from ${entry.originalPath}`
						: (TOOLTIPS[entry.letter] ?? entry.letter)
				},
				command: { command: 'git-lite.openDiff', arguments: [entry.path] }
			}));
		} finally {
			refreshing = false;
			if (pending) {
				pending = false;
				void refresh();
			}
		}
	}

	// Edits are the cheap signal that something changed, but onDidChangeTextDocument fires per
	// KEYSTROKE and each refresh spawns a `git status`. Debounce at the same 300ms the search
	// box uses, so a typing run ends in one status call instead of a chain of them.
	let editTimer: ReturnType<typeof setTimeout> | undefined;
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(() => {
		if (editTimer !== undefined) {
			clearTimeout(editTimer);
		}
		editTimer = setTimeout(() => {
			editTimer = undefined;
			void refresh();
		}, EDIT_DEBOUNCE_MS);
	}));

	// the timer catches everything an edit does not (a `git checkout` in a terminal, an
	// external edit, a commit from another tool)
	const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
	context.subscriptions.push(new vscode.Disposable(() => {
		clearInterval(timer);
		if (editTimer !== undefined) {
			clearTimeout(editTimer);
		}
	}));

	await refresh();
	console.log(`git-lite: tracking ${repoRoot}`);
}

export function deactivate(): void {
	// the subscriptions (source control + timer) are disposed by the host
}
