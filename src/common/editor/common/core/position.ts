// src/common/editor/common/core/position.ts — ported from vs/editor/common/core/position.ts.
// Positions are 1-based: the VS Code API contract (the extension API in 11 depends on it).

export interface IPosition {
	readonly lineNumber: number;
	readonly column: number;
}

export class Position implements IPosition {

	constructor(readonly lineNumber: number, readonly column: number) {
		if (lineNumber < 1 || column < 1) {
			throw new Error(`Invalid position: lineNumber ${lineNumber}, column ${column}`);
		}
	}

	static equals(a: IPosition | null, b: IPosition | null): boolean {
		if (!a || !b) {
			return false;
		}
		return a.lineNumber === b.lineNumber && a.column === b.column;
	}

	equals(other: IPosition): boolean {
		return Position.equals(this, other);
	}

	isBefore(other: IPosition): boolean {
		if (this.lineNumber < other.lineNumber) {
			return true;
		}
		if (this.lineNumber > other.lineNumber) {
			return false;
		}
		return this.column < other.column;
	}

	isBeforeOrEqual(other: IPosition): boolean {
		if (this.lineNumber < other.lineNumber) {
			return true;
		}
		if (this.lineNumber > other.lineNumber) {
			return false;
		}
		return this.column <= other.column;
	}

	compare(other: IPosition): number {
		if (this.lineNumber < other.lineNumber) {
			return -1;
		}
		if (this.lineNumber > other.lineNumber) {
			return 1;
		}
		if (this.column < other.column) {
			return -1;
		}
		if (this.column > other.column) {
			return 1;
		}
		return 0;
	}

	translate(lineDelta: number = 0, columnDelta: number = 0): Position {
		return new Position(this.lineNumber + lineDelta, this.column + columnDelta);
	}

	with(lineNumber: number = this.lineNumber, column: number = this.column): Position {
		if (lineNumber === this.lineNumber && column === this.column) {
			return this;
		}
		return new Position(lineNumber, column);
	}

	clone(): Position {
		return this;
	}

	toString(): string {
		return `${this.lineNumber}:${this.column}`;
	}
}
