// src/renderer/editor/contrib/hover/hoverController.ts — the content hover, ported in shape
// from vs/editor/contrib/hover/browser/contentHoverController.ts + hoverOperation.ts:
//
//   - dwell: the mouse must REST for `editor.hover.delay` (default 300 — hubOperation.ts says
//     so in its own comment) before a fetch starts;
//   - cancel rules ported: mouse move to another position, mousedown, scroll, typing, Esc all
//     hide and/or restart the dwell;
//   - contents: markdown-lite — paragraphs, `inline code`, and ``` fences rendered monospace
//     (shortcut: no full markdown renderer);
//   - `Hover.range` gets a dim highlight (the ported visual);
//   - the MARKER tooltip reuses the same panel: hovering a squiggle shows the marker messages,
//     combined with a provider hover when both exist (real merges marker hovers with content).

import { Disposable, IDisposable, toDisposable } from '../../../../common/base/common/lifecycle.js';
import { Position } from '../../../../common/editor/common/core/position.js';
import { Range } from '../../../../common/editor/common/core/range.js';
import { URI } from '../../../../common/base/common/uri.js';
import { append, $, addDisposableListener } from '../../../base/browser/dom.js';
import { CommandsRegistry, CommandMetadata } from '../../../platform/commands/common/commands.js';
import { IContextKey, RawContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { KeyCode } from '../../../platform/keybinding/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { EditorWidget, IEditorWidgetServices } from '../../browser/editorWidget.js';
import { OverlayLayer, IOverlayRect } from '../../browser/layers/overlayLayer.js';
import { IViewport } from '../../browser/viewModel.js';
import { IRenderContext } from '../../browser/view.js';
import { MarkerSeverity } from '../../../workbench/services/markers/browser/markerService.js';
import type { IWireHover } from '../../../../common/platform/extensions/common/extensionHostProtocol.js';

/** the ported default of `editor.hover.delay` */
export const HOVER_DELAY = 300;

interface IHoverAnchor {
	readonly position: Position;
	readonly clientX: number;
	readonly clientY: number;
}

export class HoverController extends Disposable {

	private readonly _panel: HTMLElement;
	private readonly _content: HTMLElement;
	private readonly _highlight: HoverHighlightLayer;
	private readonly _visibleKey: IContextKey<boolean>;

	private _timer: number | null = null;
	private _anchor: IHoverAnchor | null = null;
	private _range: Range | null = null;
	private _requestId = 0;
	private _mouseDown = false;

	constructor(
		private readonly _editor: EditorWidget,
		private readonly _services: IEditorWidgetServices,
		private readonly _getResource: () => URI | undefined
	) {
		super();
		this._panel = append(this._editor.view.element, $('.editor-hover', { style: 'display: none;' }));
		this._content = append(this._panel, $('.editor-hover-content'));
		this._visibleKey = new RawContextKey<boolean>('contentHoverVisible', false).bindTo(this._services.contextKeyService);
		this._highlight = new HoverHighlightLayer(() => this._range);
		this._editor.view.addContentLayer(this._highlight);

		this._register(addDisposableListener(this._editor.view.element, 'mousemove', event => this._onMouseMove(event)));
		this._register(addDisposableListener(this._editor.view.element, 'mouseleave', () => this.hide()));
		this._register(addDisposableListener(this._editor.view.element, 'mousedown', () => {
			this._mouseDown = true;
			this.hide();
		}));
		// the drag may end outside the editor: watch the window
		const clearMouseDown = () => { this._mouseDown = false; };
		window.addEventListener('mouseup', clearMouseDown);
		this._register(toDisposable(() => window.removeEventListener('mouseup', clearMouseDown)));
		this._register(addDisposableListener(this._editor.view.scrollableElement, 'scroll', () => this.hide()));
		this._register(this._editor.onDidEdit(() => this.hide()));

		hoverControllers.set(this._editor, this);
		this._register(toDisposable(() => hoverControllers.delete(this._editor)));
	}

	get isVisible(): boolean {
		return this._panel.style.display !== 'none';
	}

	private _onMouseMove(event: MouseEvent): void {
		// selecting (dragging) never starts a dwell
		if (this._mouseDown) {
			return;
		}
		// moving over the tooltip itself keeps it open (real: the hover is interactive)
		if (this._panel.contains(event.target as Node)) {
			return;
		}
		const position = this._editor.getPositionAt(event.clientX, event.clientY);
		if (!position) {
			this.hide();
			return;
		}
		if (this._anchor && this._anchor.position.lineNumber === position.lineNumber && this._anchor.position.column === position.column) {
			// resting on the same token: the dwell continues (or the hover stays)
			return;
		}
		this._resetDwell();
		this.hide();
		this._anchor = { position, clientX: event.clientX, clientY: event.clientY };
		this._timer = window.setTimeout(() => {
			this._timer = null;
			void this._show();
		}, HOVER_DELAY);
	}

	private _resetDwell(): void {
		if (this._timer !== null) {
			window.clearTimeout(this._timer);
			this._timer = null;
		}
	}

	private async _show(): Promise<void> {
		const model = this._editor.getModel();
		const resource = this._getResource();
		const anchor = this._anchor;
		if (!model || !resource || !anchor) {
			return;
		}
		const version = model.getVersionId();
		const requestId = ++this._requestId;

		// markers first: hovering a squiggle must work without any provider (the ported order
		// merges them, provider content wins the top slot)
		const markers = this._services.markers.readForResource(resource)
			.filter(marker => containsPosition(marker.range, anchor.position));

		let hover: IWireHover | null = null;
		const languageId = this._services.languageFeatures.languageIdForResource(resource);
		const providers = this._services.languageFeatures.getHoverProviders(languageId);
		if (providers.length) {
			try {
				hover = await providers[0].provideHover(resource, model, { lineNumber: anchor.position.lineNumber, column: anchor.position.column }, requestId);
			} catch {
				hover = null;
			}
		}

		// stale guards: the mouse moved on, the buffer changed, or a newer request exists
		if (this._anchor !== anchor || requestId !== this._requestId || version !== model.getVersionId()) {
			return;
		}
		if (!hover && markers.length === 0) {
			return;
		}
		this._render(markers, hover, anchor);
	}

	private _render(
		markers: readonly { severity: MarkerSeverity; message: string }[],
		hover: IWireHover | null,
		anchor: IHoverAnchor
	): void {
		this._content.innerHTML = '';
		for (const marker of markers) {
			const paragraph = append(this._content, $('.hover-para.hover-marker'));
			paragraph.textContent = `${severityGlyph(marker.severity)} ${marker.message}`;
			paragraph.classList.add(`hover-marker-${{ [MarkerSeverity.Error]: 'error', [MarkerSeverity.Warning]: 'warning', [MarkerSeverity.Info]: 'info', [MarkerSeverity.Hint]: 'hint' }[marker.severity] ?? 'info'}`);
		}
		if (hover) {
			for (const content of hover.contents) {
				renderMarkdownLite(this._content, content.value);
			}
		}

		// the highlighted range: the provider's Hover.range, else the marker's range
		const wireRange = hover?.range;
		this._range = wireRange
			? new Range(wireRange.start.line + 1, wireRange.start.character + 1, wireRange.end.line + 1, wireRange.end.character + 1)
			: null;
		this._editor.view.scheduleRender();

		this._panel.style.display = '';
		this._visibleKey.set(true);
		this._position(anchor);
	}

	private _position(anchor: IHoverAnchor): void {
		const editorRect = this._editor.view.element.getBoundingClientRect();
		const panelRect = this._panel.getBoundingClientRect();
		let left = anchor.clientX - editorRect.left + 12;
		let top = anchor.clientY - editorRect.top + 18;
		// flip above the mouse when the panel would overflow the bottom
		if (top + panelRect.height > editorRect.height && anchor.clientY - editorRect.top - panelRect.height - 6 > 0) {
			top = anchor.clientY - editorRect.top - panelRect.height - 12;
		}
		left = Math.max(0, Math.min(left, editorRect.width - panelRect.width - 4));
		this._panel.style.left = `${left}px`;
		this._panel.style.top = `${top}px`;
	}

	hide(): void {
		this._resetDwell();
		this._anchor = null;
		if (this._panel.style.display !== 'none') {
			this._panel.style.display = 'none';
			this._visibleKey.set(false);
		}
		if (this._range) {
			this._range = null;
			this._editor.view.scheduleRender();
		}
	}

	override dispose(): void {
		this._resetDwell();
		this._panel.remove();
		super.dispose();
	}
}

/** the dim highlight under the hovered token (the ported `Hover.range` visual) */
class HoverHighlightLayer extends OverlayLayer {

	constructor(private readonly _getRange: () => Range | null) {
		super('hover-highlight');
	}

	protected override prepareRender(viewport: IViewport, context: IRenderContext): IOverlayRect[] {
		const range = this._getRange();
		if (!range) {
			return [];
		}
		const rects: IOverlayRect[] = [];
		const firstLine = Math.max(range.startLineNumber, viewport.startLineNumber);
		const lastLine = Math.min(range.endLineNumber, viewport.endLineNumber);
		for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
			const lineText = context.model.getLineContent(lineNumber);
			const columnStart = lineNumber === range.startLineNumber ? range.startColumn : 1;
			const columnEnd = lineNumber === range.endLineNumber ? range.endColumn : lineText.length + 1;
			const left = context.viewModel.getXForColumn(lineText, columnStart);
			const width = context.viewModel.getXForColumn(lineText, columnEnd) - left;
			rects.push({ top: context.viewModel.getLineTop(lineNumber), left, width, height: context.viewModel.getLineHeight() });
		}
		return rects;
	}
}

