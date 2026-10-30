// src/renderer/workbench/common/editor/editorPane.ts — ported in shape from
// vs/workbench/common/editor/editorPane.ts: an EditorPane is the per-GROUP view of an input.
// One input resolved by two groups produces two panes around the same model — that is where
// independent scroll/cursor state lives.
//
// delta: our panes are single-input (created by `resolve()` and cached per group); the real
// EditorPane's setInput/clearInput support reconfiguring one pane across inputs, which the pane
// cache makes unnecessary here.

import { Disposable } from '../../../../common/base/common/lifecycle.js';

export interface IEditorViewState {
	readonly scrollTop: number;
	readonly selection: {
		readonly anchorLineNumber: number;
		readonly anchorColumn: number;
		readonly activeLineNumber: number;
		readonly activeColumn: number;
	};
}

export abstract class EditorPane extends Disposable {

	abstract getId(): string;

	/** the pane's DOM (unattached; the group containers appends it) */
	abstract get element(): HTMLElement;

	/** size the pane to the group's content area */
	abstract layout(width: number, height: number): void;

	/** hidden on tab switch, shown on activation — must preserve view state */
	abstract setVisible(visible: boolean): void;

	abstract focus(): void;

	abstract saveViewState(): IEditorViewState | null;
	abstract restoreViewState(state: IEditorViewState | null): void;
}
