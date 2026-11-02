// src/renderer/editor/browser/editorWidget.ts — the editor widget: model + view + controller
// glued together, plus the editing operations and the command/keybinding registration. This is
// the object 09's editor service will open (the "editor widget").
//
// Ported in shape from vs/editor/browser/widget/codeEditor/codeEditorWidget.ts: the widget
// owns the text focus context key, forms the cursor state stored in undo elements
// (cursorStateComputer — the consumer 07 was waiting for) and routes all edits through
// model.pushEditOperations.

import { Emitter, Event } from '../../../common/base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../common/base/common/lifecycle.js';
import { Position } from '../../../common/editor/common/core/position.js';
import { Range } from '../../../common/editor/common/core/range.js';
import { ILanguageConfiguration, languageConfigurationFor } from '../../../common/editor/common/languages/languageConfiguration.js';
import { autoClosingTypeResult } from '../../../common/editor/common/model/bracketMatching.js';
import { TextModel } from '../../../common/editor/common/model/textModel.js';
import { IConfigurationService } from '../../../common/platform/configuration/common/configuration.js';
import { append, $ } from '../../base/browser/dom.js';
import { CommandsRegistry, CommandMetadata } from '../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../platform/contextkey/common/contextkey.js';
import { KeyCode, KeyMod } from '../../platform/keybinding/common/keyCodes.js';
import { IKeybindingRule, KeybindingsRegistry, KeybindingWeight } from '../../platform/keybinding/common/keybindingsRegistry.js';
import { EditorOptionsService, IEditorOptions } from './config.js';
import { CursorController, MoveType } from './controller/cursorController.js';
import { EditContext } from './controller/editContext.js';
import { MouseHandler } from './controller/mouseHandler.js';
import { nextCharLength, prevCharLength } from './core/wordHelper.js';
import { Selection } from './core/selection.js';
import { CurrentLineHighlightLayer } from './layers/currentLineHighlight.js';
import { LineNumbersLayer } from './layers/lineNumbers.js';
import { SelectionsLayer } from './layers/selections.js';
import { ViewLinesLayer } from './layers/viewLines.js';
import { ViewCursorsLayer } from './layers/viewCursors.js';
import { IRenderContext, IRenderInfo, View } from './view.js';
import { ViewModel } from './viewModel.js';

/** the cursor state stored in undo elements; 07 kept this opaque, 08 finally reads it back */
interface IEditorCursorState {
	readonly position: { lineNumber: number; column: number };
	/** the anchor (where the selection was started) */
	readonly selectionStart: { lineNumber: number; column: number };
}

export interface IEditorWidgetServices {
	readonly options: EditorOptionsService;
	readonly configuration: IConfigurationService;
	readonly contextKeyService: IContextKeyService;
	/** 12: the provider SPI (completions/hover) the contribs consult */
	readonly languageFeatures: import('../../workbench/api/common/mainThreadLanguageFeatures.js').ILanguageFeaturesService;
	/** 12: markers for decorations + marker tooltips */
	readonly markers: import('../../workbench/services/markers/browser/markerService.js').MarkerService;
}

export const BLINK_INTERVAL = 500;

export interface IEditorPerfStats {
	lastRenderMs: number;
	averageRenderMs: number;
	renderCount: number;
	lastRenderedLines: number;
	totalLines: number;
}

export class EditorWidget extends Disposable {

	readonly view: View;
	readonly textFocus: RawContextKey<boolean> = new RawContextKey<boolean>('editorTextFocus', false);

	private readonly _configuration: IConfigurationService;
	private readonly _optionsService: EditorOptionsService;
	private readonly _textFocusKey: IContextKey<boolean>;
	private readonly _viewModel: ViewModel;
	private readonly _viewLines: ViewLinesLayer;
	private readonly _lineNumbers: LineNumbersLayer;
	private readonly _selections: SelectionsLayer;
	private readonly _cursors: ViewCursorsLayer;
	private readonly _currentLine: CurrentLineHighlightLayer;
	private readonly _editContext: EditContext;
	private readonly _mouseHandler: MouseHandler;
	private readonly _cursorController: CursorController;
	private readonly _compositionElement: HTMLElement;

