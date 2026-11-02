// tests/gotoDefinition.test.ts — where F12 lands, and when it does nothing.
//
// The weight is on the 0-based wire → 1-based editor conversion (an off-by-one here is an
// off-by-one on every jump) and on the three silent no-ops: no provider result, an empty list,
// and a provider that threw (null, both ways, over this SPI).

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { URI } from '../src/common/base/common/uri.js';
import type { IWireLocation } from '../src/common/platform/extensions/common/extensionHostProtocol.js';
import {
	definitionTarget, goToDefinition, IGotoDefinitionContext
} from '../src/renderer/editor/contrib/gotoSymbol/gotoDefinitionController.js';

function location(path: string, line: number, character: number): IWireLocation {
	return { uri: { scheme: 'file', path }, range: { start: { line, character }, end: { line, character: character + 4 } } };
}

// ---- the conversion

test('a wire location becomes a 1-based editor selection', () => {
	const target = definitionTarget([location('/a/b.ts', 0, 0)]);
	assert.deepEqual(target?.selection, { lineNumber: 1, column: 1, endLineNumber: 1, endColumn: 5 });
	assert.equal(target?.resource.fsPath, URI.file('/a/b.ts').fsPath);
});

test('the first of several results wins', () => {
	const target = definitionTarget([location('/a/first.ts', 9, 2), location('/a/second.ts', 0, 0)]);
	assert.equal(target?.selection.lineNumber, 10);
	assert.equal(target?.selection.column, 3);
	assert.equal(target?.resource.fsPath, URI.file('/a/first.ts').fsPath);
});

test('no result, an empty list and a malformed entry are all nothing', () => {
	assert.equal(definitionTarget(null), null);
	assert.equal(definitionTarget([]), null);
	assert.equal(definitionTarget([{} as IWireLocation]), null);
});

// ---- the command, with a fake widget and a fake provider

function context(provide: () => Promise<readonly IWireLocation[] | null>, opened: IWireLocation[] = []): IGotoDefinitionContext & { opened: unknown[] } {
	const openedTargets: unknown[] = [];
	return {
		opened: openedTargets,
		getActiveWidget: () => ({
			getModel: () => ({}),
			getSelection: () => ({ getPosition: () => ({ lineNumber: 3, column: 7 }) })
		}) as never,
		getResource: () => URI.file('/a/b.ts'),
		languageFeatures: {
			languageIdForResource: () => 'toylang',
			getDefinitionProviders: () => [{ handle: 1, provideDefinition: provide }],
			cancelRequest: () => undefined
		} as never,
		openEditor: async target => { openedTargets.push(target); return true; }
	};
}

test('a hit opens the definition; a miss and a failure open nothing', async () => {
	const hit = context(async () => [location('/a/other.ts', 4, 1)]);
	const target = await goToDefinition(hit);
	assert.equal(target?.selection.lineNumber, 5);
	assert.equal(hit.opened.length, 1);

	const miss = context(async () => null);
	assert.equal(await goToDefinition(miss), null);
	assert.equal(miss.opened.length, 0);

	const failure = context(async () => { throw new Error('provider died'); });
	assert.equal(await goToDefinition(failure), null);
	assert.equal(failure.opened.length, 0);
});

test('no provider registered is a clean no-op', async () => {
	const noProvider = context(async () => [location('/a/other.ts', 0, 0)]);
	(noProvider.languageFeatures as unknown as { getDefinitionProviders: () => unknown[] }).getDefinitionProviders = () => [];
	assert.equal(await goToDefinition(noProvider), null);
	assert.equal(noProvider.opened.length, 0);
});

test('a superseded F12 does not jump: only the last request opens an editor', async () => {
	let release: ((value: readonly IWireLocation[] | null) => void) | null = null;
	const slow = context(() => new Promise(resolve => { release = resolve; }));
	const first = goToDefinition(slow);
	const second = goToDefinition(context(async () => [location('/a/second.ts', 1, 0)]));
	await second;
	release!([location('/a/first.ts', 0, 0)]);
	assert.equal(await first, null);
	assert.equal(slow.opened.length, 0);
});
