// src/renderer/editor/browser/core/cursorColumns.ts — the movement semantics, ported from
// vs/editor/common/cursor/cursorMoveOperations.ts (MoveOperations), vs/editor/common/core/
// cursorColumns.ts (visible columns) and vs/editor/common/cursor/cursorWordOperations.ts
// (WordOperations). All pure functions over an ICursorModel — the controller stays thin and
// this stays unit-testable.
//
// shortcut: no Intl.Segmenter word segmentation (upstream's classifier segments CJK via
// `wordSeparators`+locales); the character classifier covers the course's word behavior.

import { Position } from '../../../../common/editor/common/core/position.js';
import { IWordAtPosition } from './wordHelper.js';
import { classifyChar, getWordAtTextDefault, prevCharLength, WordCharacterClass } from './wordHelper.js';
import { ViewModel } from '../viewModel.js';

/** what the movement functions need from a text model (TextModel satisfies this structurally) */
export interface ICursorModel {
	getLineContent(lineNumber: number): string;
	getLineMaxColumn(lineNumber: number): number;
	getLineCount(): number;
}

export const enum WordNavigationType {
	WordStart = 0,
	WordStartFast = 1,
	WordEnd = 2
}

// ---- columns

/** the first non-whitespace column of a line, or 0 when the line is all whitespace (real returns 0 too) */
export function firstNonWhitespaceColumn(lineText: string): number {
	const match = /^\s*/.exec(lineText);
	return match && match[0].length < lineText.length ? match[0].length + 1 : 0;
}

/**
 * Home-key behavior, ported VERBATIM from MoveOperations.moveToBeginningOfLine: at the first
 * non-blank column go to column 1, otherwise to the first non-blank column. That rule alone
 * reproduces the "first press → first non-whitespace; second press → column 1" toggle.
 */
export function moveToBeginningOfLine(lineText: string, column: number): number {
	const minColumn = 1;
	const firstNonBlankColumn = firstNonWhitespaceColumn(lineText) || minColumn;
	return column === firstNonBlankColumn ? minColumn : firstNonBlankColumn;
}

export function moveToEndOfLine(lineText: string): number {
	return lineText.length + 1;
}

// ---- vertical moves (desired column)

export interface IVerticalMoveResult {
	readonly lineNumber: number;
	readonly column: number;
	/** the visible-column deficit kept while the target line is too short (upstream: leftoverVisibleColumns) */
	readonly leftoverVisibleColumns: number;
}

/**
 * Ported from MoveOperations.vertical: the desired column travels as a VISIBLE column plus the
 * deficit of the line actually landed on; a long-enough line restores the desired column.
 * Edge lines (first/last) reset the deficit when the move was already at the buffer edge.
 */
export function verticalMove(
	model: ICursorModel,
	viewModel: ViewModel,
	lineNumber: number,
	column: number,
	leftoverVisibleColumns: number,
	newLineNumber: number,
	allowMoveOnEdgeLine: boolean
): IVerticalMoveResult {
	const currentVisibleColumn = viewModel.visibleColumnFromColumn(model.getLineContent(lineNumber), column) + leftoverVisibleColumns;
	const lineCount = model.getLineCount();
	const wasOnFirstPosition = lineNumber === 1 && column === 1;
	const wasOnLastPosition = lineNumber === lineCount && column === model.getLineMaxColumn(lineNumber);
	const wasAtEdgePosition = newLineNumber < lineNumber ? wasOnFirstPosition : wasOnLastPosition;

	lineNumber = newLineNumber;
	let leftover = leftoverVisibleColumns;

	if (lineNumber < 1) {
		lineNumber = 1;
		column = allowMoveOnEdgeLine ? 1 : Math.min(model.getLineMaxColumn(lineNumber), column);
	} else if (lineNumber > lineCount) {
		lineNumber = lineCount;
		column = allowMoveOnEdgeLine ? model.getLineMaxColumn(lineNumber) : Math.min(model.getLineMaxColumn(lineNumber), column);
	} else {
		column = viewModel.columnFromVisibleColumn(model.getLineContent(lineNumber), currentVisibleColumn);
	}

	if (wasAtEdgePosition) {
		leftover = 0;
	} else {
		leftover = currentVisibleColumn - viewModel.visibleColumnFromColumn(model.getLineContent(lineNumber), column);
	}

	return { lineNumber, column, leftoverVisibleColumns: leftover };
}

// ---- horizontal moves

