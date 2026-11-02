// src/renderer/editor/browser/viewModel.ts — pure geometry: model position ↔ pixels, tabs
// expanded for measurement, visible range from scroll. All pure and unit-testable.

import { Position } from '../../../common/editor/common/core/position.js';
import { IHiddenRange, LineMapping } from '../../../common/editor/common/viewModel/lineMapping.js';

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
	private readonly _mapping: LineMapping;

	constructor(options: IViewModelOptions) {
		this._lineHeight = options.lineHeight;
		this._charWidth = options.charWidth;
		this._tabSize = options.tabSize;
		this._lineCount = options.lineCount;
		this._mapping = new LineMapping(options.lineCount);
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
			// an edit can leave a collapsed region pointing past the end of the document
			this._mapping.setModelLineCount(options.lineCount);
		}
	}

	getLineHeight(): number { return this._lineHeight; }
	getCharWidth(): number { return this._charWidth; }
	getTabSize(): number { return this._tabSize; }
	getLineCount(): number { return this._lineCount; }

	/**
	 * The line map. Callers still speak MODEL line numbers everywhere — that is deliberate, it is
	 * what kept folding from becoming a rewrite of all 16 geometry call sites — and the geometry
	 * below consults the map instead of assuming one line per row.
	 */
	getLineMapping(): LineMapping {
		return this._mapping;
	}

	setHiddenRanges(ranges: readonly IHiddenRange[]): void {
		this._mapping.setHiddenRanges(ranges);
	}

	/** true when this model line is inside a collapsed region, so nothing should be drawn for it */
	isLineHidden(lineNumber: number): boolean {
		return this._mapping.isHidden(lineNumber);
	}

	/** the pixel top of a MODEL line; a hidden line reports its fold header's row */
	getLineTop(lineNumber: number): number {
		return (this._mapping.modelToView(lineNumber) - 1) * this._lineHeight;
	}

	getTotalHeight(): number {
		return this._mapping.viewLineCount * this._lineHeight;
	}

	/**
	 * The MODEL lines to draw, as a range, plus `overscan` rows on each side.
	 *
	 * Still a range of model line numbers so existing layers keep working, but derived from view
	 * rows — the gap between start and end widens by every folded line in between. Layers that
	 * loop it must skip hidden lines; `visibleModelLines` does that for them.
	 */
	getViewport(scrollTop: number, viewportHeight: number, overscan: number = 1): IViewport {
		const startViewLine = Math.max(1, Math.floor(scrollTop / this._lineHeight) + 1 - overscan);
		const endViewLine = Math.min(
			this._mapping.viewLineCount,
			Math.ceil((scrollTop + viewportHeight) / this._lineHeight) + overscan
		);
		return {
			startLineNumber: this._mapping.viewToModel(startViewLine),
			endLineNumber: this._mapping.viewToModel(endViewLine)
		};
	}

	/** the model lines actually drawn in a viewport, folded ones left out */
	visibleModelLines(viewport: IViewport): number[] {
		return this._mapping.modelLinesForViewRange(
			this._mapping.modelToView(viewport.startLineNumber),
			this._mapping.modelToView(viewport.endLineNumber)
		);
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
		// the row under the pointer is a VIEW row; with a region collapsed the model line there is
		// further down the document. Clicking below a fold otherwise lands on the wrong line.
		const viewLineNumber = Math.max(1, Math.min(
			this._mapping.viewLineCount,
			Math.floor((scrollTop + y) / this._lineHeight) + 1
		));
		const lineNumber = this._mapping.viewToModel(viewLineNumber);
		const column = this.getColumnForX(getLineText(lineNumber), x);
		return new Position(lineNumber, column);
	}
}
