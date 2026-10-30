// src/common/editor/common/model/textModel.ts — the TextModel: buffer + versioning + save points +
// undo/redo. Ported in spirit from vs/editor/common/model/textModel.ts (the reference revision
// delegates undo/redo to a global UndoRedoService; the classic model-owned EditStack is ported
// here, matching the course spec and its behavior table).
//
// shortcut: no snapshot support (createSnapshot/applySnapshot) and no TextModelPart decomposition —
// async consumers re-read by range instead. Revisit when 12 lands.
// shortcut: no in-model search/word helpers (in-editor find is not in the course core).

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { Position } from '../core/position.js';
import { Range } from '../core/range.js';
import { IModelContentChange, IModelContentChangedEvent, ISingleEditOperation, IValidEditOperation, TextChange } from '../core/textChange.js';
import { CursorState, EditStack } from './editStack.js';
import { DefaultEndOfLine, ITextBuffer, LineArrayTextBuffer } from './textBuffer.js';

export interface ITextBufferFactory {
	readonly text: string;
	readonly eol?: '\n' | '\r\n';
}

export interface ITextModelOptions {
	readonly defaultEOL?: DefaultEndOfLine;
	readonly tabSize?: number;
	/** injectable clock — undo grouping must be testable without sleeping */
	readonly now?: () => number;
}

export type CursorStateComputer = (inverseEditOperations: IValidEditOperation[]) => CursorState;

export class TextModel extends Disposable {

	private readonly _buffer: ITextBuffer;
	private readonly _editStack: EditStack;

	private _versionId = 1;
	private _alternativeVersionId = 1;
	private _savedVersionId = 1;

	private _isUndoing = false;
	private _isRedoing = false;
	private _isDisposed = false;

	private readonly _onDidChangeContent = this._register(new Emitter<IModelContentChangedEvent>());
	readonly onDidChangeContent: Event<IModelContentChangedEvent> = this._onDidChangeContent.event;

	constructor(textOrFactory: string | ITextBufferFactory, options: ITextModelOptions = {}) {
		super();
		const factory = typeof textOrFactory === 'string' ? { text: textOrFactory } : textOrFactory;
		this._buffer = new LineArrayTextBuffer(factory.text, factory.eol, options.defaultEOL ?? DefaultEndOfLine.LF);
		this._editStack = new EditStack(options.now);
	}

	//#region reading

	getValue(): string {
		this._assertNotDisposed();
		return this._buffer.getValue();
	}

	getLineCount(): number {
		this._assertNotDisposed();
		return this._buffer.getLineCount();
	}

	getLineContent(lineNumber: number): string {
		this._assertNotDisposed();
		return this._buffer.getLineContent(lineNumber);
	}

	getLineLength(lineNumber: number): number {
		this._assertNotDisposed();
		return this._buffer.getLineLength(lineNumber);
	}

	getLineMaxColumn(lineNumber: number): number {
		this._assertNotDisposed();
		return this._buffer.getLineLength(lineNumber) + 1;
	}

	getEOL(): string {
		this._assertNotDisposed();
		return this._buffer.getEOL();
	}

	getValueInRange(range: Range): string {
		this._assertNotDisposed();
		return this._buffer.getValueInRange(range);
	}

	getFullModelRange(): Range {
		this._assertNotDisposed();
		const lastLineNumber = this._buffer.getLineCount();
		const lastLineLength = this._buffer.getLineLength(lastLineNumber);
		return new Range(1, 1, lastLineNumber, lastLineLength + 1);
	}

	getOffsetAt(position: Position): number {
		this._assertNotDisposed();
		const lineNumber = Math.min(Math.max(position.lineNumber, 1), this._buffer.getLineCount());
		const column = Math.min(Math.max(position.column, 1), this._buffer.getLineLength(lineNumber) + 1);
		return this._buffer.getOffsetAt(lineNumber, column);
	}

	getPositionAt(offset: number): Position {
		this._assertNotDisposed();
		return this._buffer.getPositionAt(Math.min(this._buffer.getLength(), Math.max(0, offset)));
	}

	//#endregion

	//#region versions & save points

	getVersionId(): number {
		this._assertNotDisposed();
		return this._versionId;
	}

	/**
	 * The version moveable through undo/redo: undo decrements it, redo increments it, a new edit
	 * jumps it to the fresh versionId. Save points anchor to THIS one because it identifies the
	 * position in undo history, not the mere content revision.
	 */
	getAlternativeVersionId(): number {
		this._assertNotDisposed();
		return this._alternativeVersionId;
	}

	isModified(): boolean {
		this._assertNotDisposed();
		return this._alternativeVersionId !== this._savedVersionId;
	}

	/** the save layer (09) calls this after persisting: the current alternative version is clean */
	setSavedVersionId(versionId: number = this._alternativeVersionId): void {
		this._assertNotDisposed();
		this._savedVersionId = versionId;
	}

