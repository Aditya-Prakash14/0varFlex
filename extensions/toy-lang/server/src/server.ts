// extensions/toy-lang/server/src/server.ts — the toy language server, built on the REAL
// `vscode-languageserver` npm package (bundled by esbuild into out/server.js):
//
//   - `createConnection(ProposedFeatures.all)` + a `TextDocuments` manager in FULL sync mode
//     (the only sync mode this client sends — the sync-mode-drift pitfall is handled by having
//     exactly one mode);
//   - the four protocol features this exercise wires: initialize/didOpen|didChange (full)/
//     completion/hover/publishDiagnostics;
//   - the analysis itself is pure (analysis.ts) so it unit-tests without the protocol;
//   - dev-logs go to STDERR with a `[toy-lang]` prefix; the client forwards them with the
//     `[toy-lang] server stderr:` convention (the real clients do the same with their
//     output-channel prefix);
//   - parent-death: the server exits when its stdin closes (that is what happens when the
//     extension host or the whole app goes away) — no zombie `node` processes.

import {
	CompletionItem,
	CompletionItemKind,
	CompletionList,
	createConnection,
	DidChangeConfigurationParams,
	InitializeParams,
	InitializeResult,
	MarkupKind,
	ProposedFeatures,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	TextDocuments
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze, completionsAt, hoverAt, TRIGGER_CHARACTERS } from './analysis.js';

// v11's createConnection needs an explicit transport (argv `--stdio` or the streams): wire the
// stdio streams directly — the hand-rolled client speaks stdio, no transport flags to guess.
const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);

let maxNumberOfProblems = 100;

function log(message: string): void {
	process.stderr.write(`[toy-lang] ${message}\n`);
}

connection.onInitialize((_params: InitializeParams): InitializeResult => {
	log('initialize');
	return {
		capabilities: {
			// ONE sync mode: full. The client never sends incremental ranges.
			textDocumentSync: TextDocumentSyncKind.Full,
			completionProvider: { triggerCharacters: [...TRIGGER_CHARACTERS] },
			hoverProvider: true
		}
	};
});

connection.onInitialized(() => {
	log('initialized');
});

connection.onDidChangeConfiguration((change: DidChangeConfigurationParams) => {
	const settings = (change.settings as { toyLang?: { maxNumberOfProblems?: unknown } } | undefined)?.toyLang;
	if (settings && typeof settings.maxNumberOfProblems === 'number') {
		maxNumberOfProblems = Math.max(0, Math.floor(settings.maxNumberOfProblems));
	}
	log(`configuration: maxNumberOfProblems = ${maxNumberOfProblems}`);
	for (const document of documents.all()) {
		validate(document);
	}
});

function validate(document: TextDocument): void {
	const all = analyze(document.getText());
	const limited = all.slice(0, maxNumberOfProblems);
	if (all.length > maxNumberOfProblems) {
		log(`truncated diagnostics for ${document.uri} from ${all.length} to ${maxNumberOfProblems}`);
	}
	connection.sendDiagnostics({
		uri: document.uri,
		diagnostics: limited.map(diagnostic => ({
			range: diagnostic.range,
			severity: diagnostic.severity,
			message: diagnostic.message,
			code: diagnostic.code
		}))
	});
}

documents.onDidOpen(event => {
	log(`didOpen ${event.document.uri}`);
	validate(event.document);
});

documents.onDidChangeContent(change => {
	// the full text length is logged so the acceptance can prove full-sync arrival
	log(`didChange ${change.document.uri} (full, ${change.document.getText().length} chars)`);
	validate(change.document);
});

documents.onDidClose(event => {
	log(`didClose ${event.document.uri}`);
	connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] | CompletionList | null => {
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return null;
	}
	log(`completion at ${params.position.line}:${params.position.character}`);
	const result = completionsAt(document.getText(), params.position.line, params.position.character);
	return {
		isIncomplete: result.isIncomplete,
		items: result.items.map(item => ({
			label: item.label,
			kind: item.kind as CompletionItemKind,
			detail: item.detail,
			filterText: item.filterText,
			textEdit: { range: item.textEdit.range, newText: item.textEdit.newText }
		}))
	};
});

connection.onHover(params => {
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return null;
	}
	log(`hover at ${params.position.line}:${params.position.character}`);
	const result = hoverAt(document.getText(), params.position.line, params.position.character);
	if (!result) {
		return null;
	}
	return {
		contents: { kind: MarkupKind.Markdown, value: result.contents },
		range: result.range
	};
});

documents.listen(connection);
connection.listen();

// parent-death watch: when the client process dies, our stdin pipe closes → exit
process.stdin.on('close', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