/** markdown-lite: paragraphs + `inline code` + ``` fences (shortcut: no full markdown) */
export function renderMarkdownLite(container: HTMLElement, value: string): void {
	let fence: HTMLElement | null = null;
	for (const line of value.split('\n')) {
		if (line.trimStart().startsWith('```')) {
			fence = fence ? null : append(container, $('pre.hover-code'));
			continue;
		}
		if (fence) {
			fence.textContent = fence.textContent ? `${fence.textContent}\n${line}` : line;
			continue;
		}
		if (line.trim() === '') {
			continue;
		}
		const paragraph = append(container, $('.hover-para'));
		const parts = line.split('`');
		for (let i = 0; i < parts.length; i++) {
			if (i % 2 === 1) {
				append(paragraph, $('code', {}, parts[i]));
			} else if (parts[i]) {
				paragraph.appendChild(document.createTextNode(parts[i]));
			}
		}
	}
}

function containsPosition(range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }, position: Position): boolean {
	if (position.lineNumber < range.startLineNumber || position.lineNumber > range.endLineNumber) {
		return false;
	}
	if (position.lineNumber === range.startLineNumber && position.column < range.startColumn) {
		return false;
	}
	if (position.lineNumber === range.endLineNumber && position.column > range.endColumn) {
		return false;
	}
	return true;
}

function severityGlyph(severity: MarkerSeverity): string {
	switch (severity) {
		case MarkerSeverity.Error: return '⨯';
		case MarkerSeverity.Warning: return '⚠';
		default: return 'ⓘ';
	}
}

// ---- the per-widget lookup + the Esc command (the ported "hide on Esc")

const hoverControllers = new WeakMap<EditorWidget, HoverController>();

export function hoverControllerFor(widget: EditorWidget | null): HoverController | null {
	return widget ? hoverControllers.get(widget) ?? null : null;
}

export function registerHoverCommands(getActiveController: () => HoverController | null): IDisposable {
	const disposables: IDisposable[] = [];
	disposables.push(CommandsRegistry.registerCommand('editor.action.hideHover', () => getActiveController()?.hide()));
	disposables.push(CommandMetadata.register({ id: 'editor.action.hideHover', title: 'Hide Hover', category: 'Editor' }));
	disposables.push(KeybindingsRegistry.registerKeybindingRule({
		id: 'editor.action.hideHover',
		weight: KeybindingWeight.EditorContrib,
		when: new RawContextKey<boolean>('contentHoverVisible', false),
		primary: KeyCode.Escape,
		mac: KeyCode.Escape
	}));
	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}
