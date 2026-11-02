// src/renderer/editor/contrib/linesOperations/lineEdits.ts — the edit each line operation
// produces, as pure functions.
//
// Ported in behaviour from vs/editor/contrib/linesOperations/browser/linesOperations.ts and
// vs/editor/contrib/comment/browser/{lineCommentCommand,blockCommentCommand}.ts.
//
// Every operation returns ONE edit (a range plus its replacement) and the selection to leave
// behind. One edit means one undo step for free — no bracketing, no ordering hazard, and no way
// for a half-applied operation to exist.
//
// Nothing here touches the DOM or the widget, so the index arithmetic — which is where these
// operations go wrong — is unit tested.

import { ICommentTokens } from '../../../../common/editor/common/languages/languageConfiguration.js';

export interface ILineEdit {
	/** 1-based, end-exclusive in the column sense the model uses */
	readonly startLineNumber: number;
	readonly startColumn: number;
	readonly endLineNumber: number;
	readonly endColumn: number;
	readonly text: string;
	/** where to leave the selection afterwards, as whole lines */
	readonly selectionStartLine: number;
	readonly selectionEndLine: number;
}

/** the model surface these functions read */
export interface ILineSource {
	getLineCount(): number;
	getLineContent(lineNumber: number): string;
}

function maxColumn(source: ILineSource, lineNumber: number): number {
	return source.getLineContent(lineNumber).length + 1;
}

/** the lines [start, end] joined as they appear in the document */
function joinLines(source: ILineSource, start: number, end: number): string {
	const lines: string[] = [];
	for (let lineNumber = start; lineNumber <= end; lineNumber++) {
		lines.push(source.getLineContent(lineNumber));
	}
	return lines.join('\n');
}

/**
 * Move the selected lines up by one.
 *
 * Returns null at the top of the file: a no-op is the correct answer, and returning an edit that
 * "moves" line 1 above itself is how this operation corrupts a file.
 */
export function moveLinesUp(source: ILineSource, startLine: number, endLine: number): ILineEdit | null {
	if (startLine <= 1) {
		return null;
	}
	const above = source.getLineContent(startLine - 1);
	return {
		startLineNumber: startLine - 1,
		startColumn: 1,
		endLineNumber: endLine,
		endColumn: maxColumn(source, endLine),
		text: `${joinLines(source, startLine, endLine)}\n${above}`,
		selectionStartLine: startLine - 1,
		selectionEndLine: endLine - 1
	};
}

/** Move the selected lines down by one; null at the bottom of the file. */
export function moveLinesDown(source: ILineSource, startLine: number, endLine: number): ILineEdit | null {
	if (endLine >= source.getLineCount()) {
		return null;
	}
	const below = source.getLineContent(endLine + 1);
	return {
		startLineNumber: startLine,
		startColumn: 1,
		endLineNumber: endLine + 1,
		endColumn: maxColumn(source, endLine + 1),
		text: `${below}\n${joinLines(source, startLine, endLine)}`,
		selectionStartLine: startLine + 1,
		selectionEndLine: endLine + 1
	};
}

/**
 * Duplicate the selected lines.
 *
 * `up` leaves the selection on the upper copy and `down` on the lower one, which is what makes
 * repeated presses stack copies instead of fighting the cursor.
 */
export function copyLines(source: ILineSource, startLine: number, endLine: number, direction: 'up' | 'down'): ILineEdit {
	const block = joinLines(source, startLine, endLine);
	const span = endLine - startLine + 1;
	return {
		startLineNumber: startLine,
		startColumn: 1,
		endLineNumber: endLine,
		endColumn: maxColumn(source, endLine),
		text: `${block}\n${block}`,
		selectionStartLine: direction === 'up' ? startLine : startLine + span,
		selectionEndLine: direction === 'up' ? endLine : endLine + span
	};
}

/**
 * Delete the selected lines, including their line break.
 *
 * The last line of a file has no trailing break, so it takes the PRECEDING break instead —
 * otherwise deleting the last line leaves a blank line behind.
 */
export function deleteLines(source: ILineSource, startLine: number, endLine: number): ILineEdit {
	const lineCount = source.getLineCount();

	if (endLine < lineCount) {
		return {
			startLineNumber: startLine,
			startColumn: 1,
			endLineNumber: endLine + 1,
			endColumn: 1,
			text: '',
			selectionStartLine: startLine,
			selectionEndLine: startLine
		};
	}

	if (startLine > 1) {
		return {
			startLineNumber: startLine - 1,
			startColumn: maxColumn(source, startLine - 1),
			endLineNumber: endLine,
			endColumn: maxColumn(source, endLine),
			text: '',
			selectionStartLine: startLine - 1,
			selectionEndLine: startLine - 1
		};
	}

	// the whole document: empty it rather than removing a break that does not exist
	return {
		startLineNumber: 1,
		startColumn: 1,
		endLineNumber: lineCount,
		endColumn: maxColumn(source, lineCount),
		text: '',
		selectionStartLine: 1,
		selectionEndLine: 1
	};
}

