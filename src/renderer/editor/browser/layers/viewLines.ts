// src/renderer/editor/browser/layers/viewLines.ts — the visible-lines layer, ported in spirit
// from vs/editor/browser/viewParts/lines/viewLines.ts:
//
//   - absolute-positioned line divs inside the content spacer;
//   - a POOL of LineNodes, reused across scroll (never recreated per frame);
//   - a per-line version map: only lines whose (lineNumber, version) changed have their DOM
//     content rebuilt — this is the "render only what changed" rule and the 100k-line gate.
//
// Tokens are cached per line; the only cross-line state (block comments) is propagated through
// checkpoints every CHECKPOINT_INTERVAL lines so a jump to line 90k costs a bounded back-scan.
//
// shortcut: no model-level token store (model/textModelTokens.ts persists tokens per line
// across model lifetimes) — our cache dies with the layer.

import { IDisposable } from '../../../../common/base/common/lifecycle.js';
import { IModelContentChangedEvent } from '../../../../common/editor/common/core/textChange.js';
import { TextModel } from '../../../../common/editor/common/model/textModel.js';
import { append, $ } from '../../../base/browser/dom.js';
import { IToken, scanBlockCommentState, tokenizeLine } from '../tokenizer.js';
import { expandTabs, IViewport, ViewModel } from '../viewModel.js';
import { IRenderContext, IViewLayer } from '../view.js';

const CHECKPOINT_INTERVAL = 200;
/** extra px of horizontal headroom so the last character is not under the scrollbar */
const HORIZONTAL_PADDING = 30;

interface ILineNode {
	element: HTMLElement;
	lineNumber: number;
	version: number;
	epoch: number;
	/** rendered (tab-expanded) cell count, for the content width */
	renderedCells: number;
	data: ILineInfo;
}

interface ITokenCacheEntry {
	tokens: IToken[];
	stateAfter: boolean;
}

interface ILineInfo {
	lineNumber: number;
	columns: number[];
}

export class ViewLinesLayer implements IViewLayer {

	readonly element: HTMLElement;

	private readonly _nodes: ILineNode[] = [];
	private _model: TextModel | null = null;
	private _versionListener: IDisposable | null = null;
	/** bumped when lineHeight/charWidth/tabSize change: everything repaints once */
	private _epoch = 0;

	/** lineNumber → bumped on every content change touching the line */
	private readonly _lineVersions = new Map<number, number>();
	private readonly _tokenCache = new Map<number, ITokenCacheEntry>();
	private readonly _checkpoints = new Map<number, boolean>();
	/** data for the mouse handler's caretRangeFromPoint mapping */
	private readonly _lineInfo = new WeakMap<HTMLElement, ILineInfo>();

	constructor(private readonly _viewModel: ViewModel, private readonly _reportContentWidth: (width: number) => void) {
		this.element = $('.layer-lines');
	}

	setModel(model: TextModel): void {
		this._versionListener?.dispose();
		this._model = model;
		this._lineVersions.clear();
		this._tokenCache.clear();
		this._checkpoints.clear();
		this._epoch++;
		this._versionListener = model.onDidChangeContent(event => this._onModelContentChange(event));
	}

	invalidateConfig(): void {
		this._epoch++;
	}

	disposeListeners(): void {
		this._versionListener?.dispose();
		this._versionListener = null;
	}

	private _onModelContentChange(event: IModelContentChangedEvent): void {
		let earliest = Number.MAX_SAFE_INTEGER;
		for (const change of event.changes) {
			const start = change.range.startLineNumber;
			const end = Math.max(change.range.endLineNumber, start + countNewlines(change.text));
			for (let lineNumber = start; lineNumber <= end; lineNumber++) {
				this._lineVersions.set(lineNumber, (this._lineVersions.get(lineNumber) ?? 0) + 1);
			}
			earliest = Math.min(earliest, start);
		}
		// tokens: everything from the earliest changed line on is suspect (block comments shift)
		for (const key of [...this._tokenCache.keys()]) {
			if (key >= earliest) {
				this._tokenCache.delete(key);
			}
		}
		for (const key of [...this._checkpoints.keys()]) {
			if (key >= earliest) {
				this._checkpoints.delete(key);
			}
		}
	}

	private _versionOf(lineNumber: number): number {
		return this._lineVersions.get(lineNumber) ?? 0;
	}

	/** the block-comment state entering `lineNumber`, walking from the nearest checkpoint */
	private _stateBefore(lineNumber: number): boolean {
		const model = this._model!;
		let best = 0;
		let state = false;
		for (const [key, value] of this._checkpoints) {
			if (key < lineNumber && key > best) {
				best = key;
				state = value;
			}
		}
		for (let line = best + 1; line < lineNumber; line++) {
			const cached = this._tokenCache.get(line);
			if (cached) {
				state = cached.stateAfter;
				continue;
			}
			const checkpoint = this._checkpoints.get(line);
			if (checkpoint !== undefined) {
				state = checkpoint;
				continue;
			}
			const result = scanBlockCommentState(model.getLineContent(line), state);
			state = result;
			if (line % CHECKPOINT_INTERVAL === 0) {
				this._checkpoints.set(line, state);
			}
		}
		return state;
	}

