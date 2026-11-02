// tests/outlineSymbols.test.ts — the wire→editor symbol conversion the outline and the
// breadcrumbs both go through, and the path identity that gates a re-render.
//
// The tree building and the breadcrumb path are tested in symbolTree.test.ts; what is only tested
// here is the 0-based LSP → 1-based editor conversion, which has to reach nested children too — a
// child left 0-based reveals one line above the symbol you clicked.

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IWireDocumentSymbol } from '../src/common/platform/extensions/common/extensionHostProtocol.js';
import {
	breadcrumbPathKey, toOutlineSymbols
} from '../src/renderer/editor/contrib/breadcrumbs/breadcrumbsWidget.js';
import { buildSymbolTree, breadcrumbPathFor, SymbolKind } from '../src/common/editor/common/model/symbolTree.js';

function wire(name: string, startLine: number, endLine: number, children?: IWireDocumentSymbol[]): IWireDocumentSymbol {
	return {
		name,
		kind: SymbolKind.Class,
		range: { start: { line: startLine, character: 0 }, end: { line: endLine, character: 1 } },
		selectionRange: { start: { line: startLine, character: 6 }, end: { line: startLine, character: 6 + name.length } },
		children
	};
}

test('a wire symbol becomes a 1-based editor symbol', () => {
	const [symbol] = toOutlineSymbols([wire('Thing', 0, 9)]);
	assert.deepEqual(symbol.range, { startLineNumber: 1, startColumn: 1, endLineNumber: 10, endColumn: 2 });
	assert.deepEqual(symbol.selectionRange, { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 12 });
	assert.equal(symbol.kind, SymbolKind.Class);
});

test('children are converted too, at every depth', () => {
	const [symbol] = toOutlineSymbols([wire('Outer', 0, 20, [wire('inner', 2, 8, [wire('deepest', 4, 5)])])]);
	const inner = symbol.children?.[0];
	const deepest = inner?.children?.[0];
	assert.equal(inner?.range.startLineNumber, 3);
	assert.equal(deepest?.range.startLineNumber, 5);
	assert.equal(deepest?.selectionRange.startColumn, 7);
});

test('a null provider result is an empty outline, not a crash', () => {
	assert.deepEqual(toOutlineSymbols(null), []);
	assert.deepEqual(toOutlineSymbols(undefined), []);
	assert.deepEqual(toOutlineSymbols([]), []);
});

test('the converted symbols nest and the cursor finds them 1-based', () => {
	// line 3 (1-based) is inside `inner`, which starts on wire line 2
	const tree = buildSymbolTree(toOutlineSymbols([wire('Outer', 0, 20, [wire('inner', 2, 8)])]));
	const path = breadcrumbPathFor(tree, { lineNumber: 3, column: 1 });
	assert.deepEqual(path.map(symbol => symbol.name), ['Outer', 'inner']);
});

test('the path key changes only when the containing symbols change', () => {
	const tree = buildSymbolTree(toOutlineSymbols([wire('Outer', 0, 20, [wire('inner', 2, 8)])]));
	const atStart = breadcrumbPathKey(breadcrumbPathFor(tree, { lineNumber: 4, column: 1 }));
	const sameSymbol = breadcrumbPathKey(breadcrumbPathFor(tree, { lineNumber: 5, column: 3 }));
	const outerOnly = breadcrumbPathKey(breadcrumbPathFor(tree, { lineNumber: 15, column: 1 }));
	assert.equal(atStart, sameSymbol);
	assert.notEqual(atStart, outerOnly);
	assert.equal(breadcrumbPathKey([]), '');
});
