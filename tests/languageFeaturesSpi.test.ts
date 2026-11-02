// The language-provider SPI's seams, for the five kinds added on top of completion/hover.
//
// Three things here have no DOM and every provider depends on them: the 1-based renderer /
// 0-based wire conversion (an off-by-one puts a definition on the wrong line), the registry's
// per-language ordering, and $unregisterProvider reaching EVERY registry — a missed one is a
// provider that keeps answering after its extension is gone.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { URI } from '../src/common/base/common/uri.js';
import type { ILogService } from '../src/common/platform/log/common/log.js';
import { CodeActionKind, CodeActionTriggerType, SymbolKind } from '../src/common/platform/extensions/common/extensionHostProtocol.js';
import {
	LanguageFeatureRegistry,
	LanguageFeaturesService,
	createMainThreadLanguageFeatures,
	toEditorRange,
	toWirePosition,
	toWireRange
} from '../src/renderer/workbench/api/common/mainThreadLanguageFeatures.js';

function fakeLog(): ILogService & { warnings: string[] } {
	const warnings: string[] = [];
	return {
		warnings,
		trace: () => { },
		debug: () => { },
		info: () => { },
		warn: (message: string) => { warnings.push(message); },
		error: () => { }
	} as unknown as ILogService & { warnings: string[] };
}

/** the wire half of createMainThreadLanguageFeatures, with the host replaced by a recorder */
function wireWith(answer: (method: string, args: unknown[]) => unknown) {
	const service = new LanguageFeaturesService();
	const calls: { method: string; args: unknown[] }[] = [];
	const log = fakeLog();
	const { service: wire } = createMainThreadLanguageFeatures(
		service,
		null as never,
		async (method, args) => {
			calls.push({ method, args });
			return answer(method, args);
		},
		log
	);
	return { service, calls, log, wire: wire as unknown as Record<string, (...args: unknown[]) => Promise<void>> };
}

test('toWirePosition drops to 0-based LSP coordinates', () => {
	assert.deepEqual(toWirePosition({ lineNumber: 1, column: 1 }), { line: 0, character: 0 });
	assert.deepEqual(toWirePosition({ lineNumber: 12, column: 5 }), { line: 11, character: 4 });
});

test('toWireRange / toEditorRange round-trip every corner', () => {
	const range = { startLineNumber: 3, startColumn: 1, endLineNumber: 9, endColumn: 41 };
	const wire = toWireRange(range);
	assert.deepEqual(wire, { start: { line: 2, character: 0 }, end: { line: 8, character: 40 } });
	assert.deepEqual(toEditorRange(wire), range);
});

test('registry ordered() filters by language and prefers the later registration', () => {
	const registry = new LanguageFeatureRegistry<{ handle: number }>();
	const first = { handle: 1 };
	const second = { handle: 2 };
	registry.register('typescript', first);
	registry.register('typescript', second);
	registry.register('python', { handle: 3 });

	assert.deepEqual(registry.ordered('typescript'), [second, first]);
	assert.deepEqual(registry.ordered('python').map(p => p.handle), [3]);
	assert.deepEqual(registry.ordered('rust'), []);
});

test('each new kind registers into its own registry only', async () => {
	const { service, wire } = wireWith(() => null);
	await wire.$registerDocumentSymbolProvider(1, 'typescript', 'ts');
	await wire.$registerDefinitionSupport(2, 'typescript');
	await wire.$registerRenameSupport(3, 'typescript', true);
	await wire.$registerCodeActionSupport(4, 'typescript', { providedCodeActionKinds: [CodeActionKind.QuickFix] }, 'ts');
	await wire.$registerDocumentFormattingSupport(5, 'typescript', 'ts');

	assert.equal(service.getDocumentSymbolProviders('typescript').length, 1);
	assert.equal(service.getDefinitionProviders('typescript').length, 1);
	assert.equal(service.getRenameProviders('typescript')[0].supportsResolveInitialValues, true);
	assert.deepEqual(service.getCodeActionProviders('typescript')[0].providedCodeActionKinds, ['quickfix']);
	assert.equal(service.getDocumentFormattingEditProviders('typescript').length, 1);
	// a different language sees none of them
	assert.equal(service.getDefinitionProviders('python').length, 0);
});