	private _tokensFor(lineNumber: number, lineText: string): IToken[] {
		const cached = this._tokenCache.get(lineNumber);
		if (cached) {
			return cached.tokens;
		}
		const state = this._stateBefore(lineNumber);
		const result = tokenizeLine(lineText, state);
		this._tokenCache.set(lineNumber, { tokens: result.tokens, stateAfter: result.inBlockComment });
		if (lineNumber % CHECKPOINT_INTERVAL === 0) {
			this._checkpoints.set(lineNumber, result.inBlockComment);
		}
		return result.tokens;
	}

	render(viewport: IViewport, context: IRenderContext): void {
		const model = this._model;
		if (!model) {
			return;
		}
		const viewModel = this._viewModel;
		let maxCells = 0;
		let slot = 0;

		// a folded line has no row, so the pool walks the VISIBLE model lines rather than a range
		for (const lineNumber of viewModel.visibleModelLines(viewport)) {
			const index = slot++;
			let node = this._nodes[index];
			if (!node) {
				const element = $('.view-line');
				const data: ILineInfo = { lineNumber: -1, columns: [] };
				node = { element, lineNumber: -1, version: -1, epoch: -1, renderedCells: 0, data };
				this._nodes[index] = node;
				this._lineInfo.set(element, data);
				append(this.element, element);
			}

			const version = this._versionOf(lineNumber);
			if (node.lineNumber !== lineNumber || node.version !== version || node.epoch !== this._epoch) {
				node.lineNumber = lineNumber;
				node.version = version;
				node.epoch = this._epoch;
				this._renderLine(node, lineNumber, model.getLineContent(lineNumber));
				context.stats.renderedLines++;
			}

			if (node.renderedCells > maxCells) {
				maxCells = node.renderedCells;
			}
			node.element.style.display = '';
		}

		// park pool slots that are no longer in the window (kept for reuse, out of sight)
		for (let i = slot; i < this._nodes.length; i++) {
			this._nodes[i].element.style.display = 'none';
		}

		this._reportContentWidth(maxCells * viewModel.getCharWidth() + HORIZONTAL_PADDING);
	}

	private _renderLine(node: ILineNode, lineNumber: number, lineText: string): void {
		const viewModel = this._viewModel;
		const { rendered, columns } = expandTabs(lineText, viewModel.getTabSize());
		const lineHeight = viewModel.getLineHeight();

		const element = node.element;
		element.textContent = '';
		element.dataset.lineNumber = String(lineNumber);
		element.style.top = `${viewModel.getLineTop(lineNumber)}px`;
		element.style.height = `${lineHeight}px`;
		element.style.lineHeight = `${lineHeight}px`;
		node.renderedCells = rendered.length;
		node.data.lineNumber = lineNumber;
		node.data.columns = columns;

		const tokens = this._tokensFor(lineNumber, lineText);
		let lastEnd = 0;
		for (const token of tokens) {
			if (token.start > lastEnd) {
				append(element, rendered.substring(lastEnd, token.start));
			}
			const span = append(element, $('span', { class: `tok-${token.type}` }));
			span.textContent = rendered.substring(token.start, token.end);
			lastEnd = token.end;
		}
		if (lastEnd < rendered.length) {
			append(element, rendered.substring(lastEnd));
		}
	}

	/** map a DOM range (from caretRangeFromPoint) inside a line back to a position */
	columnAtDomRange(node: Node, offset: number, viewModel: ViewModel): { lineNumber: number; column: number } | null {
		const textNode = node.nodeType === 3 /* Node.TEXT_NODE without touching the global */ ? node as Text : null;
		const element = (textNode ? textNode.parentElement : (node as HTMLElement))?.closest('.view-line') as HTMLElement | null;
		if (!element) {
			return null;
		}
		const info = this._lineInfo.get(element);
		if (!info || info.lineNumber < 1 || !this._model) {
			return null;
		}
		let renderedOffset = textNode ? offset : 0;
		let sibling: ChildNode | null = textNode ? textNode.previousSibling : null;
		while (sibling) {
			renderedOffset += sibling.textContent?.length ?? 0;
			sibling = sibling.previousSibling;
		}
		const lineText = this._model.getLineContent(info.lineNumber);
		return { lineNumber: info.lineNumber, column: viewModel.columnFromVisibleColumn(lineText, renderedOffset) };
	}
}

function countNewlines(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			count++;
		}
	}
	return count;
}
