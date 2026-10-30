// src/renderer/workbench/browser/parts/editor/editorPanes.ts — pane lifecycle for ONE group,
// ported in shape from vs/workbench/browser/parts/editor/editorPanes.ts:
//
//   - the pane CACHE per group: an inactive tab keeps its pane (and therefore its widget,
//     scroll position and cursor) — switching tabs only toggles visibility;
//   - a pane is disposed only when its input closes, and it releases the model refcount then;
//   - layout only touches the active pane (hidden panes size on reactivation).

import { Disposable } from '../../../../../common/base/common/lifecycle.js';
import { Position } from '../../../../../common/editor/common/core/position.js';
import { TextModel } from '../../../../../common/editor/common/model/textModel.js';
import { append, $ } from '../../../../base/browser/dom.js';
import { Selection } from '../../../../editor/browser/core/selection.js';
import { EditorWidget, IEditorWidgetServices } from '../../../../editor/browser/editorWidget.js';
import { EditorPane, IEditorViewState } from '../../../common/editor/editorPane.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { TextEditorInput } from '../../../common/editor/textEditorInput.js';
import { CodeEditorService } from '../../../services/editor/browser/codeEditorService.js';

export interface IPaneServices extends IEditorWidgetServices {
	readonly codeEditorService: CodeEditorService;
}

/** the text editor pane: one EditorWidget (08) around the shared model */
export class TextEditorPane extends EditorPane {

	readonly element: HTMLElement;

	private readonly _widget: EditorWidget;
	private _visible = false;
	private _viewState: IEditorViewState | null = null;
	private _width = 0;
	private _height = 0;

	constructor(readonly input: TextEditorInput, private readonly _services: IPaneServices, model: TextModel) {
		super();
		this.element = $('.editor-pane');
		this._widget = this._register(new EditorWidget(this.element, _services));
		this._widget.setModel(model);
		// showing the model keeps it alive; closing the pane releases it (refcount in the registry)
		this._services.codeEditorService.acquire(input.resource);
	}

	override getId(): string {
		return this.input.getTypeId();
	}

	getWidget(): EditorWidget {
		return this._widget;
	}

	getInput(): TextEditorInput {
		return this.input;
	}

	override layout(width: number, height: number): void {
		this._width = width;
		this._height = height;
		this.element.style.width = `${width}px`;
		this.element.style.height = `${height}px`;
		this._widget.layout();
	}

	/** the pane's DOM element disappears on hide: save state first, restore after re-showing */
	override setVisible(visible: boolean): void {
		if (this._visible === visible) {
			return;
		}
		if (!visible) {
			this._viewState = this.saveViewState();
		}
		this._visible = visible;
		this.element.style.display = visible ? '' : 'none';
		if (visible) {
			this.layout(this._width, this._height);
			this.restoreViewState(this._viewState);
		}
	}

	isVisible(): boolean {
		return this._visible;
	}

	override focus(): void {
		this._widget.focus();
	}

	override saveViewState(): IEditorViewState | null {
		const selection = this._widget.getSelection();
		return {
			scrollTop: this._widget.view.getScrollTop(),
			selection: {
				anchorLineNumber: selection.anchorLineNumber,
				anchorColumn: selection.anchorColumn,
				activeLineNumber: selection.activeLineNumber,
				activeColumn: selection.activeColumn
			}
		};
	}

	override restoreViewState(state: IEditorViewState | null): void {
		if (!state) {
			return;
		}
		// selection first (it may reveal/scroll), then the remembered scroll top wins
		this._widget.setSelection(new Selection(
			state.selection.anchorLineNumber,
			state.selection.anchorColumn,
			state.selection.activeLineNumber,
			state.selection.activeColumn
		));
		this._widget.view.setScrollTop(state.scrollTop);
		// the pane may still be settling (display toggle, scrollbars, resize observer): re-apply
		// once the next render pass has recomputed the content height, or the value clamps early
		const target = state.scrollTop;
		const listener = this._widget.onDidRender(() => {
			listener.dispose();
			this._widget.view.setScrollTop(target);
		});
	}

	/** applied when the editor service opens with a selection */
	applySelection(selection: { lineNumber: number; column: number }): void {
		this._widget.setSelection(new Selection(selection.lineNumber, selection.column, selection.lineNumber, selection.column));
		this._widget.revealPosition(new Position(selection.lineNumber, selection.column), 'center');
	}

	override dispose(): void {
		this._services.codeEditorService.release(this.input.resource);
		// closing the tab must take the pane's DOM with it (the widget leaves it behind otherwise)
		this.element.remove();
		super.dispose();
	}
}

export class EditorPanes extends Disposable {

	private readonly _cache = new Map<EditorInput, EditorPane>();
	private readonly _container: HTMLElement;
	private _active: EditorPane | null = null;

	constructor(container: HTMLElement) {
		super();
		this._container = container;
	}

	get activePane(): EditorPane | null {
		return this._active;
	}

	getPane(input: EditorInput): EditorPane | undefined {
		return this._cache.get(input);
	}

	/** open: reuse the cached pane, otherwise resolve a fresh one and append it (hidden) */
	async setInput(input: EditorInput): Promise<EditorPane> {
		let pane = this._cache.get(input);
		if (!pane) {
			pane = await input.resolve();
			this._cache.set(input, pane);
			append(this._container, pane.element);
			pane.setVisible(false);
		}
		if (this._active && this._active !== pane) {
			this._active.setVisible(false);
		}
		this._active = pane;
		pane.setVisible(true);
		return pane;
	}

	/** switch back to an already-resolved pane (tab activation); null if never resolved */
	activate(input: EditorInput): EditorPane | null {
		const pane = this._cache.get(input);
		if (!pane) {
			return null;
		}
		if (this._active === pane) {
			return pane;
		}
		if (this._active) {
			this._active.setVisible(false);
		}
		this._active = pane;
		pane.setVisible(true);
		return pane;
	}

	/** closing an input disposes its pane (the pane releases the model refcount) */
	closeInput(input: EditorInput): void {
		const pane = this._cache.get(input);
		if (!pane) {
			return;
		}
		this._cache.delete(input);
		if (this._active === pane) {
			this._active = null;
		}
		pane.dispose();
	}

	clearActive(): void {
		this._active?.setVisible(false);
		this._active = null;
	}

	layout(width: number, height: number): void {
		this._active?.layout(width, height);
	}

	override dispose(): void {
		for (const pane of this._cache.values()) {
			pane.dispose();
		}
		this._cache.clear();
		this._active = null;
		super.dispose();
	}
}
