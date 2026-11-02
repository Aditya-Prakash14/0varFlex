// src/common/editor/common/model/workspaceEdit.ts — grouping and validating a multi-file text edit
// (what rename and quick fix produce) into one ordered edit array per resource.
//
// Ported in behaviour from vs/editor/browser/services/bulkEditService.ts (ResourceTextEdit, the
// Rejection shape) and vs/workbench/contrib/bulkEdit/browser/bulkEditService.ts (the per-resource
// grouping and the aria summary). Only the pure part is here: no model is mutated and no file is
// opened — the caller feeds each group to TextModel.pushEditOperations, which already sorts,
// rejects overlaps and applies back-to-front, so this file does not repeat that work. What it adds
// is the decision the reference makes before touching anything: a provider that hands back
// overlapping edits is a bug, and finding that out halfway through a rename leaves the workspace
// half-renamed with no single undo step to get back.

import { URI } from '../../../base/common/uri.js';
import { Range } from '../core/range.js';
import { ISingleEditOperation } from '../core/textChange.js';

/** the model surface validation reads — same shape as IBracketSource, so no widget is needed */
export interface IWorkspaceEditSource {
	getLineCount(): number;
	getLineContent(lineNumber: number): string;
}

/** one entry of a flat WorkspaceEdit; the reference nests range+text in a `textEdit` */
export interface IWorkspaceTextEdit {
	readonly resource: URI;
	readonly range: Range;
	readonly text: string;
}

/** all edits for one resource, ordered and ready for a single pushEditOperations call */
export interface IResourceTextEdits {
	readonly resource: URI;
	readonly edits: readonly ISingleEditOperation[];
}

export type ResourceEditsResult =
	| { readonly ok: true; readonly edits: readonly ISingleEditOperation[] }
	| { readonly ok: false; readonly rejectReason: string };

export type WorkspaceEditPreparation = {
	/** false for a rejection AND for an empty edit — the reference reports "Made no edits" unapplied */
	readonly isApplied: boolean;
	readonly groups: readonly IResourceTextEdits[];
	/** per file, so a caller can say "renamed in 3 files" */
	readonly editCountByResource: ReadonlyMap<string, number>;
	readonly ariaSummary: string;
	/** set only when edits were rejected, as in the reference's Rejection */
	readonly rejectReason?: string;
};

function comparePositions(aLine: number, aColumn: number, bLine: number, bColumn: number): number {
	return aLine !== bLine ? aLine - bLine : aColumn - bColumn;
}

/** Group a flat edit list by resource, keeping first-seen resource order so the summary is stable. */
export function groupWorkspaceTextEdits(edits: readonly IWorkspaceTextEdit[]): IWorkspaceTextEdit[][] {
	const groups: IWorkspaceTextEdit[][] = [];
	const byKey = new Map<string, IWorkspaceTextEdit[]>();
	for (const edit of edits) {
		const key = edit.resource.toString();
		let group = byKey.get(key);
		if (!group) {
			group = [];
			byKey.set(key, group);
			groups.push(group);
		}
		group.push(edit);
	}
	return groups;
}

/**
 * Order one resource's edits and reject overlaps. Touching edits (one ending where the next starts)
 * are fine and stay separate, which is the same rule pushEditOperations applies. Range's own
 * constructor already rejects a start-after-end range, so there is nothing to check here.
 */
export function resourceTextEdits(edits: readonly IWorkspaceTextEdit[], source?: IWorkspaceEditSource): ResourceEditsResult {
	const sorted = edits.slice().sort((a, b) =>
		comparePositions(a.range.startLineNumber, a.range.startColumn, b.range.startLineNumber, b.range.startColumn)
		|| comparePositions(a.range.endLineNumber, a.range.endColumn, b.range.endLineNumber, b.range.endColumn));

	if (source) {
		for (const edit of sorted) {
			// out of bounds would make pushEditOperations throw mid-rename, after earlier files changed
			const rejectReason = outOfBoundsReason(edit.range, source);
			if (rejectReason) {
				return { ok: false, rejectReason };
			}
		}
	}

	for (let i = 1; i < sorted.length; i++) {
		const previous = sorted[i - 1].range;
		const current = sorted[i].range;
		if (comparePositions(current.startLineNumber, current.startColumn, previous.endLineNumber, previous.endColumn) < 0) {
			return { ok: false, rejectReason: `Overlapping ranges are not allowed! ${previous.toString()} and ${current.toString()}` };
		}
	}

	return { ok: true, edits: sorted.map(edit => ({ range: edit.range, text: edit.text })) };
}

function outOfBoundsReason(range: Range, source: IWorkspaceEditSource): string | undefined {
	const lineCount = source.getLineCount();
	if (range.startLineNumber < 1 || range.endLineNumber > lineCount) {
		return `Illegal value for lineNumber: ${range.startLineNumber}-${range.endLineNumber} (expected 1 - ${lineCount})`;
	}
	const starts = source.getLineContent(range.startLineNumber).length + 1;
	const ends = source.getLineContent(range.endLineNumber).length + 1;
	if (range.startColumn < 1 || range.startColumn > starts) {
		return `Illegal value for column: ${range.startColumn} (expected 1 - ${starts} on line ${range.startLineNumber})`;
	}
	if (range.endColumn < 1 || range.endColumn > ends) {
		return `Illegal value for column: ${range.endColumn} (expected 1 - ${ends} on line ${range.endLineNumber})`;
	}
	return undefined;
}

/**
 * The whole decision: group, order, validate. All or nothing — one bad resource rejects the lot,
 * because a partly applied rename is worse than none and cannot be undone in one step.
 *
 * shortcut: no versionId staleness check (the reference skips an edit whose model moved on) and no
 * file create/rename/delete edits — this build's providers only produce text edits. Upgrade when
 * the extension host can send IWorkspaceFileEdit.
 */
export function prepareWorkspaceEdit(
	edits: readonly IWorkspaceTextEdit[],
	sourceFor?: (resource: URI) => IWorkspaceEditSource | undefined
): WorkspaceEditPreparation {
	const groups: IResourceTextEdits[] = [];
	const editCountByResource = new Map<string, number>();

	for (const group of groupWorkspaceTextEdits(edits)) {
		const resource = group[0].resource;
		const result = resourceTextEdits(group, sourceFor?.(resource));
		if (!result.ok) {
			return {
				isApplied: false,
				groups: [],
				editCountByResource: new Map(),
				ariaSummary: workspaceEditAriaMessage(new Map()),
				rejectReason: `${resource.toString()}: ${result.rejectReason}`
			};
		}
		groups.push({ resource, edits: result.edits });
		editCountByResource.set(resource.toString(), result.edits.length);
	}

	return {
		isApplied: groups.length > 0,
		groups,
		editCountByResource,
		ariaSummary: workspaceEditAriaMessage(editCountByResource)
	};
}

/** the reference's summary.0 / summary.n0 / summary.nm messages, verbatim */
export function workspaceEditAriaMessage(editCountByResource: ReadonlyMap<string, number>): string {
	let editCount = 0;
	for (const count of editCountByResource.values()) {
		editCount += count;
	}
	if (editCount === 0) {
		return 'Made no edits';
	}
	if (editCount > 1 && editCountByResource.size > 1) {
		return `Made ${editCount} text edits in ${editCountByResource.size} files`;
	}
	return `Made ${editCount} text edits in one file`;
}
