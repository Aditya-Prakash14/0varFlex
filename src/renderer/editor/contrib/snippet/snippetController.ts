// src/renderer/editor/contrib/snippet/snippetController.ts — snippet insertion with tab stops,
// ported in shape from vs/editor/contrib/snippet/browser/snippetController2.ts (the session, the
// context keys and the four commands; the parsing lives in snippetParser.ts).
//
// There is no widget and no DOM here: a snippet session is a selection plus a set of live spans,
// so this contrib is state only. The session is tracked as MODEL OFFSETS rather than ranges
// because every content change already reports `rangeOffset`/`rangeLength` in old-text offsets —
// shifting offsets is arithmetic, while shifting ranges would need the decoration tree the
// reference has and we do not.
//
// delta: no choices (${1|a,b|}), no variables, no nested snippets, no snippet-aware indentation
// or whitespace adjustment of the inserted lines.
//
// shortcut: a tab stop that appears more than once (`<$1>…</$1>`) selects its FIRST occurrence
// and typing does not mirror into the others — the reference keeps a decoration per occurrence and
// rewrites them on every keystroke. The later occurrences do stay in sync positionally, so the
// following tab stops are still correct. Upgrade when snippets with mirrored stops are offered by
// completion, which is where users notice it.

import { Emitter, Event } from '../../../../common/base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../common/base/common/lifecycle.js';
import type { IModelContentChange } from '../../../../common/editor/common/core/textChange.js';
import {
	hasTabStops, ISnippetParseResult, nextTabStop, parseSnippet, previousTabStop
} from '../../../../common/editor/common/model/snippetParser.js';
import { CommandMetadata, CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { ContextKeyExpr, ContextKeyExpression, RawContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { KeyCode, KeyMod } from '../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { Selection } from '../../browser/core/selection.js';
import type { EditorWidget } from '../../browser/editorWidget.js';

// ---- the pure session logic (tested in tests/snippetSession.test.ts)

/** one occurrence of a tab stop, as an offset into the MODEL */
export interface ISnippetSpan {
	readonly offset: number;
	readonly length: number;
}

export interface ISnippetSessionState {
	/** per tab stop in walking order (1, 2, … then $0), each with its occurrences */
	readonly stops: readonly (readonly ISnippetSpan[])[];
	readonly ordinal: number;
}

/**
 * The session for a snippet whose text was just inserted at `baseOffset`.
 *
 * `eolLength` is the model's EOL length: the parse result counts a line break as one character,
 * so on a CRLF model every break before an offset pushes it along by one more.
 */
export function snippetSessionAt(result: ISnippetParseResult, baseOffset: number, eolLength: number = 1): ISnippetSessionState {
	const extra = eolLength - 1;
	const breaks: number[] = [];
	let count = 0;
	for (let i = 0; i < result.text.length; i++) {
		breaks.push(count);
		if (result.text.charCodeAt(i) === 10 /* \n */) {
			count++;
		}
	}
	breaks.push(count);
	const modelOffset = (offset: number) => baseOffset + offset + breaks[offset] * extra;

	return {
		stops: result.tabStops.map(stop => stop.occurrences.map(({ offset, length }) => ({
			offset: modelOffset(offset),
			length: modelOffset(offset + length) - modelOffset(offset)
		}))),
		ordinal: 0
	};
}

/** the stop the cursor sits on ends the walk: reaching it is what finishes a snippet */
export function isAtLastStop(state: ISnippetSessionState): boolean {
	return state.ordinal >= state.stops.length - 1;
}

/** the span the user is allowed to edit: the first occurrence of the current stop */
function editableSpan(state: ISnippetSessionState): ISnippetSpan {
	return state.stops[state.ordinal][0];
}

/**
 * The session after one content change, or null when the session must end.
 *
 * It ends unless the change lies wholly inside the current tab stop — that one rule covers "the
 * user edited outside the snippet", "the user edited a different stop", and an undo that takes
 * the inserted text away again, all of which leave the remaining stops meaningless.
 */
export function sessionAfterChange(state: ISnippetSessionState, change: IModelContentChange): ISnippetSessionState | null {
	const editable = editableSpan(state);
	const changeEnd = change.rangeOffset + change.rangeLength;
	if (change.rangeOffset < editable.offset || changeEnd > editable.offset + editable.length) {
		return null;
	}

	const delta = change.text.length - change.rangeLength;
	const stops: ISnippetSpan[][] = [];
	for (let group = 0; group < state.stops.length; group++) {
		const spans: ISnippetSpan[] = [];
		for (let i = 0; i < state.stops[group].length; i++) {
			const span = state.stops[group][i];
			if (group === state.ordinal && i === 0) {
				spans.push({ offset: span.offset, length: span.length + delta });
			} else if (span.offset >= changeEnd) {
				spans.push({ offset: span.offset + delta, length: span.length });
			} else if (span.offset + span.length <= change.rangeOffset) {
				spans.push(span);
			} else {
				return null; // the edit cuts across another stop, so its length is anyone's guess
			}
		}
		stops.push(spans);
	}
	return { stops, ordinal: state.ordinal };
}

// ---- the controller

/** what the context keys need; the pane binds them, as it does for the find widget */
export interface ISnippetContextState {
	readonly inSnippetMode: boolean;
	readonly hasNextTabstop: boolean;
	readonly hasPrevTabstop: boolean;
}

export class SnippetController extends Disposable {

	private _result: ISnippetParseResult | null = null;
	private _state: ISnippetSessionState | null = null;

	private readonly _onDidChangeState = this._register(new Emitter<ISnippetContextState>());
	readonly onDidChangeState: Event<ISnippetContextState> = this._onDidChangeState.event;

	constructor(private readonly _editor: EditorWidget) {
		super();
		const model = _editor.getModel();
		if (model) {
			this._register(model.onDidChangeContent(event => {
				const state = this._state;
				if (!state) {
					return;
				}
				// a multi-change event is a multi-cursor edit, which no single tab stop can own
				const next = event.changes.length === 1 ? sessionAfterChange(state, event.changes[0]) : null;
				if (next) {
					this._state = next;
				} else {
					this.cancel();
				}
			}));
		}
	}

	get isInSnippet(): boolean { return this._state !== null; }
	/** 0-based position in the walk, for tests and for the dev hook */
	get currentStop(): number { return this._state ? this._state.ordinal : -1; }

	/**
	 * Insert `template` over the current selection as ONE edit and select the first tab stop.
	 * Returns false when there is nothing to insert into (no model, or readonly).
	 *
	 * A snippet with a single tab stop leaves no session behind: the cursor is already at the only
	 * place it would go, which is what the reference's `_updateState` does on the last placeholder.
	 */
	insert(template: string): boolean {
		const model = this._editor.getModel();
		if (!model || this._editor.isReadonly) {
			return false;
		}
		this.cancel();

		// the parser counts a line break as one character, so normalise before measuring; the
		// model turns the \n back into its own EOL, which snippetSessionAt accounts for
		const result = parseSnippet(template.replace(/\r\n?/g, '\n'));
		const selection = this._editor.getSelection();
		const baseOffset = model.getOffsetAt(selection.getStartPosition());
		// through the widget, so the readonly gate and the edit stack stay honoured
		this._editor.replaceRange(selection, result.text);

		if (!hasTabStops(result)) {
			return true;
		}

		const state = snippetSessionAt(result, baseOffset, model.getEOL().length);
		this._selectStop(state);
		this._result = result;
		this._state = isAtLastStop(state) ? null : state;
		this._fireState();
		return true;
	}

	/** Tab: the next stop, with $0 last; leaving the last stop ends the session */
	next(): void {
		const state = this._state;
		if (!state || !this._result) {
			return;
		}
		const ordinal = nextTabStop(this._result, state.ordinal);
		if (ordinal === undefined) {
			this.cancel();
			return;
		}
		const moved = { stops: state.stops, ordinal };
		this._selectStop(moved);
		this._state = isAtLastStop(moved) ? null : moved;
		this._fireState();
	}

	/** Shift+Tab: the previous stop; at the first one the cursor stays where it is */
	prev(): void {
		const state = this._state;
		if (!state || !this._result) {
			return;
		}
		const ordinal = previousTabStop(this._result, state.ordinal);
		if (ordinal === undefined) {
			return;
		}
		this._state = { stops: state.stops, ordinal };
		this._selectStop(this._state);
		this._fireState();
	}

	/** acceptSnippet: jump to the final stop and end the session */
	finish(): void {
		const state = this._state;
		if (!state) {
			return;
		}
		this._selectStop({ stops: state.stops, ordinal: state.stops.length - 1 });
		this.cancel();
	}

	/** leaveSnippet: end the session and leave the cursor alone */
	cancel(): void {
		if (!this._state && !this._result) {
			return;
		}
		this._result = null;
		this._state = null;
		this._fireState();
	}

	private _selectStop(state: ISnippetSessionState): void {
		const model = this._editor.getModel();
		if (!model) {
			return;
		}
		const span = editableSpan(state);
		const from = model.getPositionAt(span.offset);
		const to = model.getPositionAt(span.offset + span.length);
		this._editor.setSelection(new Selection(from.lineNumber, from.column, to.lineNumber, to.column));
		this._editor.revealPosition(from);
	}

	private _fireState(): void {
		const state = this._state;
		this._onDidChangeState.fire({
			inSnippetMode: state !== null,
			hasNextTabstop: state !== null && state.ordinal + 1 < state.stops.length,
			hasPrevTabstop: state !== null && state.ordinal > 0
		});
	}
}

// ---- the per-widget lookup, the same shape find and folding use

const snippetControllers = new WeakMap<EditorWidget, SnippetController>();

export function registerSnippetController(widget: EditorWidget, controller: SnippetController): void {
	snippetControllers.set(widget, controller);
}

export function snippetControllerFor(widget: EditorWidget | null): SnippetController | null {
	return widget ? snippetControllers.get(widget) ?? null : null;
}

/**
 * THE entry point: insert a snippet into a widget. This is what the suggest contrib and the dev
 * hook call. A widget with no controller is a clean no-op, not an error.
 */
export function insertSnippet(widget: EditorWidget | null, template: string): boolean {
	return snippetControllerFor(widget)?.insert(template) ?? false;
}

// ---- commands & keybindings, with the real ids from the reference's snippetController2.ts

export const SNIPPET_IDS = {
	JumpToNextPlaceholder: 'jumpToNextSnippetPlaceholder',
	JumpToPrevPlaceholder: 'jumpToPrevSnippetPlaceholder',
	LeaveSnippet: 'leaveSnippet',
	AcceptSnippet: 'acceptSnippet'
} as const;

/** the reference's SnippetController2.InSnippetMode / HasNextTabstop / HasPrevTabstop */
export const InSnippetModeContext = new RawContextKey<boolean>('inSnippetMode', false);
export const HasNextTabstopContext = new RawContextKey<boolean>('hasNextTabstop', false);
export const HasPrevTabstopContext = new RawContextKey<boolean>('hasPrevTabstop', false);

export function registerSnippetCommands(getActiveController: () => SnippetController | null): IDisposable {
	const disposables: IDisposable[] = [];
	const editorTextFocus = new RawContextKey<boolean>('editorTextFocus', false);

	const register = (
		id: string,
		title: string,
		run: (controller: SnippetController) => void,
		binding?: { primary?: number; secondary?: number; when?: ContextKeyExpression }
	): void => {
		disposables.push(CommandsRegistry.registerCommand(id, () => {
			const controller = getActiveController();
			if (controller) {
				run(controller);
			}
		}));
		disposables.push(CommandMetadata.register({ id, title, category: 'Snippets' }));
		if (binding) {
			disposables.push(KeybindingsRegistry.registerKeybindingRule({
				id,
				// the reference's EditorContrib + 30: Tab is already taken by the `tab` command at
				// EditorCore (0), and this must beat it — but only while inSnippetMode is set, which
				// the `when` clause enforces. The +30 is kept rather than rounded so that a future
				// contrib ported at its own reference weight lands in the same order it does upstream.
				weight: KeybindingWeight.EditorContrib + 30,
				when: binding.when,
				primary: binding.primary,
				secondary: binding.secondary
			}));
		}
	};

	register(SNIPPET_IDS.JumpToNextPlaceholder, 'Go to Next Placeholder', controller => controller.next(), {
		primary: KeyCode.Tab,
		when: ContextKeyExpr.and(InSnippetModeContext, HasNextTabstopContext, editorTextFocus)
	});

	register(SNIPPET_IDS.JumpToPrevPlaceholder, 'Go to Previous Placeholder', controller => controller.prev(), {
		primary: KeyMod.Shift | KeyCode.Tab,
		when: ContextKeyExpr.and(InSnippetModeContext, HasPrevTabstopContext, editorTextFocus)
	});

	register(SNIPPET_IDS.LeaveSnippet, 'Leave Snippet', controller => controller.cancel(), {
		primary: KeyCode.Escape,
		secondary: KeyMod.Shift | KeyCode.Escape,
		when: ContextKeyExpr.and(InSnippetModeContext, editorTextFocus)
	});

	// the reference leaves this one unbound too (its Enter binding is commented out)
	register(SNIPPET_IDS.AcceptSnippet, 'Accept Snippet', controller => controller.finish());

	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
