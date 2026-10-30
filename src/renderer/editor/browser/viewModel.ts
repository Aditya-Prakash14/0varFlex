// src/renderer/editor/browser/viewModel.ts — pure geometry: model position ↔ pixels, tabs
// expanded for measurement, visible range from scroll. All pure and unit-testable.

import { Position } from '../../../common/editor/common/core/position.js';

export interface IViewport {
	readonly startLineNumber: number;
	readonly endLineNumber: number;
}

/** tab expansion: rendered text + a map from model column (0-based) to rendered x column */
export interface IExpandedLine {
	readonly rendered: string;
	readonly columns: number[];
}

export function expandTabs(text: string, tabSize: number): IExpandedLine {
	let rendered = '';
	const columns: number[] = new Array(text.length + 1);
	for (let i = 0; i < text.length; i++) {
		columns[i] = rendered.length;
		if (text.charCodeAt(i) === 9) {
			const spaces = tabSize - (rendered.length % tabSize);
			rendered += ' '.repeat(spaces);
		} else {
			rendered += text[i];
		}
	}
	columns[text.length] = rendered.length;
	return { rendered, columns };
}

export interface IViewModelOptions {
	lineHeight: number;
	charWidth: number;
	tabSize: number;
	lineCount: number;
}

export class ViewModel {

	private _lineHeight: number;
	private _charWidth: number;
	private _tabSize: number;
	private _lineCount: number;

	constructor(options: IViewModelOptions) {
		this._lineHeight = options.lineHeight;
		this._charWidth = options.charWidth;
		this._tabSize = options.tabSize;
		this._lineCount = options.lineCount;
	}

	update(options: Partial<IViewModelOptions>): void {
		if (options.lineHeight !== undefined) {
			this._lineHeight = options.lineHeight;
		}
		if (options.charWidth !== undefined) {
			this._charWidth = options.charWidth;
		}
		if (options.tabSize !== undefined) {
			this._tabSize = options.tabSize;
		}
		if (options.lineCount !== undefined) {
			this._lineCount = options.lineCount;
		}
	}

	getLineHeight(): number { return this._lineHeight; }
	getCharWidth(): number { return this._charWidth; }
	getTabSize(): number { return this._tabSize; }
	getLineCount(): number { return this._lineCount; }

	getLineTop(lineNumber: number): number {
		return (lineNumber - 1) * this._lineHeight;
	}

	getTotalHeight(): number {
		return this._lineCount * this._lineHeight;
	}

	/** the rendered range to draw: the visible lines plus `overscan` lines on each side */
	getViewport(scrollTop: number, viewportHeight: number, overscan: number = 1): IViewport {
		const startLineNumber = Math.max(1, Math.floor(scrollTop / this._lineHeight) + 1 - overscan);
		const endLineNumber = Math.min(this._lineCount, Math.ceil((scrollTop + viewportHeight) / this._lineHeight) + overscan);
		return { startLineNumber, endLineNumber };
	}

	/** x pixel (0 = line start) → 1-based model column, tab-aware, nearest boundary */
	getColumnForX(lineText: string, x: number): number {
		return this.columnFromVisibleColumn(lineText, Math.round(x / this._charWidth));
	}

	/** 1-based model column → x pixel, tab-aware */
	getXForColumn(lineText: string, column: number): number {
		return this.visibleColumnFromColumn(lineText, column) * this._charWidth;
	}

	/** the "visible column" (a cell count) of a 1-based model column — tabs advance to the stop */
	visibleColumnFromColumn(lineText: string, column: number): number {
		const { columns } = expandTabs(lineText, this._tabSize);
		const clamped = Math.max(1, Math.min(column, lineText.length + 1));
		return columns[clamped - 1];
	}

	/**
	 * The 1-based model column nearest to a visible column — ported from
	 * CursorColumns.columnFromVisibleColumn: ties go to the EARLIER boundary.
	 */
	columnFromVisibleColumn(lineText: string, visibleColumn: number): number {
		if (visibleColumn <= 0) {
			return 1;
		}
		const { columns } = expandTabs(lineText, this._tabSize);
		for (let i = 1; i < columns.length; i++) {
			if (columns[i] >= visibleColumn) {
				const afterDelta = columns[i] - visibleColumn;
				const beforeDelta = visibleColumn - columns[i - 1];
				return afterDelta < beforeDelta ? i + 1 : i;
			}
		}
		return lineText.length + 1;
	}

	/** offset inside the viewport → position (the mouse math, cheap path) */
	getViewPositionFromCoordinates(scrollTop: number, x: number, y: number, getLineText: (lineNumber: number) => string): Position {
		const lineNumber = Math.max(1, Math.min(this._lineCount, Math.floor((scrollTop + y) / this._lineHeight) + 1));
		const column = this.getColumnForX(getLineText(lineNumber), x);
		return new Position(lineNumber, column);
	}
}