	private _model: TextModel | null = null;
	private _modelListener: IDisposable | null = null;
	private _editorOptions: IEditorOptions;
	private _charWidth = 7;
	private _lineHeight = 19;
	private _measuredFont = '';
	private _charMeasureCanvas: HTMLCanvasElement | null = null;

	private _blinkOn = true;
	private _blinkTimer: number | null = null;
	private _windowFocused = true;

	private readonly _renderSamples: number[] = [];
	private _lastPaintMs = 0;
	private _renderCount = 0;
	private _lastRenderedLines = 0;
	/**
	 * A2: readonly mode. `EditorInputCapabilities.Readonly` existed but nothing enforced it, so
	 * a readonly input could still be typed into. Because every mutation funnels through
	 * `_pushEdit` (07's contract), one guard there plus undo/redo covers typing, paste, Tab and
	 * composition commits — the payoff of having a single edit path.
	 */
	private _readonly = false;

	/** B1: what typing a bracket or quote does; replaced by the pane once it knows the file type */
	private _languageConfiguration: ILanguageConfiguration = languageConfigurationFor('');

	private readonly _onDidRender = this._register(new Emitter<IRenderInfo>());
	readonly onDidRender: Event<IRenderInfo> = this._onDidRender.event;

	/** 12: the editing operations the contribs react to (real: onDidType / typing notifications) */
	private readonly _onDidEdit = this._register(new Emitter<{ kind: 'type' | 'delete'; text: string }>());
	readonly onDidEdit: Event<{ kind: 'type' | 'delete'; text: string }> = this._onDidEdit.event;

	constructor(container: HTMLElement, services: IEditorWidgetServices) {
		super();
		this._optionsService = services.options;
		this._configuration = services.configuration;
		this._textFocusKey = this.textFocus.bindTo(services.contextKeyService);
		this._editorOptions = services.options.getOptions();

		this.view = this._register(new View(container));
		this._viewModel = new ViewModel({ lineHeight: this._lineHeight, charWidth: this._charWidth, tabSize: this._editorOptions.tabSize, lineCount: 1 });

		this._viewLines = new ViewLinesLayer(this._viewModel, width => this.view.reportContentWidth(width));
		this._lineNumbers = new LineNumbersLayer(width => this.view.setMarginWidth(width));
		this._selections = new SelectionsLayer();
		this._cursors = new ViewCursorsLayer();
		this._currentLine = new CurrentLineHighlightLayer();

		this.view.addContentLayer(this._viewLines);
		this.view.addContentLayer(this._currentLine);
		this.view.addContentLayer(this._selections);
		this.view.addContentLayer(this._cursors);
		this.view.addMarginLayer(this._lineNumbers);

		this._compositionElement = append(this.view.contentElement, $('.editor-composition-text'));
		this._editContext = this._register(new EditContext(this.view.contentElement, this._createEditContextHost()));
		this._mouseHandler = this._register(new MouseHandler(this.view, {
			getModel: () => this._model,
			getViewModel: () => this._viewModel,
			getLinesLayer: () => this._viewLines,
			setSelectionByMouse: (anchor, active) => this._cursorController.setSelectionByMouse(anchor, active),
			focus: () => this.focus()
		}));
		this._cursorController = this._register(new CursorController(
			this._viewModel,
			{
				getPageSize: () => Math.max(1, Math.floor(this.view.scrollableElement.clientHeight / this._lineHeight) - 2),
				onDidChangeCursor: () => this._onDidChangeCursor()
			}
		));

		this.view.setContextProvider(() => this._model ? this._createRenderContext() : null);
		this._register(this.view.onDidRender(info => this._onRender(info)));

		// focus tracking: window-level focus hides the cursor; textarea focus sets the context key
		this._register(addWindowListener('blur', () => {
			this._windowFocused = false;
			this._textFocusKey.set(false);
			this._scheduleRender();
		}));
		this._register(addWindowListener('focus', () => {
			this._windowFocused = true;
			// the key follows both element focus and window focus (real textInputFocus)
			this._textFocusKey.set(this._editContext.hasFocus);
			this._resetBlink();
		}));

		this._register(this._optionsService.onDidChangeOptions(() => this._applyOptions()));
		this._applyOptions();
	}