test('$unregisterProvider clears every registry, not just the first two', async () => {
	const { service, wire } = wireWith(() => null);
	await wire.$registerCompletionProvider(7, 'typescript', ['.']);
	await wire.$registerHoverProvider(7, 'typescript');
	await wire.$registerDocumentSymbolProvider(7, 'typescript', 'ts');
	await wire.$registerDefinitionSupport(7, 'typescript');
	await wire.$registerRenameSupport(7, 'typescript', false);
	await wire.$registerCodeActionSupport(7, 'typescript', {}, 'ts');
	await wire.$registerDocumentFormattingSupport(7, 'typescript', 'ts');

	await wire.$unregisterProvider(7);

	assert.deepEqual([
		service.getCompletionProviders('typescript').length,
		service.getHoverProviders('typescript').length,
		service.getDocumentSymbolProviders('typescript').length,
		service.getDefinitionProviders('typescript').length,
		service.getRenameProviders('typescript').length,
		service.getCodeActionProviders('typescript').length,
		service.getDocumentFormattingEditProviders('typescript').length
	], [0, 0, 0, 0, 0, 0, 0]);
});

test('adapters convert at the boundary and pass the request id through', async () => {
	const { service, calls, wire } = wireWith(method => method === '$provideDefinition'
		? [{ uri: { scheme: 'file', path: '/a.ts' }, range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } } }]
		: null);
	await wire.$registerDefinitionSupport(11, 'typescript');
	await wire.$registerCodeActionSupport(12, 'typescript', {}, 'ts');

	const definitions = await service.getDefinitionProviders('typescript')[0]
		.provideDefinition(URI.file('/a.ts'), { lineNumber: 5, column: 3 }, 42);
	assert.deepEqual(calls[0].args[1], 42);
	assert.deepEqual(calls[0].args[3], { line: 4, character: 2 });
	// the answer stays on the wire's 0-based coordinates; contribs convert with toEditorRange
	assert.deepEqual(toEditorRange(definitions![0].range), { startLineNumber: 5, startColumn: 3, endLineNumber: 5, endColumn: 9 });

	await service.getCodeActionProviders('typescript')[0].provideCodeActions(
		URI.file('/a.ts'),
		{ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 10 },
		{ trigger: CodeActionTriggerType.Invoke },
		7
	);
	assert.deepEqual(calls[1].args[3], { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } });
});

test('a provider that throws yields null and a warning, never an exception', async () => {
	const { service, log, wire } = wireWith(() => { throw new Error('extension exploded'); });
	await wire.$registerDocumentSymbolProvider(21, 'typescript', 'ts');

	const symbols = await service.getDocumentSymbolProviders('typescript')[0]
		.provideDocumentSymbols(URI.file('/a.ts'), 1);
	assert.equal(symbols, null);
	assert.equal(log.warnings.length, 1);
	assert.match(log.warnings[0], /extension exploded/);
});

test('rename providers without prepareRename answer null without reaching the host', async () => {
	const { service, calls, wire } = wireWith(() => null);
	await wire.$registerRenameSupport(31, 'typescript', false);

	const location = await service.getRenameProviders('typescript')[0]
		.resolveRenameLocation(URI.file('/a.ts'), { lineNumber: 1, column: 1 }, 1);
	assert.equal(location, null);
	assert.equal(calls.length, 0);
});

test('the copied enum values are the reference\'s', () => {
	// vscode.SymbolKind is 0-based (File = 0), one below LSP's — guarding the copy, not the maths
	assert.equal(SymbolKind.File, 0);
	assert.equal(SymbolKind.Class, 4);
	assert.equal(SymbolKind.Function, 11);
	assert.equal(SymbolKind.TypeParameter, 25);
	assert.equal(CodeActionKind.Empty, '');
	assert.equal(CodeActionKind.RefactorExtract, 'refactor.extract');
	assert.equal(CodeActionKind.SourceOrganizeImports, 'source.organizeImports');
	assert.equal(CodeActionTriggerType.Auto, 2);
});