export function moveLeft(model: ICursorModel, position: Position): Position {
	const minColumn = 1;
	if (position.column > minColumn) {
		return position.with(undefined, position.column - prevCharLength(model.getLineContent(position.lineNumber), position.column - 1));
	}
	if (position.lineNumber > 1) {
		const newLineNumber = position.lineNumber - 1;
		return new Position(newLineNumber, model.getLineMaxColumn(newLineNumber));
	}
	return position;
}

export function moveRight(model: ICursorModel, position: Position): Position {
	const lineNumber = position.lineNumber;
	const maxColumn = model.getLineMaxColumn(lineNumber);
	if (position.column < maxColumn) {
		return position.with(undefined, Math.min(maxColumn, position.column + 1));
	}
	if (lineNumber < model.getLineCount()) {
		return new Position(lineNumber + 1, 1);
	}
	return position;
}

// ---- word moves (ported from WordOperations, without the intl segmenter)

interface IFindWordResult {
	/** 0-based start index */
	readonly start: number;
	/** 0-based end index (exclusive) */
	readonly end: number;
	readonly wordType: WordType;
	readonly nextCharClass: WordCharacterClass;
}

const enum WordType {
	None = 0,
	Regular = 1,
	Separator = 2
}

function findEndOfWord(lineContent: string, wordType: WordType, startIndex: number): number {
	const len = lineContent.length;
	for (let chIndex = startIndex; chIndex < len; chIndex++) {
		const chClass = classifyChar(lineContent[chIndex]);
		if (chClass === WordCharacterClass.Whitespace) {
			return chIndex;
		}
		if (wordType === WordType.Regular && chClass === WordCharacterClass.WordSeparator) {
			return chIndex;
		}
		if (wordType === WordType.Separator && chClass === WordCharacterClass.Regular) {
			return chIndex;
		}
	}
	return len;
}

function findStartOfWord(lineContent: string, wordType: WordType, startIndex: number): number {
	for (let chIndex = startIndex; chIndex >= 0; chIndex--) {
		const chClass = classifyChar(lineContent[chIndex]);
		if (chClass === WordCharacterClass.Whitespace) {
			return chIndex + 1;
		}
		if (wordType === WordType.Regular && chClass === WordCharacterClass.WordSeparator) {
			return chIndex + 1;
		}
		if (wordType === WordType.Separator && chClass === WordCharacterClass.Regular) {
			return chIndex + 1;
		}
	}
	return 0;
}

export function findPreviousWordOnLine(lineContent: string, column: number): IFindWordResult | null {
	let wordType = WordType.None;

	for (let chIndex = column - 2; chIndex >= 0; chIndex--) {
		const chClass = classifyChar(lineContent[chIndex]);

		if (chClass === WordCharacterClass.Regular) {
			if (wordType === WordType.Separator) {
				return { start: chIndex + 1, end: findEndOfWord(lineContent, wordType, chIndex + 1), wordType, nextCharClass: chClass };
			}
			wordType = WordType.Regular;
		} else if (chClass === WordCharacterClass.WordSeparator) {
			if (wordType === WordType.Regular) {
				return { start: chIndex + 1, end: findEndOfWord(lineContent, wordType, chIndex + 1), wordType, nextCharClass: chClass };
			}
			wordType = WordType.Separator;
		} else if (chClass === WordCharacterClass.Whitespace) {
			if (wordType !== WordType.None) {
				return { start: chIndex + 1, end: findEndOfWord(lineContent, wordType, chIndex + 1), wordType, nextCharClass: chClass };
			}
		}
	}

	if (wordType !== WordType.None) {
		return { start: 0, end: findEndOfWord(lineContent, wordType, 0), wordType, nextCharClass: WordCharacterClass.Whitespace };
	}
	return null;
}

export function findNextWordOnLine(lineContent: string, column: number): IFindWordResult | null {
	let wordType = WordType.None;
	const len = lineContent.length;

	for (let chIndex = column - 1; chIndex < len; chIndex++) {
		const chClass = classifyChar(lineContent[chIndex]);

		if (chClass === WordCharacterClass.Regular) {
			if (wordType === WordType.Separator) {
				return { start: findStartOfWord(lineContent, wordType, chIndex - 1), end: chIndex, wordType, nextCharClass: chClass };
			}
			wordType = WordType.Regular;
		} else if (chClass === WordCharacterClass.WordSeparator) {
			if (wordType === WordType.Regular) {
				return { start: findStartOfWord(lineContent, wordType, chIndex - 1), end: chIndex, wordType, nextCharClass: chClass };
			}
			wordType = WordType.Separator;
		} else if (chClass === WordCharacterClass.Whitespace) {
			if (wordType !== WordType.None) {
				return { start: findStartOfWord(lineContent, wordType, chIndex - 1), end: chIndex, wordType, nextCharClass: chClass };
			}
		}
	}

	if (wordType !== WordType.None) {
		return { start: findStartOfWord(lineContent, wordType, len - 1), end: len, wordType, nextCharClass: WordCharacterClass.Whitespace };
	}
	return null;
}

