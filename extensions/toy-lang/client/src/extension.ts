// extensions/toy-lang/client/src/extension.ts — the LSP client extension, following the
// lifecycle shape of the real json-language-features client: start → onReady → register
// providers → sync documents → dispose on deactivate. The LSP-speaking part lives in
// lsp-client.ts; here we only bridge LSP ↔ the workbench's provider API.
//
// The draft-state contract: activation is `onLanguage:toycfg`, and this extension must never
// assume the workbench knows anything about LSP — it registers plain completion/hover providers
// and a diagnostics collection like any other extension.

import * as path from 'path';
import * as vscode from 'vscode';
import { LspClient } from './lsp-client.js';

let client: LspClient | null = null;

export async function activate(context: {
	extensionPath: string;
	subscriptions: { dispose(): void }[];
}): Promise<void> {
	const bundledServerPath = path.join(context.extensionPath, 'out', 'server.js');
	// packaged: the extension lives inside app.asar, but the server must be SPAWNED — exec
	// cannot read from an asar, so the bundle ships unpacked (asarUnpack in the builder config)
	// and this maps the path there (a no-op in dev, where there is no app.asar component)
	const serverPath = bundledServerPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
	const lsp = new LspClient({
		serverPath,
		// the ported convention: a stable prefix so the output channel reads as one story
		onStderrLine: line => console.warn(`[toy-lang] server stderr: ${line}`),
		onLog: message => console.log(`[toy-lang] ${message}`)
	});
	client = lsp;

	const collection = vscode.languages.createDiagnosticCollection('toy-lang');
	context.subscriptions.push(collection as unknown as { dispose(): void });

	// publishDiagnostics → the diagnostics collection (owner `toy-lang` in the marker service)
	lsp.onNotification('textDocument/publishDiagnostics', params => {
		const uri = String(params.uri);
		const list = Array.isArray(params.diagnostics) ? params.diagnostics : [];
		collection.set(
			vscode.Uri.parse(uri),
			list.map(diagnostic => ({
				range: (diagnostic as { range: unknown }).range,
				severity: (diagnostic as { severity: number }).severity,
				message: String((diagnostic as { message: unknown }).message),
				code: (diagnostic as { code?: string }).code
			}))
		);
	});

	// configuration: `toyLang.maxNumberOfProblems` → workspace/didChangeConfiguration
	const sendConfiguration = (): void => {
		lsp.notify('workspace/didChangeConfiguration', {
			settings: {
				toyLang: {
					maxNumberOfProblems: vscode.workspace.getConfiguration('toyLang').get('maxNumberOfProblems')
				}
			}
		});
	};

	const ready = lsp.start().then(() => {
		console.log('[toy-lang] language server ready');
		sendConfiguration();
		syncOpenDocuments();
	}, (error: Error) => {
		console.error(`[toy-lang] the language server failed to start: ${error.message}`);
	});

	// providers: the workbench calls these; they await readiness and fail gracefully after that
	context.subscriptions.push(vscode.languages.registerCompletionItemProvider('toycfg', {
		async provideCompletionItems(document: unknown, position: { line: number; character: number }, token: unknown) {
			await ready.catch(() => undefined);
			if (!lsp.isRunning) {
				return null;
			}
			return lsp.request('textDocument/completion', {
				textDocument: { uri: documentUri(document) },
				position: { line: position.line, character: position.character }
			}, token as never);
		}
	}, '=', '[', ' '));

	context.subscriptions.push(vscode.languages.registerHoverProvider('toycfg', {
		async provideHover(document: unknown, position: { line: number; character: number }, token: unknown) {
			await ready.catch(() => undefined);
			if (!lsp.isRunning) {
				return null;
			}
			return lsp.request('textDocument/hover', {
				textDocument: { uri: documentUri(document) },
				position: { line: position.line, character: position.character }
			}, token as never);
		}
	}));

	// document sync: FULL text only (the declared sync mode)
	const openDocuments = new Set<string>();

	const openDocument = (document: unknown): void => {
		const typed = document as { languageId?: string; uri: { toString(): string }; version: number; getText(): string };
		if (typed.languageId !== 'toycfg') {
			return;
		}
		const uri = typed.uri.toString();
		if (openDocuments.has(uri)) {
			return;
		}
		openDocuments.add(uri);
		lsp.notify('textDocument/didOpen', {
			textDocument: { uri, languageId: 'toycfg', version: typed.version, text: typed.getText() }
		});
	};

	function syncOpenDocuments(): void {
		for (const document of vscode.workspace.textDocuments) {
			openDocument(document);
		}
	}

	for (const document of vscode.workspace.textDocuments) {
		openDocument(document);
	}
	context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => openDocument(document)));
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
		const typed = event as { document: { languageId?: string; uri: { toString(): string }; version: number; getText(): string } };
		if (typed.document.languageId !== 'toycfg') {
			return;
		}
		// a change can arrive before the open was observed (activation timing): cover both
		openDocument(typed.document);
		lsp.notify('textDocument/didChange', {
			textDocument: { uri: typed.document.uri.toString(), version: typed.document.version },
			contentChanges: [{ text: typed.document.getText() }]
		});
	}));
	context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
		const typed = document as { uri: { toString(): string } };
		const uri = typed.uri.toString();
		if (openDocuments.delete(uri)) {
			lsp.notify('textDocument/didClose', { textDocument: { uri } });
		}
	}));

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		const typed = event as { affectsConfiguration?(section: string): boolean };
		if (typed.affectsConfiguration && !typed.affectsConfiguration('toyLang')) {
			return;
		}
		sendConfiguration();
	}));
}

export async function deactivate(): Promise<void> {
	const lsp = client;
	client = null;
	if (lsp) {
		await lsp.dispose();
		console.log('[toy-lang] language server stopped');
	}
}

function documentUri(document: unknown): string {
	return (document as { uri: { toString(): string } }).uri.toString();
}
