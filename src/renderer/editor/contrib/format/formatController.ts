// src/renderer/editor/contrib/format/formatController.ts — Format Document (Shift+Alt+F).
//
// Ported in shape from vs/editor/contrib/format/browser/formatActions.ts (the id and the
// keybinding come from FormatDocumentAction there) plus format.ts, which asks the provider,
// orders the edits and pushes them as one undo element.
//
// Stateless, like linesOperations.ts: there is no widget-local state worth keeping, so this is
// the command plus two pure helpers. The ordering/overlap/no-op logic lives in formattingEdits.ts
// and is tested there.
//
// shortcut: one provider (the first registered) and no progress UI, where the reference picks
// between providers via `editor.defaultFormatter` and shows a progress spinner after 250ms.
// Upgrade when more than one formatter can register for a language.

import { IDisposable, toDisposable } from '../../../../common/base/common/lifecycle.js';
import { Position } from '../../../../common/editor/common/core/position.js';
import { Range } from '../../../../common/editor/common/core/range.js';
import { ITextEdit, prepareFormattingEdits } from '../../../../common/editor/common/model/formattingEdits.js';
import { URI } from '../../../../common/base/common/uri.js';
import type { IWireFormattingOptions, IWireTextEdit } from '../../../../common/platform/extensions/common/extensionHostProtocol.js';
import { CommandMetadata, CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { RawContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { KeyCode, KeyMod } from '../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILanguageFeaturesService, toEditorRange } from '../../../workbench/api/common/mainThreadLanguageFeatures.js';
import { Selection } from '../../browser/core/selection.js';
import type { EditorWidget } from '../../browser/editorWidget.js';

/** the real id, from FormatDocumentAction in the reference's format/browser/formatActions.ts */
export const FORMAT_IDS = {
	FormatDocument: 'editor.action.formatDocument'
} as const;

export interface IFormatContext {
	getActiveWidget(): EditorWidget | null;
	/** the active widget's file; undefined for a widget with no input, and then nothing to format */
	getResource(widget: EditorWidget): URI | undefined;
	languageFeatures: ILanguageFeaturesService;
	/** what the provider is told about indentation; the same values the `tab` command uses */
	getFormattingOptions(): IWireFormattingOptions;
}

/** the document surface the helpers below read, so they are testable without a widget */
export interface IFormatModel {
	getLineCount(): number;
	getLineMaxColumn(lineNumber: number): number;
}

/**
 * Wire edits (0-based LSP) to editor edits (1-based).
 *
 * This is the whole 0/1-based boundary for formatting: everything after it is editor coordinates.
 */
export function toFormattingEdits(wireEdits: readonly IWireTextEdit[]): ITextEdit[] {
	return wireEdits.map(wireEdit => {
		const range = toEditorRange(wireEdit.range);
		return {
			range: new Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn),
			text: wireEdit.newText
		};
	});
}

/**
 * Where the cursor goes after a format: the line and column it was on, clamped into the
 * reformatted document.
 *
 * Chosen over the reference's selection tracking because a whole-document edit (what our
 * providers return) gives nothing to track the old position through, and reindentation moves the
 * column anyway — a cursor that stays on its line is far less surprising than one dumped at the
 * top of the file.
 */
export function cursorAfterFormat(position: Position, model: IFormatModel): Position {
	const lineNumber = Math.min(Math.max(position.lineNumber, 1), model.getLineCount());
	return new Position(lineNumber, Math.min(Math.max(position.column, 1), model.getLineMaxColumn(lineNumber)));
}

let nextRequestId = 1;

// shortcut: a second Shift+Alt+F while a fetch is in flight is ignored rather than superseding it,
// because nothing here can produce a newer result for the same document. Upgrade to
// languageFeatures.cancelRequest when formatting can also be triggered automatically (on save).
const formatting = new WeakSet<EditorWidget>();

/**
 * Ask the provider and apply what comes back as ONE undo step.
 *
 * @returns true when an edit was pushed; false for every no-op (no provider, no model, readonly,
 * nothing to change, a provider bug, or the document moved under the fetch).
 */
export async function formatDocument(context: IFormatContext): Promise<boolean> {
	const widget = context.getActiveWidget();
	const model = widget?.getModel();
	if (!widget || !model || widget.isReadonly || formatting.has(widget)) {
		return false;
	}
	const resource = context.getResource(widget);
	if (!resource) {
		return false;
	}
	const provider = context.languageFeatures.getDocumentFormattingEditProviders(
		context.languageFeatures.languageIdForResource(resource)
	)[0];
	if (!provider) {
		return false; // no formatter for this file: silently do nothing
	}

	const versionBefore = model.getVersionId();
	const selectionBefore = widget.getSelection();
	formatting.add(widget);
	let wireEdits: readonly IWireTextEdit[] | null;
	try {
		wireEdits = await provider.provideDocumentFormattingEdits(resource, context.getFormattingOptions(), nextRequestId++);
	} finally {
		formatting.delete(widget);
	}
	// null is both "nothing to do" and "the provider failed" — neither is an error here
	if (!wireEdits || wireEdits.length === 0) {
		return false;
	}
	// the user kept typing while the formatter ran: its edits describe text that no longer exists
	if (model.getVersionId() !== versionBefore || widget.isReadonly) {
		return false;
	}

	const prepared = prepareFormattingEdits(model, toFormattingEdits(wireEdits));
	if (!prepared.hasChanges) {
		return false; // a document the formatter considers correct must not become dirty
	}

	// bracketed so the whole format is one undo step, whatever the edit stack would have merged
	model.pushStackElement();
	model.pushEditOperations(
		{ position: selectionBefore.getPosition(), selectionStart: selectionBefore.anchor },
		prepared.edits.map(edit => ({ range: edit.range as Range, text: edit.text })),
		null
	);
	model.pushStackElement();

	const after = cursorAfterFormat(selectionBefore.getPosition(), model);
	widget.setSelection(new Selection(after.lineNumber, after.column, after.lineNumber, after.column));
	widget.revealPosition(after);
	return true;
}

export function registerFormatCommands(context: IFormatContext): IDisposable {
	const disposables: IDisposable[] = [];
	const id = FORMAT_IDS.FormatDocument;

	disposables.push(CommandsRegistry.registerCommand(id, () => { void formatDocument(context); }));
	disposables.push(CommandMetadata.register({ id, title: 'Format Document', category: 'Editing' }));
	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id,
		weight: KeybindingWeight.EditorContrib,
		when: new RawContextKey<boolean>('editorTextFocus', false) as never,
		primary: KeyMod.Shift | KeyMod.Alt | KeyCode.KeyF,
		// the reference's linux override: Shift+Alt+F is taken by the window manager there
		linux: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI
	}));

	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
