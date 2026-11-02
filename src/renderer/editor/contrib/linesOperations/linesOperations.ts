// src/renderer/editor/contrib/linesOperations/linesOperations.ts — the commands that apply
// `lineEdits.ts`, with the real ids and keybindings from the reference's
// editor/contrib/linesOperations and editor/contrib/comment.
//
// There is no controller class and no per-widget state: every operation is a pure function of the
// model plus the current selection, so the command reads the active widget and applies one edit.

import { IDisposable, toDisposable } from '../../../../common/base/common/lifecycle.js';
import { Range } from '../../../../common/editor/common/core/range.js';
import { CommandMetadata, CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { RawContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { KeyCode, KeyMod } from '../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { Selection } from '../../browser/core/selection.js';
import { EditorWidget } from '../../browser/editorWidget.js';
import {
	copyLines, deleteLines, ILineEdit, indentLines, moveLinesDown, moveLinesUp,
	toggleBlockComment, toggleLineComment
} from './lineEdits.js';

/** the real ids, verified against the reference's linesOperations.ts and comment.ts */
export const LINE_OPERATION_IDS = {
	MoveLinesUpAction: 'editor.action.moveLinesUpAction',
	MoveLinesDownAction: 'editor.action.moveLinesDownAction',
	CopyLinesUpAction: 'editor.action.copyLinesUpAction',
	CopyLinesDownAction: 'editor.action.copyLinesDownAction',
	DeleteLines: 'editor.action.deleteLines',
	IndentLines: 'editor.action.indentLines',
	OutdentLines: 'editor.action.outdentLines',
	CommentLine: 'editor.action.commentLine',
	BlockComment: 'editor.action.blockComment'
} as const;

export interface ILineOperationsContext {
	getActiveWidget(): EditorWidget | null;
	/** indentation settings; the reference reads these from the model's options */
	getIndentOptions(): { tabSize: number; insertSpaces: boolean };
}

/**
 * Apply one computed edit and put the selection where the operation asked.
 *
 * A selection that was a bare cursor stays a bare cursor — on the operation's target line, at the
 * old column clamped to that line. A selection that covered text comes back covering whole lines.
 * Anything else makes repeated presses of Alt+Up fight the cursor.
 */
function applyLineEdit(widget: EditorWidget, edit: ILineEdit | null): void {
	if (!edit) {
		return;
	}
	const before = widget.getSelection();
	widget.replaceRange(
		new Range(edit.startLineNumber, edit.startColumn, edit.endLineNumber, edit.endColumn),
		edit.text
	);

	const model = widget.getModel();
	if (!model) {
		return;
	}
	const lineCount = model.getLineCount();
	const startLine = Math.min(Math.max(edit.selectionStartLine, 1), lineCount);
	const endLine = Math.min(Math.max(edit.selectionEndLine, 1), lineCount);

	if (before.isEmpty()) {
		const column = Math.min(before.activeColumn, model.getLineMaxColumn(startLine));
		widget.setSelection(new Selection(startLine, column, startLine, column));
		return;
	}
	widget.setSelection(new Selection(startLine, 1, endLine, model.getLineMaxColumn(endLine)));
}

/** the whole lines the current selection touches */
function selectedLines(widget: EditorWidget): { startLine: number; endLine: number } {
	const selection = widget.getSelection();
	// a selection ending at column 1 of a line does not really include that line, which is what
	// makes a downward drag comment one line too many
	const endLine = selection.endLineNumber > selection.startLineNumber && selection.endColumn === 1
		? selection.endLineNumber - 1
		: selection.endLineNumber;
	return { startLine: selection.startLineNumber, endLine };
}

export function registerLineOperationCommands(context: ILineOperationsContext): IDisposable {
	const disposables: IDisposable[] = [];
	const when = new RawContextKey<boolean>('editorTextFocus', false);

	const register = (
		id: string,
		title: string,
		run: (widget: EditorWidget) => void,
		binding?: { primary?: number; secondary?: number }
	): void => {
		disposables.push(CommandsRegistry.registerCommand(id, () => {
			const widget = context.getActiveWidget();
			if (widget) {
				run(widget);
			}
		}));
		disposables.push(CommandMetadata.register({ id, title, category: 'Editing' }));
		if (binding) {
			disposables.push(KeybindingsRegistry.registerKeybindingRule({
				id,
				weight: KeybindingWeight.EditorCore,
				when: when as never,
				primary: binding.primary,
				secondary: binding.secondary
			}));
		}
	};

	/** run a whole-line operation against the active model */
	const onLines = (compute: (widget: EditorWidget, startLine: number, endLine: number) => ILineEdit | null) =>
		(widget: EditorWidget): void => {
			if (!widget.getModel()) {
				return;
			}
			const { startLine, endLine } = selectedLines(widget);
			applyLineEdit(widget, compute(widget, startLine, endLine));
		};

	register(LINE_OPERATION_IDS.MoveLinesUpAction, 'Move Line Up',
		onLines((widget, start, end) => moveLinesUp(widget.getModel()!, start, end)),
		{ primary: KeyMod.Alt | KeyCode.UpArrow });

	register(LINE_OPERATION_IDS.MoveLinesDownAction, 'Move Line Down',
		onLines((widget, start, end) => moveLinesDown(widget.getModel()!, start, end)),
		{ primary: KeyMod.Alt | KeyCode.DownArrow });

	register(LINE_OPERATION_IDS.CopyLinesUpAction, 'Copy Line Up',
		onLines((widget, start, end) => copyLines(widget.getModel()!, start, end, 'up')),
		{ primary: KeyMod.Shift | KeyMod.Alt | KeyCode.UpArrow });

	register(LINE_OPERATION_IDS.CopyLinesDownAction, 'Copy Line Down',
		onLines((widget, start, end) => copyLines(widget.getModel()!, start, end, 'down')),
		{ primary: KeyMod.Shift | KeyMod.Alt | KeyCode.DownArrow });

	register(LINE_OPERATION_IDS.DeleteLines, 'Delete Line',
		onLines((widget, start, end) => deleteLines(widget.getModel()!, start, end)),
		{ primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyK });

	register(LINE_OPERATION_IDS.IndentLines, 'Indent Line',
		onLines((widget, start, end) => indentLines(widget.getModel()!, start, end, 'indent', context.getIndentOptions())),
		{ primary: KeyMod.CtrlCmd | KeyCode.BracketRight });

	register(LINE_OPERATION_IDS.OutdentLines, 'Outdent Line',
		onLines((widget, start, end) => indentLines(widget.getModel()!, start, end, 'outdent', context.getIndentOptions())),
		{ primary: KeyMod.CtrlCmd | KeyCode.BracketLeft });

	register(LINE_OPERATION_IDS.CommentLine, 'Toggle Line Comment',
		onLines((widget, start, end) => {
			const tokens = widget.getLanguageConfiguration().comments;
			// a language with no line comment (CSS, HTML) falls back to its block comment, which
			// is what Ctrl+/ does in the reference
			return toggleLineComment(widget.getModel()!, start, end, tokens)
				?? toggleBlockComment(widget.getModel()!, start, end, tokens);
		}),
		{ primary: KeyMod.CtrlCmd | KeyCode.Slash });

	register(LINE_OPERATION_IDS.BlockComment, 'Toggle Block Comment',
		onLines((widget, start, end) =>
			toggleBlockComment(widget.getModel()!, start, end, widget.getLanguageConfiguration().comments)),
		{ primary: KeyMod.Shift | KeyMod.Alt | KeyCode.KeyA });

	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