	//#region model & rendering

	setModel(model: TextModel): void {
		this._model = model;
		this._modelListener?.dispose();
		this._modelListener = model.onDidChangeContent(() => {
			this._viewModel.update({ lineCount: model.getLineCount() });
			this._scheduleRender();
		});
		this._viewLines.setModel(model);
		this._cursorController.setModel(model);
		this._viewModel.update({ lineCount: model.getLineCount() });
		this._scheduleRender();
	}

	getModel(): TextModel | null {
		return this._model;
	}

	getSelection(): Selection {
		return this._cursorController.getSelection();
	}

	setSelection(selection: Selection): void {
		this._cursorController.setSelection(selection);
	}

	moveCursor(moveType: MoveType, isSelecting: boolean): void {
		if (!this._model) {
			return;
		}
		this._cursorController.moveCursor(moveType, isSelecting);
	}

	getPerfStats(): IEditorPerfStats {
		const average = this._renderSamples.length === 0
			? 0
			: this._renderSamples.reduce((a, b) => a + b, 0) / this._renderSamples.length;
		return {
			lastRenderMs: this._lastPaintMs,
			averageRenderMs: average,
			renderCount: this._renderCount,
			lastRenderedLines: this._lastRenderedLines,
			totalLines: this._viewModel.getLineCount()
		};
	}

	//#endregion

	//#region editing

	/** the text path shared by the textarea, paste and composition commits */
	type(text: string, isCompositionCommit: boolean = false): void {
		const model = this._model;
		if (!model) {
			return;
		}
		if (isCompositionCommit) {
			// one composition commit === one undo unit; the EOL rule would split anyway
			model.pushStackElement();
		}
		const selection = this._cursorController.getSelection();

		// B1: auto-closing pairs and the Enter rule. This lives in the type handler rather than in
		// a contrib because that is where the reference puts it (cursorTypeOperations.ts) — it has
		// to decide what gets inserted, which is too late to do from an edit event. Skipped for a
		// non-empty selection (typing replaces it) and for composition commits.
		const auto = !isCompositionCommit && selection.isEmpty()
			? autoClosingTypeResult(text, {
				source: model,
				position: selection.getPosition(),
				configuration: this._languageConfiguration,
				indent: {
					tabSize: this._editorOptions.tabSize,
					insertSpaces: this._configuration.getValue<boolean>('editor.insertSpaces') ?? false
				}
			})
			: null;

		if (auto?.overtype) {
			// the closer is already there: step over it rather than inserting a second one. No edit
			// at all, so this cannot land on the undo stack as an empty step.
			const position = selection.getPosition();
			const column = position.column + 1;
			this.setSelection(new Selection(position.lineNumber, column, position.lineNumber, column));
		} else if (auto) {
			this._pushEdit(selection, auto.text, auto.cursorOffset);
		} else {
			this._pushEdit(selection, text);
		}

		if (isCompositionCommit) {
			model.pushStackElement();
		}
		this._onDidEdit.fire({ kind: 'type', text });
	}

	/**
	 * The language configuration the type handler and the bracket contrib read.
	 *
	 * The pane sets this from its input's resource; a widget nobody told keeps the C-like default,
	 * whose brackets and quotes are right for most files.
	 */
	setLanguageConfiguration(configuration: ILanguageConfiguration): void {
		this._languageConfiguration = configuration;
	}

	getLanguageConfiguration(): ILanguageConfiguration {
		return this._languageConfiguration;
	}

	/** 12: a completion accept replaces the provider's range and leaves the cursor after it */
	replaceRange(range: Range, text: string): void {
		this._pushEdit(range, text);
	}

	isComposing(): boolean {
		return this._editContext.isComposing;
	}

	getViewModel(): ViewModel {
		return this._viewModel;
	}

