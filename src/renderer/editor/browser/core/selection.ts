// src/renderer/editor/browser/core/selection.ts — the anchor/active pair, ported in shape from
// vs/editor/common/core/selection.ts: `anchor` is where the selection was started, `active` is
// the cursor end (== anchor when the selection is empty).

import { Position } from '../../../../common/editor/common/core/position.js';
import { Range } from '../../../../common/editor/common/core/range.js';

export const enum SelectionDirection {
	LTR = 0,
	RTL = 1
}

export class Selection extends Range {

	static fromPositions(anchor: Position, active: Position = anchor): Selection {
		return new Selection(anchor.lineNumber, anchor.column, active.lineNumber, active.column);
	}

	constructor(
		readonly anchorLineNumber: number,
		readonly anchorColumn: number,
		readonly activeLineNumber: number,
		readonly activeColumn: number
	) {
		super(
			Math.min(anchorLineNumber, activeLineNumber),
			anchorLineNumber === activeLineNumber ? Math.min(anchorColumn, activeColumn) : (anchorLineNumber < activeLineNumber ? anchorColumn : activeColumn),
			Math.max(anchorLineNumber, activeLineNumber),
			anchorLineNumber === activeLineNumber ? Math.max(anchorColumn, activeColumn) : (anchorLineNumber < activeLineNumber ? activeColumn : anchorColumn)
		);
	}

	get anchor(): Position {
		return new Position(this.anchorLineNumber, this.anchorColumn);
	}

	get active(): Position {
		return new Position(this.activeLineNumber, this.activeColumn);
	}

	isEmpty(): boolean {
		return this.anchorLineNumber === this.activeLineNumber && this.anchorColumn === this.activeColumn;
	}

	/** the cursor end */
	getPosition(): Position {
		return this.active;
	}

	getSelectionStart(): Position {
		return this.getDirection() === SelectionDirection.LTR ? this.anchor : this.active;
	}

	getSelectionEnd(): Position {
		return this.getDirection() === SelectionDirection.LTR ? this.active : this.anchor;
	}

	getDirection(): SelectionDirection {
		if (this.anchorLineNumber === this.activeLineNumber) {
			return this.anchorColumn <= this.activeColumn ? SelectionDirection.LTR : SelectionDirection.RTL;
		}
		return this.anchorLineNumber < this.activeLineNumber ? SelectionDirection.LTR : SelectionDirection.RTL;
	}

	equalsSelection(other: Selection): boolean {
		return this.anchorLineNumber === other.anchorLineNumber
			&& this.anchorColumn === other.anchorColumn
			&& this.activeLineNumber === other.activeLineNumber
			&& this.activeColumn === other.activeColumn;
	}
}