	/**
	 * Reset the buffer to `text` and drop the whole edit history (09's revert). The version
	 * advances (listeners re-read) and the reset state counts as saved.
	 */
	revertTo(text: string): void {
		this._assertNotDisposed();
		const fullRange = this.getFullModelRange();
		if (this.getValue() !== text) {
			this.applyEdits([{ range: fullRange, text }]);
		}
		this._editStack.clear();
		this._savedVersionId = this._alternativeVersionId;
	}

	private _increaseVersionId(): void {
		this._versionId = this._versionId + 1;
		this._alternativeVersionId = this._versionId;
	}

	//#endregion

	//#region edits

	/**
	 * Pure content edit: validates, applies, fires one content change event. Deliberately does NOT
	 * touch the undo stack — bracket grouped programmatic edits with pushEditOperations +
	 * pushStackElement (replace-all in A1, rename in A2) or undo will do too much / nothing.
	 */
	applyEdits(operations: readonly ISingleEditOperation[]): void {
		this._assertNotDisposed();
		const validated = this._validateEditOperations(operations);
		if (validated.length === 0) {
			return;
		}
		const { modelChanges } = this._applyValidatedEdits(validated);
		this._increaseVersionId();
		this._fireChange(modelChanges, this._isUndoing, this._isRedoing);
	}

	/**
	 * The edit path that participates in undo/redo: applies the ops, computes the new cursor state
	 * from the inverse operations and groups the change into the edit stack.
	 */
	pushEditOperations(beforeCursorState: CursorState | null, editOperations: ISingleEditOperation[], cursorStateComputer: CursorStateComputer | null): CursorState | null {
		this._assertNotDisposed();
		const validated = this._validateEditOperations(editOperations);
		if (validated.length === 0) {
			return null;
		}

		const { changes, inverseOperations, modelChanges } = this._applyValidatedEdits(validated);
		this._increaseVersionId();
		this._fireChange(modelChanges, false, false);

		let afterCursorState: CursorState | null = null;
		try {
			afterCursorState = cursorStateComputer ? cursorStateComputer(inverseOperations) : null;
		} catch {
			afterCursorState = null;
		}

		// the EOL rule feeds the grouping: an edit crossing a line break starts a new element
		const isEol = changes.some(change =>
			change.oldText.includes('\n') || change.oldText.includes('\r')
			|| change.newText.includes('\n') || change.newText.includes('\r'));

		this._editStack.pushChange(changes, beforeCursorState, afterCursorState, isEol);
		return afterCursorState;
	}

	pushStackElement(): void {
		this._assertNotDisposed();
		this._editStack.pushStackElement();
	}

	private _validateEditOperations(rawOperations: readonly ISingleEditOperation[]): { range: Range; text: string }[] {
		const operations: { range: Range; text: string }[] = [];
		const lineCount = this._buffer.getLineCount();

		for (const raw of rawOperations) {
			const range = raw.range;

			if (range.startLineNumber < 1 || range.endLineNumber > lineCount) {
				throw new Error(`Illegal value for lineNumber: ${range.startLineNumber === range.endLineNumber ? range.startLineNumber : `${range.startLineNumber}-${range.endLineNumber}`} (expected 1 - ${lineCount})`);
			}
			if (range.startColumn < 1 || range.startColumn > this._buffer.getLineLength(range.startLineNumber) + 1) {
				throw new Error(`Illegal value for column: ${range.startColumn} (expected 1 - ${this._buffer.getLineLength(range.startLineNumber) + 1} on line ${range.startLineNumber})`);
			}
			if (range.endColumn < 1 || range.endColumn > this._buffer.getLineLength(range.endLineNumber) + 1) {
				throw new Error(`Illegal value for column: ${range.endColumn} (expected 1 - ${this._buffer.getLineLength(range.endLineNumber) + 1} on line ${range.endLineNumber})`);
			}

			operations.push({ range, text: raw.text ?? '' });
		}

		// sort ascending by offset, then reject overlaps
		operations.sort((a, b) => this.getOffsetAt(a.range.getStartPosition()) - this.getOffsetAt(b.range.getStartPosition()));
		for (let i = 1; i < operations.length; i++) {
			const previousEnd = this.getOffsetAt(operations[i - 1].range.getEndPosition());
			const currentStart = this.getOffsetAt(operations[i].range.getStartPosition());
			if (currentStart < previousEnd) {
				throw new Error('Overlapping ranges are not allowed!');
			}
		}

		return operations;
	}

