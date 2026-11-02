// src/renderer/editor/contrib/multicursor/multicursor.ts — the commands that add cursors.
//
// Ported in shape from vs/editor/contrib/multicursor/browser/multicursor.ts. The cursor
// bookkeeping (ordering, merging, where cursors land after an edit) is in
// common/editor/common/model/multiCursor.ts and tested there; the controller holds the set and
// the widget applies one edit per cursor.
//
// No controller class: like the line operations, these are pure functions of the current cursor
// set, so the commands read the active widget.

import { IDisposable, toDisposable } from '../../../../common/base/common/lifecycle.js';
import { findMatches } from '../../../../common/editor/common/model/textModelSearch.js';
import { CommandMetadata, CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { RawContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { KeyCode, KeyMod } from '../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { USUAL_WORD_SEPARATORS } from '../../browser/core/wordHelper.js';
import { Selection } from '../../browser/core/selection.js';
import type { EditorWidget } from '../../browser/editorWidget.js';

/** the reference's core-command id for Escape collapsing the set */
export const REMOVE_SECONDARY_CURSORS_ID = 'removeSecondaryCursors';

/** the real ids, verified against the reference's multicursor.ts */
export const MULTICURSOR_IDS = {
	InsertCursorAbove: 'editor.action.insertCursorAbove',
	InsertCursorBelow: 'editor.action.insertCursorBelow',
	AddSelectionToNextFindMatch: 'editor.action.addSelectionToNextFindMatch',
	InsertCursorAtEndOfEachLineSelected: 'editor.action.insertCursorAtEndOfEachLineSelected'
} as const;

/** a cursor one line above or below every current cursor, keeping its column where the line allows */
function insertCursor(widget: EditorWidget, direction: 'above' | 'below'): void {
	const model = widget.getModel();
	if (!model) {
		return;
	}
	const existing = widget.getSelections();
	const step = direction === 'above' ? -1 : 1;
	const added: Selection[] = [];

	for (const selection of existing) {
		const lineNumber = selection.activeLineNumber + step;
		if (lineNumber < 1 || lineNumber > model.getLineCount()) {
			continue; // at the edge of the file there is nowhere to add one
		}
		const column = Math.min(selection.activeColumn, model.getLineMaxColumn(lineNumber));
		added.push(new Selection(lineNumber, column, lineNumber, column));
	}

	if (added.length === 0) {
		return;
	}
	// the new cursors join the set; the primary stays where it was, so the next press extends from
	// the same place rather than walking away
	const combined = direction === 'above' ? [...added, ...existing] : [...existing, ...added];
	widget.setSelections(combined, combined.indexOf(existing[0]));
}

/**
 * Select the next occurrence of what is already selected, adding a cursor there.
 *
 * With an empty selection the word under the cursor is selected first — the reference does the
 * same, and it is what makes Ctrl+D useful as the first keystroke rather than the second.
 */
function addSelectionToNextFindMatch(widget: EditorWidget): void {
	const model = widget.getModel();
	if (!model) {
		return;
	}
	const selections = widget.getSelections();
	const last = selections[selections.length - 1];

	if (last.isEmpty()) {
		const word = wordAt(model.getLineContent(last.startLineNumber), last.startColumn);
		if (!word) {
			return;
		}
		widget.setSelections([
			...selections.slice(0, selections.length - 1),
			new Selection(last.startLineNumber, word.startColumn, last.startLineNumber, word.endColumn)
		], selections.length - 1);
		return;
	}

	const searchText = model.getValueInRange(last);
	if (searchText.length === 0 || searchText.includes('\n')) {
		return; // a multi-line selection has no sensible "next occurrence"
	}

	const { matches } = findMatches(model, {
		searchString: searchText,
		isRegExp: false,
		matchCase: true,
		wholeWord: false,
		wordSeparators: USUAL_WORD_SEPARATORS
	}, { captureMatches: false });

	if (matches.length <= selections.length) {
		return; // every occurrence already has a cursor
	}

	// the first match after the last cursor, wrapping — so Ctrl+D keeps finding work to do
	const taken = new Set(selections.map(selection => `${selection.startLineNumber}:${selection.startColumn}`));
	const afterLast = matches.find(match =>
		!taken.has(`${match.range.startLineNumber}:${match.range.startColumn}`)
		&& (match.range.startLineNumber > last.endLineNumber
			|| (match.range.startLineNumber === last.endLineNumber && match.range.startColumn >= last.endColumn)));
	const next = afterLast ?? matches.find(match => !taken.has(`${match.range.startLineNumber}:${match.range.startColumn}`));
	if (!next) {
		return;
	}

	const { startLineNumber, startColumn, endLineNumber, endColumn } = next.range;
	const combined = [...selections, new Selection(startLineNumber, startColumn, endLineNumber, endColumn)];
	widget.setSelections(combined, combined.length - 1);
	widget.revealPosition(next.range.getStartPosition());
}

/** a cursor at the end of every line the selection touches */
function insertCursorAtEndOfEachLineSelected(widget: EditorWidget): void {
	const model = widget.getModel();
	if (!model) {
		return;
	}
	const selection = widget.getSelection();
	if (selection.isEmpty()) {
		return;
	}
	// a selection ending at column 1 does not really include that line, the same rule the line
	// operations use
	const endLine = selection.endLineNumber > selection.startLineNumber && selection.endColumn === 1
		? selection.endLineNumber - 1
		: selection.endLineNumber;

	const cursors: Selection[] = [];
	for (let lineNumber = selection.startLineNumber; lineNumber <= endLine; lineNumber++) {
		const column = model.getLineMaxColumn(lineNumber);
		cursors.push(new Selection(lineNumber, column, lineNumber, column));
	}
	if (cursors.length > 0) {
		widget.setSelections(cursors, cursors.length - 1);
	}
}

/** the word around a column, as the suggest and hover contribs understand words */
export function wordAt(lineText: string, column: number): { startColumn: number; endColumn: number } | null {
	const isWordCharacter = (character: string): boolean =>
		character.length > 0 && !USUAL_WORD_SEPARATORS.includes(character) && !/\s/.test(character);

	let start = column - 1;
	let end = column - 1;
	// a cursor sitting just after a word belongs to that word, which is where it lands after typing
	if (start > 0 && !isWordCharacter(lineText[start] ?? '') && isWordCharacter(lineText[start - 1] ?? '')) {
		start--;
		end--;
	}
	if (!isWordCharacter(lineText[start] ?? '')) {
		return null;
	}
	while (start > 0 && isWordCharacter(lineText[start - 1])) {
		start--;
	}
	while (end < lineText.length - 1 && isWordCharacter(lineText[end + 1])) {
		end++;
	}
	return { startColumn: start + 1, endColumn: end + 2 };
}

export function registerMulticursorCommands(getActiveWidget: () => EditorWidget | null): IDisposable {
	const disposables: IDisposable[] = [];
	const when = new RawContextKey<boolean>('editorTextFocus', false);

	const register = (id: string, title: string, run: (widget: EditorWidget) => void, primary?: number): void => {
		disposables.push(CommandsRegistry.registerCommand(id, () => {
			const widget = getActiveWidget();
			if (widget) {
				run(widget);
			}
		}));
		disposables.push(CommandMetadata.register({ id, title, category: 'Cursor' }));
		if (primary !== undefined) {
			disposables.push(KeybindingsRegistry.registerKeybindingRule({
				id,
				weight: KeybindingWeight.EditorCore,
				when: when as never,
				primary
			}));
		}
	};

	register(MULTICURSOR_IDS.InsertCursorAbove, 'Add Cursor Above',
		widget => insertCursor(widget, 'above'), KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.UpArrow);
	register(MULTICURSOR_IDS.InsertCursorBelow, 'Add Cursor Below',
		widget => insertCursor(widget, 'below'), KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.DownArrow);
	register(MULTICURSOR_IDS.AddSelectionToNextFindMatch, 'Add Selection To Next Find Match',
		addSelectionToNextFindMatch, KeyMod.CtrlCmd | KeyCode.KeyD);
	register(MULTICURSOR_IDS.InsertCursorAtEndOfEachLineSelected, 'Add Cursors to Line Ends',
		insertCursorAtEndOfEachLineSelected, KeyMod.Shift | KeyMod.Alt | KeyCode.KeyI);

	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
