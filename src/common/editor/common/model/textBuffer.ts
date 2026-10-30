// src/common/editor/common/model/textBuffer.ts — the line-array buffer implementing the
// ITextBuffer subset. Replaces the reference's piece tree (vs/editor/common/model/
// pieceTreeTextBuffer/): same interface, different asymptotics.
//
// delta vs the piece tree: O(lines) splice on structural edits (the piece tree splices in
// O(log n)); offset reads are O(log n) via prefix sums either way. Fine to ~100k lines (08
// proves the envelope); the upgrade path is porting pieceTreeBase behind this same interface.
//
// shortcut: one EOL kind per buffer — files mixing \r\n and \n are coalesced to the
// first-seen EOL on load/insert (the real piece tree keeps per-line EOLs).

import { Position } from '../core/position.js';
import { IRange } from '../core/range.js';
import { PrefixSumComputer } from './prefixSumComputer.js';

export const enum DefaultEndOfLine {
	LF = 1,
	CRLF = 2
}

export type EndOfLineSequence = '\n' | '\r\n';

const EOL_REGEX = /\r\n|\r|\n/;

export function detectEol(value: string, defaultEOL: DefaultEndOfLine = DefaultEndOfLine.LF): EndOfLineSequence {
	const match = EOL_REGEX.exec(value);
	if (match) {
		return match[0] === '\r\n' ? '\r\n' : '\n';
	}
	return defaultEOL === DefaultEndOfLine.CRLF ? '\r\n' : '\n';
}

export interface ITextBuffer {
	getLineCount(): number;
	getLineContent(lineNumber: number): string;
	getLineLength(lineNumber: number): number;
	getEOL(): string;
	getLength(): number;
	getValue(): string;
	getValueInRange(range: IRange): string;
	getOffsetAt(lineNumber: number, column: number): number;
	getPositionAt(offset: number): Position;
	insert(offset: number, value: string): void;
	delete(offset: number, length: number): void;
}

export class LineArrayTextBuffer implements ITextBuffer {

	private _lines: string[];
	private readonly _eol: EndOfLineSequence;
	/** values[i] = lines[i].length + eolLength (the last line carries no eol) */
	private _prefixSums: PrefixSumComputer;
	private _length: number;

	constructor(value: string, eol: EndOfLineSequence | undefined, defaultEOL: DefaultEndOfLine) {
		this._eol = eol ?? detectEol(value, defaultEOL);
		this._lines = value.split(EOL_REGEX);
		this._prefixSums = this._createPrefixSums();
		this._length = this._computeLength();
	}

	private _createPrefixSums(): PrefixSumComputer {
		const values = new Uint32Array(this._lines.length);
		for (let i = 0; i < this._lines.length; i++) {
			values[i] = this._lines[i].length + (i < this._lines.length - 1 ? this._eol.length : 0);
		}
		return new PrefixSumComputer(values);
	}

	private _computeLength(): number {
		let length = 0;
		for (let i = 0; i < this._lines.length; i++) {
			length += this._lines[i].length + (i < this._lines.length - 1 ? this._eol.length : 0);
		}
		return length;
	}

	private _rebuild(): void {
		this._prefixSums = this._createPrefixSums();
		this._length = this._computeLength();
	}

	getLineCount(): number {
		return this._lines.length;
	}

	getLineContent(lineNumber: number): string {
		return this._lines[lineNumber - 1];
	}

	getLineLength(lineNumber: number): number {
		return this._lines[lineNumber - 1].length;
	}

	getEOL(): string {
		return this._eol;
	}

	getLength(): number {
		return this._length;
	}

	getValue(): string {
		return this._lines.join(this._eol);
	}

	getValueInRange(range: IRange): string {
		// shortcut: slices the joined value — fine for visible ranges; a column-range join is
		// the upgrade if a hot path ever needs it
		const start = this.getOffsetAt(range.startLineNumber, range.startColumn);
		const end = this.getOffsetAt(range.endLineNumber, range.endColumn);
		return this.getValue().substring(start, end);
	}

	getOffsetAt(lineNumber: number, column: number): number {
		// prefix sums count a line's eol with the line, so the column adds on top
		const lineStart = lineNumber <= 1 ? 0 : this._prefixSums.getPrefixSum(lineNumber - 2);
		const maxColumn = this._lines[lineNumber - 1].length + 1;
		return lineStart + Math.min(column, maxColumn) - 1;
	}

	getPositionAt(offset: number): Position {
		if (offset >= this._length) {
			const lastLine = this._lines.length;
			return new Position(lastLine, this._lines[lastLine - 1].length + 1);
		}
		const result = this._prefixSums.getIndexOf(offset);
		const lineNumber = result.index + 1;
		// an offset inside the eol characters clamps to the line's end column
		const column = Math.min(result.remainder, this._lines[result.index].length) + 1;
		return new Position(lineNumber, column);
	}

	insert(offset: number, value: string): void {
		if (value.length === 0) {
			return;
		}

		const position = this.getPositionAt(offset);
		const lineIndex = position.lineNumber - 1;
		const column = position.column - 1;
		const line = this._lines[lineIndex];

		const parts = value.split(EOL_REGEX);
		if (parts.length === 1) {
			// same-line insert: length-only change, prefix sums update in place
			this._lines[lineIndex] = line.substring(0, column) + value + line.substring(column);
			this._prefixSums.setValue(lineIndex, this._lines[lineIndex].length + (lineIndex < this._lines.length - 1 ? this._eol.length : 0));
			this._length += value.length;
			return;
		}

		const before = line.substring(0, column);
		const after = line.substring(column);
		this._lines.splice(
			lineIndex,
			1,
			before + parts[0],
			...parts.slice(1, parts.length - 1),
			parts[parts.length - 1] + after
		);
		this._rebuild();
	}

	delete(offset: number, length: number): void {
		if (length === 0) {
			return;
		}

		const startPosition = this.getPositionAt(offset);
		const endPosition = this.getPositionAt(offset + length);

		const startLineIndex = startPosition.lineNumber - 1;
		const endLineIndex = endPosition.lineNumber - 1;

		if (startLineIndex === endLineIndex) {
			const line = this._lines[startLineIndex];
			this._lines[startLineIndex] = line.substring(0, startPosition.column - 1) + line.substring(endPosition.column - 1);
			this._prefixSums.setValue(startLineIndex, this._lines[startLineIndex].length + (startLineIndex < this._lines.length - 1 ? this._eol.length : 0));
			this._length -= length;
			return;
		}

		const startLine = this._lines[startLineIndex];
		const endLine = this._lines[endLineIndex];
		const merged = startLine.substring(0, startPosition.column - 1) + endLine.substring(endPosition.column - 1);
		this._lines.splice(startLineIndex, endLineIndex - startLineIndex + 1, merged);
		this._rebuild();
	}
}