	private _applyValidatedEdits(operations: readonly { range: Range; text: string }[]): {
		changes: TextChange[];
		inverseOperations: IValidEditOperation[];
		modelChanges: IModelContentChange[];
	} {
		const changes: TextChange[] = [];
		const inverseOperations: IValidEditOperation[] = [];
		const modelChanges: IModelContentChange[] = [];

		// first pass (ascending): snapshot the old text and compute new-text offsets via a running delta
		let delta = 0;
		for (const operation of operations) {
			const rangeOffset = this.getOffsetAt(operation.range.getStartPosition());
			const deletedText = this._buffer.getValueInRange(operation.range);
			const newPosition = rangeOffset + delta;

			changes.push({ oldPosition: rangeOffset, oldText: deletedText, newPosition, newText: operation.text });
			inverseOperations.push({ range: operation.range, text: deletedText });

			delta += operation.text.length - deletedText.length;
		}

		// second pass (descending): apply to the buffer so original offsets stay valid
		for (let i = operations.length - 1; i >= 0; i--) {
			const change = changes[i];
			if (change.oldText.length > 0) {
				this._buffer.delete(change.oldPosition, change.oldText.length);
			}
			if (change.newText.length > 0) {
				this._buffer.insert(change.oldPosition, change.newText);
			}
		}

		// the event payload is sorted DESCENDING by rangeOffset: applying it to an old snapshot
		// keeps earlier offsets valid
		for (let i = operations.length - 1; i >= 0; i--) {
			const change = changes[i];
			modelChanges.push({
				range: operations[i].range,
				rangeOffset: change.oldPosition,
				rangeLength: change.oldText.length,
				text: change.newText
			});
		}

		return { changes, inverseOperations, modelChanges };
	}

	private _fireChange(modelChanges: IModelContentChange[], isUndoing: boolean, isRedoing: boolean): void {
		this._onDidChangeContent.fire({
			versionId: this._versionId,
			changes: modelChanges,
			eol: this._buffer.getEOL(),
			isUndoing,
			isRedoing
		});
	}

	//#endregion

	//#region undo & redo

	canUndo(): boolean {
		return this._editStack.canUndo();
	}

	canRedo(): boolean {
		return this._editStack.canRedo();
	}

	/** @returns the cursor state to restore (opaque until 08's selections) */
	undo(): CursorState | null {
		this._assertNotDisposed();
		const element = this._editStack.undo();
		if (!element) {
			return null;
		}

		// version bookkeeping BEFORE the event: listeners (09's dirty tracking) read isModified
		// while the content-change event is being delivered
		this._versionId += 1;
		this._alternativeVersionId -= element.pushes;

		this._isUndoing = true;
		try {
			this._applyStackElement(element, false);
		} finally {
			this._isUndoing = false;
		}
		return element.beforeCursorState;
	}

	/** @returns the cursor state the edit left behind */
	redo(): CursorState | null {
		this._assertNotDisposed();
		const element = this._editStack.redo();
		if (!element) {
			return null;
		}

		this._versionId += 1;
		this._alternativeVersionId += element.pushes;

		this._isRedoing = true;
		try {
			this._applyStackElement(element, true);
		} finally {
			this._isRedoing = false;
		}
		return element.afterCursorState;
	}

	private _applyStackElement(element: { changes: TextChange[] }, isRedo: boolean): void {
		const modelChanges: IModelContentChange[] = [];

		if (isRedo) {
			// redo: apply ascending at oldPosition, oldText -> newText
			for (const change of element.changes) {
				const range = Range.fromPositions(this.getPositionAt(change.oldPosition), this.getPositionAt(change.oldPosition + change.oldText.length));
				modelChanges.unshift({
					range,
					rangeOffset: change.oldPosition,
					rangeLength: change.oldText.length,
					text: change.newText
				});
				if (change.oldText.length > 0) {
					this._buffer.delete(change.oldPosition, change.oldText.length);
				}
				if (change.newText.length > 0) {
					this._buffer.insert(change.oldPosition, change.newText);
				}
			}
		} else {
			// undo: apply descending at newPosition, newText -> oldText
			for (let i = element.changes.length - 1; i >= 0; i--) {
				const change = element.changes[i];
				const range = Range.fromPositions(this.getPositionAt(change.newPosition), this.getPositionAt(change.newPosition + change.newText.length));
				modelChanges.push({
					range,
					rangeOffset: change.newPosition,
					rangeLength: change.newText.length,
					text: change.oldText
				});
				if (change.newText.length > 0) {
					this._buffer.delete(change.newPosition, change.newText.length);
				}
				if (change.oldText.length > 0) {
					this._buffer.insert(change.newPosition, change.oldText);
				}
			}
		}

		this._fireChange(modelChanges, this._isUndoing, this._isRedoing);
	}

	//#endregion

	private _assertNotDisposed(): void {
		if (this._isDisposed) {
			throw new Error('TextModel has been disposed');
		}
	}

	override dispose(): void {
		this._isDisposed = true;
		super.dispose();
	}
}