/** ported from WordOperations.moveWordLeft (mac alt+left: WordStartFast) */
export function moveWordLeft(model: ICursorModel, position: Position, navigationType: WordNavigationType): Position {
	let lineNumber = position.lineNumber;
	let column = position.column;

	if (column === 1) {
		if (lineNumber > 1) {
			lineNumber = lineNumber - 1;
			column = model.getLineMaxColumn(lineNumber);
		}
	}

	let prevWordOnLine = findPreviousWordOnLine(model.getLineContent(lineNumber), column);

	if (navigationType === WordNavigationType.WordStart) {
		return new Position(lineNumber, prevWordOnLine ? prevWordOnLine.start + 1 : 1);
	}

	if (navigationType === WordNavigationType.WordStartFast) {
		if (
			prevWordOnLine
			&& prevWordOnLine.wordType === WordType.Separator
			&& prevWordOnLine.end - prevWordOnLine.start === 1
			&& prevWordOnLine.nextCharClass === WordCharacterClass.Regular
		) {
			// skip over a word made up of one single separator and followed by a regular character
			prevWordOnLine = findPreviousWordOnLine(model.getLineContent(lineNumber), prevWordOnLine.start + 1);
		}
		return new Position(lineNumber, prevWordOnLine ? prevWordOnLine.start + 1 : 1);
	}

	// stopping at the ending of words
	if (prevWordOnLine && column <= prevWordOnLine.end + 1) {
		prevWordOnLine = findPreviousWordOnLine(model.getLineContent(lineNumber), prevWordOnLine.start + 1);
	}
	return new Position(lineNumber, prevWordOnLine ? prevWordOnLine.end + 1 : 1);
}

/** ported from WordOperations.moveWordRight (mac alt+right: WordEnd) */
export function moveWordRight(model: ICursorModel, position: Position, navigationType: WordNavigationType): Position {
	let lineNumber = position.lineNumber;
	let column = position.column;

	let movedDown = false;
	if (column === model.getLineMaxColumn(lineNumber)) {
		if (lineNumber < model.getLineCount()) {
			movedDown = true;
			lineNumber = lineNumber + 1;
			column = 1;
		}
	}

	let nextWordOnLine = findNextWordOnLine(model.getLineContent(lineNumber), column);

	if (navigationType === WordNavigationType.WordEnd) {
		if (nextWordOnLine && nextWordOnLine.wordType === WordType.Separator) {
			if (nextWordOnLine.end - nextWordOnLine.start === 1 && nextWordOnLine.nextCharClass === WordCharacterClass.Regular) {
				nextWordOnLine = findNextWordOnLine(model.getLineContent(lineNumber), nextWordOnLine.end + 1);
			}
		}
		if (nextWordOnLine) {
			return new Position(lineNumber, nextWordOnLine.end + 1);
		}
		return new Position(lineNumber, model.getLineMaxColumn(lineNumber));
	}

	// WordStart (used by explicit cursorWordStartRight; not bound on mac by default)
	if (nextWordOnLine && !movedDown && column >= nextWordOnLine.start + 1) {
		nextWordOnLine = findNextWordOnLine(model.getLineContent(lineNumber), nextWordOnLine.end + 1);
	}
	return new Position(lineNumber, nextWordOnLine ? nextWordOnLine.start + 1 : model.getLineMaxColumn(lineNumber));
}

// ---- word at position (mouse double-click)

/**
 * The word enclosing a column: the regexp word first, else the classifier run under the
 * cursor (separator or whitespace runs are their own selectable "words" on double click).
 */
export function getWordOrSeparatorAtColumn(lineText: string, column: number): IWordAtPosition | null {
	const word = getWordAtTextDefault(column, lineText);
	if (word) {
		return word;
	}
	if (lineText.length === 0) {
		return null;
	}
	const index = Math.max(0, Math.min(lineText.length - 1, column - 1));
	const cls = classifyChar(lineText[index]);
	let start = index;
	let end = index + 1;
	while (start > 0 && classifyChar(lineText[start - 1]) === cls) {
		start--;
	}
	while (end < lineText.length && classifyChar(lineText[end]) === cls) {
		end++;
	}
	return { word: lineText.substring(start, end), startColumn: start + 1, endColumn: end + 1 };
}