	/** mouse → text position (the hover dwell needs the same mapping the mouse handler uses) */
	getPositionAt(clientX: number, clientY: number): Position | null {
		const model = this._model;
		if (!model) {
			return null;
		}
		const range = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(clientX, clientY);
		if (range) {
			const found = this._viewLines.columnAtDomRange(range.startContainer, range.startOffset, this._viewModel);
			if (found) {
				return new Position(found.lineNumber, Math.min(found.column, model.getLineMaxColumn(found.lineNumber)));
			}
		}
		const rect = this.view.scrollableElement.getBoundingClientRect();
		const x = clientX - rect.left + this.view.scrollableElement.scrollLeft;
		const y = clientY - rect.top;
		return this._viewModel.getViewPositionFromCoordinates(this.view.getScrollTop(), x, y, lineNumber => model.getLineContent(lineNumber));
	}

	deleteLeft(): void {
		const model = this._model;
		if (!model) {
			return;
		}
		const selection = this._cursorController.getSelection();
		if (!selection.isEmpty()) {
			this._pushEdit(selection, '');
			this._onDidEdit.fire({ kind: 'delete', text: '' });
			return;
		}
		const position = selection.getPosition();
		if (position.column > 1) {
			const lineText = model.getLineContent(position.lineNumber);
			const start = new Position(position.lineNumber, position.column - prevCharLength(lineText, position.column - 1));
			this._pushEdit(new Range(start.lineNumber, start.column, position.lineNumber, position.column), '');
			this._onDidEdit.fire({ kind: 'delete', text: '' });
			return;
		}
		if (position.lineNumber > 1) {
			const previousLine = position.lineNumber - 1;
			this._pushEdit(new Range(previousLine, model.getLineMaxColumn(previousLine), position.lineNumber, 1), '');
			this._onDidEdit.fire({ kind: 'delete', text: '' });
		}
	}

	deleteRight(): void {
		const model = this._model;
		if (!model) {
			return;
		}
		const selection = this._cursorController.getSelection();
		if (!selection.isEmpty()) {
			this._pushEdit(selection, '');
			return;
		}
		const position = selection.getPosition();
		const lineText = model.getLineContent(position.lineNumber);
		if (position.column < lineText.length + 1) {
			const end = new Position(position.lineNumber, position.column + nextCharLength(lineText, position.column));
			this._pushEdit(new Range(position.lineNumber, position.column, end.lineNumber, end.column), '');
			return;
		}
		if (position.lineNumber < model.getLineCount()) {
			this._pushEdit(new Range(position.lineNumber, lineText.length + 1, position.lineNumber + 1, 1), '');
		}
	}

	deleteSelection(): void {
		const selection = this._cursorController.getSelection();
		if (!selection.isEmpty()) {
			this._pushEdit(selection, '');
			this._onDidEdit.fire({ kind: 'delete', text: '' });
		}
	}

	getSelectedText(): string {
		const model = this._model;
		if (!model) {
			return '';
		}
		return model.getValueInRange(this._cursorController.getSelection());
	}

	setReadonly(readonly: boolean): void {
		this._readonly = readonly;
	}

	get isReadonly(): boolean {
		return this._readonly;
	}

	undo(): void {
		const model = this._model;
		if (!model || this._readonly || !model.canUndo()) {
			return;
		}
		const cursorState = model.undo();
		if (cursorState) {
			this._restoreCursorState(cursorState as IEditorCursorState);
		}
	}

	redo(): void {
		const model = this._model;
		if (!model || this._readonly || !model.canRedo()) {
			return;
		}
		const cursorState = model.redo();
		if (cursorState) {
			this._restoreCursorState(cursorState as IEditorCursorState);
		}
	}

	/**
	 * The one edit path: push an edit operation, let the cursorStateComputer produce the
	 * post-edit cursor state from the inverse operations (07's contract), and adopt it —
	 * undo/redo later restores it verbatim.
	 */
	/**
	 * @param cursorOffset how far into `text` to leave the cursor; defaults to its end. Auto-closing
	 * passes 1, so the cursor lands between the pair instead of after the closer.
	 */
	private _pushEdit(range: Range, text: string, cursorOffset: number = text.length): void {
		const model = this._model;
		if (!model || this._readonly) {
			return; // A2: the one gate every mutation passes through
		}
		const before = this._cursorState();
		const after = model.pushEditOperations(before, [{ range, text }], (inverseOperations) => {
			const start = inverseOperations[0].range.getStartPosition();
			const end = model.getPositionAt(model.getOffsetAt(start) + cursorOffset);
			return { position: toPlainPosition(end), selectionStart: toPlainPosition(end) };
		});
		if (after) {
			this._restoreCursorState(after as IEditorCursorState);
		} else {
			this._rebuildModelState();
		}
	}

