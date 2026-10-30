// src/common/editor/common/core/textChange.ts — the change/event shapes and the edit operation.

import { Range } from './range.js';

export interface ISingleEditOperation {
	readonly range: Range;
	readonly text: string | null;
	forceMoveMarkers?: boolean;
}

/** an inverse edit operation: the original range and the text that was there before */
export interface IValidEditOperation {
	readonly range: Range;
	readonly text: string;
}

export interface IModelContentChange {
	readonly range: Range;
	/** offset in the OLD text */
	readonly rangeOffset: number;
	/** length in UTF-16 code units in the OLD text (an emoji is 2) */
	readonly rangeLength: number;
	readonly text: string;
}

export interface IModelContentChangedEvent {
	readonly versionId: number;
	/**
	 * Sorted DESCENDING by rangeOffset: applying them to an old snapshot in order keeps earlier
	 * offsets valid.
	 */
	readonly changes: IModelContentChange[];
	readonly eol: string;
	readonly isUndoing: boolean;
	readonly isRedoing: boolean;
}

/**
 * The undo/redo record of one edit: apply at newPosition replacing newText with oldText to undo;
 * apply at oldPosition replacing oldText with newText to redo (no delta math needed).
 */
export interface TextChange {
	readonly oldPosition: number;
	readonly oldText: string;
	readonly newPosition: number;
	readonly newText: string;
}
