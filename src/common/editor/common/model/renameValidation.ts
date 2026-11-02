// src/common/editor/common/model/renameValidation.ts — the pure logic behind the rename input
// box: which range the box seeds itself from, whether a typed name is acceptable, and whether a
// provider's answer is sane enough to apply.
//
// Ported in behaviour from vs/editor/contrib/rename/browser/rename.ts (RenameSkeleton's
// resolveRenameLocation, which falls back to the word under the cursor) and from renameWidget.ts,
// which refuses a name that is empty, whitespace-only, or equal to the current one.
//
// shortcut: this is not a language-aware identifier check — `class` or `2nd` pass here. A
// language server's prepareRename is the real check, and it also owns the range; upgrade when the
// LSP client forwards textDocument/prepareRename.

import { IRange } from '../core/range.js';
// the word logic is multicursor's `wordAt` — same question, same answer, and a second copy would
// drift. It should live in core/wordHelper.ts; it cannot move while that file is another agent's.
import { wordAt } from '../../../../renderer/editor/contrib/multicursor/multicursor.js';

export { wordAt };

/** what the rename box opens with: the range it will replace and the text to preselect */
export interface RenameLocation {
	readonly range: IRange;
	readonly text: string;
}

/** the minimum an edit has to look like for the sanity check; ISingleEditOperation satisfies it */
export interface IRenameEditLike {
	readonly text: string | null;
}

/**
 * The word at a position, as the range the rename box will replace. A cursor just after a word
 * belongs to that word — that is where it sits after typing the name.
 */
export function renameLocationAt(lineText: string, lineNumber: number, column: number): RenameLocation | null {
	const word = wordAt(lineText, column);
	if (!word) {
		return null;
	}
	return {
		range: {
			startLineNumber: lineNumber,
			startColumn: word.startColumn,
			endLineNumber: lineNumber,
			endColumn: word.endColumn
		},
		text: lineText.substring(word.startColumn - 1, word.endColumn - 1)
	};
}

/**
 * Why the proposed name cannot be used, or null if it can. The box shows the reason, so each one
 * says what the user has to change.
 */
export function validateNewName(newName: string, oldName: string): string | null {
	if (newName.length === 0) {
		return 'The new name cannot be empty.';
	}
	if (/[\r\n]/.test(newName)) {
		return 'The new name cannot contain a line break.';
	}
	if (newName.trim().length === 0) {
		return 'The new name cannot be only whitespace.';
	}
	if (newName !== newName.trim()) {
		return 'The new name cannot start or end with whitespace.';
	}
	// an unchanged name is a no-op, not an edit: applying it would push an empty undo step
	if (newName === oldName) {
		return 'The new name is the same as the old name.';
	}
	return null;
}

/**
 * The last gate before the edits are applied: a provider that returns nothing, or edits whose
 * text never mentions the new name, has answered a different question — applying it would
 * scramble the file. Returns the reason to refuse, or null to go ahead.
 */
export function validateRenameResult(edits: readonly IRenameEditLike[], newName: string): string | null {
	if (edits.length === 0) {
		return 'No result.';
	}
	for (const edit of edits) {
		if (!edit.text || !edit.text.includes(newName)) {
			return `Rename produced an edit that does not contain '${newName}'.`;
		}
	}
	return null;
}