	private _cursorState(): IEditorCursorState {
		const selection = this._cursorController.getSelection();
		return {
			position: toPlainPosition(selection.getPosition()),
			selectionStart: toPlainPosition(selection.anchor)
		};
	}

	private _restoreCursorState(state: IEditorCursorState): void {
		this._cursorController.setSelection(new Selection(
			state.selectionStart.lineNumber,
			state.selectionStart.column,
			state.position.lineNumber,
			state.position.column
		));
	}

	private _rebuildModelState(): void {
		const model = this._model;
		if (!model) {
			return;
		}
		this._viewModel.update({ lineCount: model.getLineCount() });
		const position = this._cursorController.getSelection().getPosition();
		this.revealPosition(position);
		this._scheduleRender();
	}

	//#endregion

	//#region focus & reveal

	focus(): void {
		this._editContext.focus();
		// programmatic focus while the window is inert fires no DOM focus event: keep the key honest
		if (this._editContext.hasFocus) {
			this._textFocusKey.set(true);
		}
		this._resetBlink();
	}

	hasTextFocus(): boolean {
		return this._editContext.hasFocus;
	}

	/** keep one line of context around the target (the shape of the real revealRange) */
	revealPosition(position: Position, scrollType: 'auto' | 'center' = 'auto'): void {
		const scrollable = this.view.scrollableElement;
		const viewportHeight = scrollable.clientHeight;
		const lineTop = this._viewModel.getLineTop(position.lineNumber);
		if (scrollType === 'center') {
			this.view.setScrollTop(Math.max(0, lineTop - viewportHeight / 2 + this._lineHeight / 2));
			this._scheduleRender();
			return;
		}
		const scrollTop = this.view.getScrollTop();
		if (lineTop - scrollTop < this._lineHeight) {
			this.view.setScrollTop(Math.max(0, lineTop - this._lineHeight));
			this._scheduleRender();
			return;
		}
		const lineBottom = lineTop + this._lineHeight;
		if (lineBottom - scrollTop > viewportHeight - this._lineHeight) {
			this.view.setScrollTop(lineBottom - viewportHeight + this._lineHeight);
			this._scheduleRender();
		}
	}

	layout(): void {
		this._scheduleRender();
	}

	//#endregion

	//#region composition & focus plumbing

	private _createEditContextHost() {
		return {
			type: (text: string, isCompositionCommit?: boolean) => this.type(text, isCompositionCommit),
			getSelectedText: () => this.getSelectedText(),
			hasSelection: () => !this._cursorController.getSelection().isEmpty(),
			deleteSelection: () => this.deleteSelection(),
			onDidFocusChange: (focused: boolean) => {
				this._textFocusKey.set(focused);
				if (focused) {
					this._resetBlink();
				} else {
					this._scheduleRender();
				}
			},
			positionCompositionText: (text: string | null) => {
				if (text === null) {
					this._compositionElement.style.display = 'none';
					this._compositionElement.textContent = '';
					this._scheduleRender();
					return;
				}
				this._positionCompositionText(text);
			}
		};
	}

	/** mirror composition text at the cursor cell (the textarea itself is invisible) */
	private _positionCompositionText(text: string): void {
		const model = this._model;
		if (!model) {
			return;
		}
		const position = this._cursorController.getSelection().getPosition();
		const lineText = model.getLineContent(position.lineNumber);
		this._compositionElement.style.display = '';
		this._compositionElement.textContent = text;
		this._compositionElement.style.left = `${this._viewModel.getXForColumn(lineText, position.column)}px`;
		this._compositionElement.style.top = `${this._viewModel.getLineTop(position.lineNumber)}px`;
		this._compositionElement.style.lineHeight = `${this._lineHeight}px`;
	}

	//#endregion

	//#region render context & blink

