// tests/symbolTree.test.ts — the symbol tree and the breadcrumb path over it.
//
// The two cases that matter: a flat provider result has to nest the same way an already-nested one
// does, and two symbols with the same range must end up as siblings — treating one as the other's
// parent makes the breadcrumb bar show a symbol twice.

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	buildSymbolTree, breadcrumbPathFor, DocumentSymbol, flattenSymbolTree, SymbolKind, symbolKindName
} from '../src/common/editor/common/model/symbolTree.js';

/** a symbol spanning whole lines, which is the shape every real provider produces */
function sym(name: string, startLine: number, endLine: number, children?: DocumentSymbol[]): DocumentSymbol {
	return {
		name,
		kind: SymbolKind.Function,
		range: { startLineNumber: startLine, startColumn: 1, endLineNumber: endLine, endColumn: 100 },
		selectionRange: { startLineNumber: startLine, startColumn: 1, endLineNumber: startLine, endColumn: 1 + name.length },
		children
	};
}

/** the tree as `name` strings with depth prefixed, which is what the assertions are about */
function shape(symbols: DocumentSymbol[]): string[] {
	return flattenSymbolTree(buildSymbolTree(symbols)).map(r => `${'  '.repeat(r.depth)}${r.symbol.name}`);
}

function path(symbols: DocumentSymbol[], lineNumber: number, column = 1): string[] {
	return breadcrumbPathFor(buildSymbolTree(symbols), { lineNumber, column }).map(s => s.name);
}

test('nests a flat list by range containment', () => {
	const flat = [sym('method', 2, 4), sym('Class', 1, 10), sym('other', 6, 9), sym('inner', 7, 8)];
	assert.deepEqual(shape(flat), ['Class', '  method', '  other', '    inner']);
});

test('nests via explicit children when the provider sent them', () => {
	// ranges deliberately do NOT contain the children, so only the children array can explain it
	const nested = [sym('Class', 1, 2, [sym('a', 40, 41), sym('b', 30, 31)])];
	assert.deepEqual(shape(nested), ['Class', '  b', '  a']);
});

test('sorts siblings by start position', () => {
	const flat = [sym('third', 9, 10), sym('first', 1, 2), sym('second', 5, 6)];
	assert.deepEqual(shape(flat), ['first', 'second', 'third']);
});

test('two symbols with identical ranges are siblings, in the order given', () => {
	const flat = [sym('getter', 3, 3), sym('setter', 3, 3)];
	assert.deepEqual(shape(flat), ['getter', 'setter']);
	assert.deepEqual(path(flat, 3), ['getter']);
});

test('breadcrumb path at several depths', () => {
	const flat = [sym('Class', 1, 10), sym('method', 2, 8), sym('closure', 4, 6)];
	assert.deepEqual(path(flat, 1), ['Class']);
	assert.deepEqual(path(flat, 3), ['Class', 'method']);
	assert.deepEqual(path(flat, 5), ['Class', 'method', 'closure']);
	assert.deepEqual(path(flat, 7), ['Class', 'method']);
	assert.deepEqual(path(flat, 9), ['Class']);
});

test('a position outside every symbol has no path', () => {
	assert.deepEqual(path([sym('Class', 2, 4)], 7), []);
	assert.deepEqual(path([sym('Class', 2, 4)], 1), []);
});

test('an empty list yields an empty tree, no rows and no path', () => {
	assert.deepEqual(buildSymbolTree([]), []);
	assert.deepEqual(flattenSymbolTree([]), []);
	assert.deepEqual(breadcrumbPathFor([], { lineNumber: 1, column: 1 }), []);
});

test('kind labels come from the real numeric values', () => {
	assert.equal(SymbolKind.Class, 4);
	assert.equal(SymbolKind.TypeParameter, 25);
	assert.equal(symbolKindName(SymbolKind.EnumMember), 'enumeration member');
});
