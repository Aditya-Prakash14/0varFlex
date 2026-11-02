// src/common/editor/common/model/symbolTree.ts — the symbol tree the outline view renders and the
// breadcrumb path the breadcrumbs bar renders.
//
// Ported from vs/editor/common/languages.ts (SymbolKind, DocumentSymbol, symbolKindNames) and the
// tree/path building that vs/workbench/contrib/codeEditor/browser/outline and
// vs/editor/contrib/documentSymbols do over a provider's result. Both consumers read the same
// tree because "which symbols contain the cursor" has one answer per file.

import { IPosition } from '../core/position.js';
import { IRange } from '../core/range.js';

/** numeric values are the protocol's and are copied from the reference; providers send numbers */
export const enum SymbolKind {
	File = 0,
	Module = 1,
	Namespace = 2,
	Package = 3,
	Class = 4,
	Method = 5,
	Property = 6,
	Field = 7,
	Constructor = 8,
	Enum = 9,
	Interface = 10,
	Function = 11,
	Variable = 12,
	Constant = 13,
	String = 14,
	Number = 15,
	Boolean = 16,
	Array = 17,
	Object = 18,
	Key = 19,
	Null = 20,
	EnumMember = 21,
	Struct = 22,
	Event = 23,
	Operator = 24,
	TypeParameter = 25
}

/** the reference's symbolKindNames, used for the aria label and the "no symbol" hints */
export const symbolKindNames: { readonly [kind: number]: string } = {
	[SymbolKind.File]: 'file',
	[SymbolKind.Module]: 'module',
	[SymbolKind.Namespace]: 'namespace',
	[SymbolKind.Package]: 'package',
	[SymbolKind.Class]: 'class',
	[SymbolKind.Method]: 'method',
	[SymbolKind.Property]: 'property',
	[SymbolKind.Field]: 'field',
	[SymbolKind.Constructor]: 'constructor',
	[SymbolKind.Enum]: 'enumeration',
	[SymbolKind.Interface]: 'interface',
	[SymbolKind.Function]: 'function',
	[SymbolKind.Variable]: 'variable',
	[SymbolKind.Constant]: 'constant',
	[SymbolKind.String]: 'string',
	[SymbolKind.Number]: 'number',
	[SymbolKind.Boolean]: 'boolean',
	[SymbolKind.Array]: 'array',
	[SymbolKind.Object]: 'object',
	[SymbolKind.Key]: 'key',
	[SymbolKind.Null]: 'null',
	[SymbolKind.EnumMember]: 'enumeration member',
	[SymbolKind.Struct]: 'struct',
	[SymbolKind.Event]: 'event',
	[SymbolKind.Operator]: 'operator',
	[SymbolKind.TypeParameter]: 'type parameter'
};

export function symbolKindName(kind: SymbolKind): string {
	return symbolKindNames[kind] ?? 'property';
}

export interface DocumentSymbol {
	readonly name: string;
	readonly detail?: string;
	readonly kind: SymbolKind;
	/** set by flat-list providers; we nest by range instead, so it is carried but not read */
	readonly containerName?: string;
	/** everything the symbol covers, including its body */
	readonly range: IRange;
	/** just the name, which is what reveal-symbol selects */
	readonly selectionRange: IRange;
	readonly children?: readonly DocumentSymbol[];
}

export interface OutlineNode {
	readonly symbol: DocumentSymbol;
	readonly children: readonly OutlineNode[];
}

export interface OutlineRow {
	readonly symbol: DocumentSymbol;
	/** 0 for a top-level symbol; a tree widget turns this into indentation */
	readonly depth: number;
}

function comparePositions(aLine: number, aColumn: number, bLine: number, bColumn: number): number {
	return aLine !== bLine ? aLine - bLine : aColumn - bColumn;
}

/** does `outer` cover all of `inner`, and more? equal ranges are siblings, not parent and child */
function strictlyContains(outer: IRange, inner: IRange): boolean {
	const startsAtOrBefore = comparePositions(outer.startLineNumber, outer.startColumn, inner.startLineNumber, inner.startColumn) <= 0;
	const endsAtOrAfter = comparePositions(outer.endLineNumber, outer.endColumn, inner.endLineNumber, inner.endColumn) >= 0;
	if (!startsAtOrBefore || !endsAtOrAfter) {
		return false;
	}
	return !(outer.startLineNumber === inner.startLineNumber && outer.startColumn === inner.startColumn
		&& outer.endLineNumber === inner.endLineNumber && outer.endColumn === inner.endColumn);
}

function containsPosition(range: IRange, position: IPosition): boolean {
	return comparePositions(range.startLineNumber, range.startColumn, position.lineNumber, position.column) <= 0
		&& comparePositions(range.endLineNumber, range.endColumn, position.lineNumber, position.column) >= 0;
}

/** the order an outline shows: by where the symbol starts, widest first when two start together */
function byPosition(a: DocumentSymbol, b: DocumentSymbol): number {
	const start = comparePositions(a.range.startLineNumber, a.range.startColumn, b.range.startLineNumber, b.range.startColumn);
	return start !== 0 ? start : comparePositions(b.range.endLineNumber, b.range.endColumn, a.range.endLineNumber, a.range.endColumn);
}

/**
 * Build the tree. The reference's DocumentSymbol already nests through `children`, but LSP's
 * textDocument/documentSymbol also allows the older flat SymbolInformation[] shape, where nesting
 * exists only as range containment, so both have to work: a level that carries `children` is
 * trusted as given, otherwise the level is nested by containment.
 */
export function buildSymbolTree(symbols: readonly DocumentSymbol[]): OutlineNode[] {
	const sorted = symbols.slice().sort(byPosition);
	if (sorted.some(s => s.children && s.children.length > 0)) {
		return sorted.map(symbol => ({ symbol, children: buildSymbolTree(symbol.children ?? []) }));
	}

	// sorted widest-first on a tie, so a container is always seen before what it holds
	const roots: OutlineNode[] = [];
	const stack: { symbol: DocumentSymbol; children: OutlineNode[] }[] = [];
	for (const symbol of sorted) {
		while (stack.length > 0 && !strictlyContains(stack[stack.length - 1].symbol.range, symbol.range)) {
			stack.pop();
		}
		const node = { symbol, children: [] as OutlineNode[] };
		(stack.length > 0 ? stack[stack.length - 1].children : roots).push(node);
		stack.push(node);
	}
	return roots;
}

/**
 * The chain of symbols containing `position`, outermost first — what the breadcrumbs bar renders
 * and what "outline follows cursor" selects. Empty when the position is in no symbol at all.
 */
export function breadcrumbPathFor(nodes: readonly OutlineNode[], position: IPosition): DocumentSymbol[] {
	const path: DocumentSymbol[] = [];
	let level: readonly OutlineNode[] = nodes;
	for (;;) {
		// siblings do not overlap, so the first match is the only one; identical ranges tie to the
		// first, which is the order the provider sent them in
		const next = level.find(node => containsPosition(node.symbol.range, position));
		if (!next) {
			return path;
		}
		path.push(next.symbol);
		level = next.children;
	}
}

/** the tree as the rows a tree widget draws, in display order */
export function flattenSymbolTree(nodes: readonly OutlineNode[], depth = 0): OutlineRow[] {
	const rows: OutlineRow[] = [];
	for (const node of nodes) {
		rows.push({ symbol: node.symbol, depth });
		rows.push(...flattenSymbolTree(node.children, depth + 1));
	}
	return rows;
}