	private _createRenderContext(): IRenderContext {
		const model = this._model;
		const selection = this._cursorController.getSelection();
		// self-healing sync: some focus transitions (inert window at boot) fire no DOM event
		this._textFocusKey.set(this._windowFocused && this._editContext.hasFocus);
		return {
			model: model as TextModel,
			viewModel: this._viewModel,
			options: this._editorOptions,
			selection,
			scrollTop: this.view.getScrollTop(),
			cursorVisible: this._computeCursorVisible(),
			stats: { renderedLines: 0 }
		};
	}

	private _computeCursorVisible(): boolean {
		return this._editContext.hasFocus && this._blinkOn && this._windowFocused;
	}

	private _scheduleRender(): void {
		// layers cannot render without a model; the empty widget paints nothing
		if (this._model) {
			this.view.scheduleRender();
		}
	}

	private _onDidChangeCursor(): void {
		this._resetBlink();
		if (this._model) {
			this.revealPosition(this._cursorController.getSelection().getPosition());
		}
		this._scheduleRender();
	}

	/** typing/moving resets the blink: visible again, interval restarted (real: shows caret for 1s after activity) */
	private _resetBlink(): void {
		this._blinkOn = true;
		this._stopBlinkTimer();
		if (this._editorOptions.cursorBlinking === 'blink') {
			this._blinkTimer = window.setInterval(() => {
				this._blinkOn = !this._blinkOn;
				this._scheduleRender();
			}, BLINK_INTERVAL);
		}
		this._scheduleRender();
	}

	private _stopBlinkTimer(): void {
		if (this._blinkTimer !== null) {
			window.clearInterval(this._blinkTimer);
			this._blinkTimer = null;
		}
	}

	private _onRender(info: IRenderInfo): void {
		this._lastPaintMs = info.durationMs;
		this._renderCount++;
		this._lastRenderedLines = info.renderedLines;
		this._renderSamples.push(info.durationMs);
		if (this._renderSamples.length > 50) {
			this._renderSamples.shift();
		}

		// the textarea follows the caret so OS text services anchor to the right cell
		const model = this._model;
		if (model) {
			const position = this._cursorController.getSelection().getPosition();
			const lineText = model.getLineContent(position.lineNumber);
			this._editContext.setPosition(
				this._viewModel.getXForColumn(lineText, position.column),
				this._viewModel.getLineTop(position.lineNumber),
				this._lineHeight
			);
		}
		this._onDidRender.fire(info);
	}

	//#endregion

	//#region options

	private _applyOptions(): void {
		const options = this._optionsService.getOptions();
		this._editorOptions = options;

		// font size/family changed → re-measure the monospace grid (canvas measureText)
		const fontKey = `${options.fontSize}px ${options.fontFamily}`;
		if (fontKey !== this._measuredFont) {
			this._measuredFont = fontKey;
			this._charWidth = this._measureCharWidth(options);
		}
		// ported approximate: fontInfo computes lineHeight = round(fontSize * ratio); the
		// course pins ceil(fontSize * 1.35)
		const previousLineHeight = this._lineHeight;
		const previousScrollTop = this.view.getScrollTop();
		this._lineHeight = Math.ceil(options.fontSize * 1.35);

		this._viewModel.update({ lineHeight: this._lineHeight, charWidth: this._charWidth, tabSize: options.tabSize });
		this._viewLines.invalidateConfig();
		this.view.setScrollBeyondLastLine(options.scrollBeyondLastLine);

		// a line-height change re-anchors the scroll to the line that was at the top
		if (this._lineHeight !== previousLineHeight && previousLineHeight > 0) {
			const topLineIndex = Math.floor(previousScrollTop / previousLineHeight);
			this.view.setScrollTop(topLineIndex * this._lineHeight);
		}

		const element = this.view.element;
		element.style.fontSize = `${options.fontSize}px`;
		if (options.fontFamily) {
			element.style.fontFamily = options.fontFamily;
		}

		if (options.cursorBlinking === 'blink' && this._blinkTimer === null) {
			this._resetBlink();
		} else if (options.cursorBlinking !== 'blink') {
			this._stopBlinkTimer();
			this._blinkOn = true;
		}

		this._scheduleRender();
	}

