// src/common/editor/common/core/range.ts — ported pieces of vs/editor/common/core/range.ts.

import { IPosition, Position } from './position.js';

export interface IRange {
	readonly startLineNumber: number;
	readonly startColumn: number;
	readonly endLineNumber: number;
	readonly endColumn: number;
}

export class Range implements IRange {

	constructor(
		readonly startLineNumber: number,
		readonly startColumn: number,
		readonly endLineNumber: number,
		readonly endColumn: number
	) {
		if (startLineNumber < 1 || startColumn < 1 || endLineNumber < 1 || endColumn < 1) {
			throw new Error(`Invalid range: ${startLineNumber}:${startColumn} - ${endLineNumber}:${endColumn}`);
		}
		if (startLineNumber > endLineNumber || (startLineNumber === endLineNumber && startColumn > endColumn)) {
			throw new Error(`Invalid range: start after end (${startLineNumber}:${startColumn} - ${endLineNumber}:${endColumn})`);
		}
	}

	static fromPositions(start: IPosition, end: IPosition = start): Range {
		return new Range(start.lineNumber, start.column, end.lineNumber, end.column);
	}

	static isEmpty(range: IRange): boolean {
		return range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn;
	}

	static intersects(a: IRange, b: IRange): boolean {
		const aStartsBeforeBEnds = (a.startLineNumber === b.endLineNumber && a.startColumn <= b.endColumn)
			|| a.startLineNumber < b.endLineNumber;
		const bStartsBeforeAEnds = (b.startLineNumber === a.endLineNumber && b.startColumn <= a.endColumn)
			|| b.startLineNumber < a.endLineNumber;
		return aStartsBeforeBEnds && bStartsBeforeAEnds;
	}

	static intersectRanges(a: IRange | null, b: IRange | null): Range | null {
		if (!a || !b) {
			return null;
		}
		let result: Range | null = null;
		if (Range.intersects(a, b)) {
			const start = Range.compareInside(b, a) ? new Position(b.startLineNumber, b.startColumn) : new Position(a.startLineNumber, a.startColumn);
			const end = Range.compareInside(a, b) ? new Position(b.endLineNumber, b.endColumn) : new Position(a.endLineNumber, a.endColumn);
			result = new Range(start.lineNumber, start.column, end.lineNumber, end.column);
		}
		return result;
	}

	/** is `a` fully inside `b`? (chooses the tighter start/end in intersectRanges) */
	private static compareInside(a: IRange, b: IRange): boolean {
		const aStart = new Position(a.startLineNumber, a.startColumn);
		const aEnd = new Position(a.endLineNumber, a.endColumn);
		const bStart = new Position(b.startLineNumber, b.startColumn);
		const bEnd = new Position(b.endLineNumber, b.endColumn);
		return aStart.isBeforeOrEqual(bStart) && !aEnd.isBefore(bEnd);
	}

	getStartPosition(): Position {
		return new Position(this.startLineNumber, this.startColumn);
	}

	getEndPosition(): Position {
		return new Position(this.endLineNumber, this.endColumn);
	}

	isEmpty(): boolean {
		return Range.isEmpty(this);
	}

	containsPosition(position: IPosition): boolean {
		if (position.lineNumber < this.startLineNumber || position.lineNumber > this.endLineNumber) {
			return false;
		}
		if (position.lineNumber === this.startLineNumber && position.column < this.startColumn) {
			return false;
		}
		if (position.lineNumber === this.endLineNumber && position.column > this.endColumn) {
			return false;
		}
		return true;
	}

	containsRange(range: Range): boolean {
		return this.containsPosition(range.getStartPosition()) && this.containsPosition(range.getEndPosition());
	}

	equals(other: IRange): boolean {
		return this.startLineNumber === other.startLineNumber
			&& this.startColumn === other.startColumn
			&& this.endLineNumber === other.endLineNumber
			&& this.endColumn === other.endColumn;
	}

	with(start: IPosition = this.getStartPosition(), end: IPosition = this.getEndPosition()): Range {
		if (Position.equals(start, this.getStartPosition()) && Position.equals(end, this.getEndPosition())) {
			return this;
		}
		return Range.fromPositions(start, end);
	}

	toString(): string {
		return `(${this.startLineNumber},${this.startColumn} -> ${this.endLineNumber},${this.endColumn})`;
	}
}