/** Indent or outdent whole lines by one unit. Outdent removes at most one unit, never text. */
export function indentLines(
	source: ILineSource,
	startLine: number,
	endLine: number,
	direction: 'indent' | 'outdent',
	options: { tabSize: number; insertSpaces: boolean }
): ILineEdit | null {
	const unit = options.insertSpaces ? ' '.repeat(Math.max(1, options.tabSize)) : '\t';
	const result: string[] = [];
	let changed = false;

	for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
		const line = source.getLineContent(lineNumber);
		if (direction === 'indent') {
			// a blank line gains nothing: trailing whitespace is noise, not indentation
			if (line.length === 0) {
				result.push(line);
				continue;
			}
			result.push(unit + line);
			changed = true;
			continue;
		}

		// remove at most one unit of leading whitespace, and never any text — a partial indent
		// (two spaces at a four-space tab size) outdents to nothing rather than being left alone
		const leading = /^[ \t]*/.exec(line)![0];
		if (leading.length === 0) {
			result.push(line);
			continue;
		}
		const take = line.startsWith(unit)
			? unit.length
			: Math.min(leading.length, line.startsWith('\t') ? 1 : Math.max(1, options.tabSize));
		result.push(line.slice(take));
		changed = true;
	}

	if (!changed) {
		return null;
	}

	return {
		startLineNumber: startLine,
		startColumn: 1,
		endLineNumber: endLine,
		endColumn: maxColumn(source, endLine),
		text: result.join('\n'),
		selectionStartLine: startLine,
		selectionEndLine: endLine
	};
}

// ---- comments

/** the column (1-based) of the first non-whitespace character, or the line length + 1 */
export function firstNonWhitespaceColumn(line: string): number {
	for (let i = 0; i < line.length; i++) {
		if (line[i] !== ' ' && line[i] !== '\t') {
			return i + 1;
		}
	}
	return line.length + 1;
}

/**
 * Toggle a line comment across [startLine, endLine].
 *
 * The reference's rule, and the one users expect: if EVERY non-blank line is already commented,
 * remove the token from all of them; otherwise add it to all of them. A selection of mixed lines
 * therefore becomes fully commented in one press rather than flipping each line individually.
 *
 * Added tokens go at the shallowest indentation in the block, so a commented block keeps its
 * shape instead of having the token jammed against each line's own indent.
 */
export function toggleLineComment(source: ILineSource, startLine: number, endLine: number, tokens: ICommentTokens): ILineEdit | null {
	const token = tokens.line;
	if (!token) {
		return null; // the language has no line comment — the caller falls back to block
	}

	const lines: string[] = [];
	let allCommented = true;
	let sawContent = false;
	let minIndent = Number.MAX_SAFE_INTEGER;

	for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
		const line = source.getLineContent(lineNumber);
		lines.push(line);
		if (line.trim().length === 0) {
			continue; // blank lines do not vote
		}
		sawContent = true;
		const indent = firstNonWhitespaceColumn(line) - 1;
		minIndent = Math.min(minIndent, indent);
		if (!line.slice(indent).startsWith(token)) {
			allCommented = false;
		}
	}

	if (!sawContent) {
		return null; // nothing but blank lines: leave them alone
	}
	if (minIndent === Number.MAX_SAFE_INTEGER) {
		minIndent = 0;
	}

	const result = lines.map(line => {
		if (line.trim().length === 0) {
			return line;
		}
		const indent = firstNonWhitespaceColumn(line) - 1;
		if (allCommented) {
			// remove the token and exactly one following space, if the insert added one
			const rest = line.slice(indent + token.length);
			return line.slice(0, indent) + (rest.startsWith(' ') ? rest.slice(1) : rest);
		}
		return `${line.slice(0, minIndent)}${token} ${line.slice(minIndent)}`;
	});

	return {
		startLineNumber: startLine,
		startColumn: 1,
		endLineNumber: endLine,
		endColumn: source.getLineContent(endLine).length + 1,
		text: result.join('\n'),
		selectionStartLine: startLine,
		selectionEndLine: endLine
	};
}

/**
 * Wrap [startLine, endLine] in a block comment, or unwrap it when it already is one.
 *
 * Operates on whole lines rather than the exact selection: a block comment inserted mid-token is
 * a syntax error, and whole lines are what Shift+Alt+A is used for in practice.
 *
 * shortcut: whole-line granularity. The reference wraps the exact selection; upgrade when
 * commenting part of a line is needed.
 */
export function toggleBlockComment(source: ILineSource, startLine: number, endLine: number, tokens: ICommentTokens): ILineEdit | null {
	const { blockStart, blockEnd } = tokens;
	if (!blockStart || !blockEnd) {
		return null;
	}

	const block = joinLines(source, startLine, endLine);
	const trimmed = block.trim();
	const isCommented = trimmed.startsWith(blockStart) && trimmed.endsWith(blockEnd)
		&& trimmed.length >= blockStart.length + blockEnd.length;

	const text = isCommented
		? block.replace(trimmed, trimmed.slice(blockStart.length, trimmed.length - blockEnd.length).trim())
		: `${blockStart} ${block} ${blockEnd}`;

	return {
		startLineNumber: startLine,
		startColumn: 1,
		endLineNumber: endLine,
		endColumn: source.getLineContent(endLine).length + 1,
		text,
		selectionStartLine: startLine,
		selectionEndLine: endLine
	};
}