	private _measureCharWidth(options: IEditorOptions): number {
		if (!this._charMeasureCanvas) {
			this._charMeasureCanvas = document.createElement('canvas');
		}
		const context = this._charMeasureCanvas.getContext('2d');
		if (!context) {
			return this._charWidth;
		}
		const fontFamily = options.fontFamily || 'Menlo, Monaco, "Courier New", monospace';
		context.font = `${options.fontSize}px ${fontFamily}`;
		const measured = context.measureText('W'.repeat(32)).width / 32;
		return measured > 0 ? measured : this._charWidth;
	}

	//#endregion

	override dispose(): void {
		this._stopBlinkTimer();
		this._viewLines.disposeListeners();
		super.dispose();
	}
}

function toPlainPosition(position: Position): { lineNumber: number; column: number } {
	return { lineNumber: position.lineNumber, column: position.column };
}

function addWindowListener(type: 'blur' | 'focus', handler: () => void): IDisposable {
	window.addEventListener(type, handler);
	return toDisposable(() => window.removeEventListener(type, handler));
}

// ---- commands & keybindings (real IDs, mac defaults)
//
// 09: the widget is no longer a singleton — the commands resolve the ACTIVE editor widget
// through the editor service (real commands do the same via the focused editor group).

interface IEditorCommandBinding {
	readonly primary?: number;
	readonly secondary?: number;
	readonly mac?: number;
}

