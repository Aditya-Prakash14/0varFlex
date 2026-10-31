// extHost — the `vscode` module the host patches in (see src/extHost/main.ts).

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vscode = require('vscode');

const DEBOUNCE_MS = 150;

let statusItem: { text: string; show(): void; hide(): void; dispose(): void } | undefined;
let updateTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

function countWords(text: string, includeWhitespace: boolean): number {
	if (includeWhitespace) {
		// whitespace-split tokens (empty runs ignored)
		return text.split(/\s+/).filter(token => token.length > 0).length;
	}
	// lines with content (the sample's default behavior)
	return text.split('\n').filter(line => line.trim().length > 0).length;
}

function update(document: { languageId: string; getText(): string } | undefined): void {
	if (!statusItem) {
		return;
	}
	if (!document || document.languageId !== 'plaintext') {
		statusItem.hide();
		return;
	}
	const configuration = vscode.workspace.getConfiguration('wordcount');
	const includeWhitespace = configuration.get('includeWhitespace', false);
	const count = countWords(document.getText(), includeWhitespace);
	statusItem.text = `${count} ${includeWhitespace ? 'tokens' : 'lines'}`;
	statusItem.show();
}

export function activate(context: { subscriptions: { dispose(): void }[] }): void {
	console.log('wordcount: activate() ran');

	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusItem.text = 'words';
	context.subscriptions.push(statusItem);

	const scheduleUpdate = (document?: { languageId: string; getText(): string }): void => {
		if (updateTimer) {
			clearTimeout(updateTimer);
		}
		updateTimer = setTimeout(() => {
			if (!disposed) {
				update(document ?? (vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document : undefined));
			}
		}, DEBOUNCE_MS);
	};

	context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(() => scheduleUpdate()));
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => scheduleUpdate(event.document)));
	context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(() => scheduleUpdate()));
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => scheduleUpdate()));
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(() => scheduleUpdate()));

	context.subscriptions.push(vscode.commands.registerCommand('wordcount.toggleWhitespace', async () => {
		const configuration = vscode.workspace.getConfiguration('wordcount');
		const current = configuration.get('includeWhitespace', false);
		await configuration.update('includeWhitespace', !current);
		console.log(`wordcount: includeWhitespace is now ${!current}`);
		scheduleUpdate();
	}));

	update(vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document : undefined);
}

export function deactivate(): void {
	disposed = true;
	if (updateTimer) {
		clearTimeout(updateTimer);
	}
	console.log('wordcount: deactivate() ran');
}