export function registerEditorCommands(getActiveWidget: () => EditorWidget | null): IDisposable {
	const disposables: IDisposable[] = [];
	const when = new RawContextKey<boolean>('editorTextFocus', false);

	const register = (
		id: string,
		title: string,
		category: string,
		run: () => void,
		binding?: IEditorCommandBinding
	): void => {
		disposables.push(CommandsRegistry.registerCommand(id, () => getActiveWidget() && run()));
		disposables.push(CommandMetadata.register({ id, title, category }));
		if (binding && (binding.primary !== undefined || binding.mac !== undefined)) {
			disposables.push(KeybindingsRegistry.registerKeybindingRule({
				id,
				weight: KeybindingWeight.EditorCore,
				when,
				...binding
			} as IKeybindingRule));
		}
	};

	const cursor = (id: string, title: string, moveType: MoveType, isSelecting: boolean, binding?: IEditorCommandBinding): void => {
		register(id, title, 'Cursor', () => getActiveWidget()!.moveCursor(moveType, isSelecting), binding);
	};

	cursor('cursorLeft', 'Cursor Left', MoveType.Left, false, { primary: KeyCode.LeftArrow });
	cursor('cursorLeftSelect', 'Cursor Left Select', MoveType.Left, true, { primary: KeyMod.Shift | KeyCode.LeftArrow });
	cursor('cursorRight', 'Cursor Right', MoveType.Right, false, { primary: KeyCode.RightArrow });
	cursor('cursorRightSelect', 'Cursor Right Select', MoveType.Right, true, { primary: KeyMod.Shift | KeyCode.RightArrow });
	cursor('cursorUp', 'Cursor Up', MoveType.Up, false, { primary: KeyCode.UpArrow });
	cursor('cursorUpSelect', 'Cursor Up Select', MoveType.Up, true, { primary: KeyMod.Shift | KeyCode.UpArrow });
	cursor('cursorDown', 'Cursor Down', MoveType.Down, false, { primary: KeyCode.DownArrow });
	cursor('cursorDownSelect', 'Cursor Down Select', MoveType.Down, true, { primary: KeyMod.Shift | KeyCode.DownArrow });

	cursor('cursorWordLeft', 'Cursor Word Left', MoveType.WordLeft, false, { primary: KeyMod.Alt | KeyCode.LeftArrow });
	cursor('cursorWordLeftSelect', 'Cursor Word Left Select', MoveType.WordLeft, true, { primary: KeyMod.Alt | KeyMod.Shift | KeyCode.LeftArrow });
	cursor('cursorWordEndRight', 'Cursor Word End Right', MoveType.WordRightEnd, false, { primary: KeyMod.Alt | KeyCode.RightArrow });
	cursor('cursorWordEndRightSelect', 'Cursor Word End Right Select', MoveType.WordRightEnd, true, { primary: KeyMod.Alt | KeyMod.Shift | KeyCode.RightArrow });

	// Home: toggle first-non-whitespace ↔ column 1 (mac: Home, secondary cmd+left)
	cursor('cursorHome', 'Go to Beginning of Line', MoveType.LineStart, false, { primary: KeyCode.Home, secondary: KeyMod.CtrlCmd | KeyCode.LeftArrow });
	cursor('cursorHomeSelect', 'Select to Beginning of Line', MoveType.LineStart, true, { primary: KeyMod.Shift | KeyCode.Home, secondary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.LeftArrow });
	cursor('cursorEnd', 'Go to End of Line', MoveType.LineEnd, false, { primary: KeyCode.End, secondary: KeyMod.CtrlCmd | KeyCode.RightArrow });
	cursor('cursorEndSelect', 'Select to End of Line', MoveType.LineEnd, true, { primary: KeyMod.Shift | KeyCode.End, secondary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.RightArrow });
	// explicit column 1 (emacs-style ctrl+A on mac, like real cursorLineStart)
	cursor('cursorLineStart', 'Go to Line Start', MoveType.LineStartHard, false, { mac: KeyMod.WinCtrl | KeyCode.KeyA });
	cursor('cursorLineStartSelect', 'Select to Line Start', MoveType.LineStartHard, true, { mac: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.KeyA });
	// first-non-whitespace / line-end, implemented as their own move types (no default keys)
	cursor('cursorWLineStart', 'Go to First Non-Whitespace', MoveType.WLineStart, false);
	cursor('cursorWLineStartSelect', 'Select to First Non-Whitespace', MoveType.WLineStart, true);
	cursor('cursorWLineEnd', 'Go to Line End (Word)', MoveType.WLineEnd, false);
	cursor('cursorWLineEndSelect', 'Select to Line End (Word)', MoveType.WLineEnd, true);

	cursor('cursorTop', 'Go to Beginning of File', MoveType.DocStart, false, { primary: KeyMod.CtrlCmd | KeyCode.UpArrow });
	cursor('cursorTopSelect', 'Select to Beginning of File', MoveType.DocStart, true, { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.UpArrow });
	cursor('cursorBottom', 'Go to End of File', MoveType.DocEnd, false, { primary: KeyMod.CtrlCmd | KeyCode.DownArrow });
	cursor('cursorBottomSelect', 'Select to End of File', MoveType.DocEnd, true, { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.DownArrow });
	cursor('cursorPageUp', 'Scroll Page Up', MoveType.PageUp, false, { primary: KeyCode.PageUp });
	cursor('cursorPageUpSelect', 'Select Page Up', MoveType.PageUp, true, { primary: KeyMod.Shift | KeyCode.PageUp });
	cursor('cursorPageDown', 'Scroll Page Down', MoveType.PageDown, false, { primary: KeyCode.PageDown });
	cursor('cursorPageDownSelect', 'Select Page Down', MoveType.PageDown, true, { primary: KeyMod.Shift | KeyCode.PageDown });

	register('deleteLeft', 'Delete Left', 'Editing', () => getActiveWidget()!.deleteLeft(), { primary: KeyCode.Backspace });
	register('deleteRight', 'Delete Right', 'Editing', () => getActiveWidget()!.deleteRight(), { primary: KeyCode.Delete });
	register('undo', 'Undo', 'Editing', () => getActiveWidget()!.undo(), { primary: KeyMod.CtrlCmd | KeyCode.KeyZ, secondary: KeyMod.WinCtrl | KeyCode.KeyZ });
	register('redo', 'Redo', 'Editing', () => getActiveWidget()!.redo(), { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ, secondary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.KeyZ });
	register('tab', 'Insert Tab', 'Editing', () => getActiveWidget()!.type('\t'), { primary: KeyCode.Tab });

	// programmatic typing path (the textarea routes here); not bound to a key by design
	disposables.push(CommandsRegistry.registerCommand('type', (_accessor, text: string) => getActiveWidget()?.type(String(text ?? ''))));

	return toDisposable(() => disposables.forEach(d => d.dispose()));
}
