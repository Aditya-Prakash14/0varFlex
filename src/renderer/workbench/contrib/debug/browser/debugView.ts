// src/renderer/workbench/contrib/debug/browser/debugView.ts — the Debug composite, ported in
// shape from vs/workbench/contrib/debug/browser/{callStackView,variablesView,debugToolBar}.ts:
//
//   - the toolbar's enablement is driven by the session state, which is the only thing the view
//     knows: 'inactive' | 'running' | 'stopped';
//   - call stack rows open the frame's file at its line (the editor plumbing already existed);
//   - variables are scopes → variables, pulled on demand when a scope is expanded (DAP's shape).
//
// delta: no watch expressions, no REPL/debug console, no loaded-scripts or exception panes, no
// thread grouping (one thread), no drag to reorder.

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../../common/base/common/uri.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { addDisposableListener, append, $ } from '../../../../base/browser/dom.js';
import type { DebugService, IStackFrame } from '../../../services/debug/browser/debugService.js';

export const DebugViewFocusContext = new RawContextKey<boolean>('debugViewFocus', false);
/** the real workbench gates the debug bindings on this */
export const InDebugModeContext = new RawContextKey<boolean>('inDebugMode', false);

export interface IDebugViewServices {
	readonly debugService: DebugService;
	readonly contextKeyService: IContextKeyService;
	openFrame(resource: URI, line: number, column: number): void;
	start(): void;
}

function splitPath(fsPath: string): string {
	const index = Math.max(fsPath.lastIndexOf('/'), fsPath.lastIndexOf('\\'));
	return index >= 0 ? fsPath.slice(index + 1) : fsPath;
}

export class DebugView extends Disposable {

	readonly element: HTMLElement;

	private readonly _toolbar: HTMLElement;
	private readonly _status: HTMLElement;
	private readonly _stackBody: HTMLElement;
	private readonly _variablesBody: HTMLElement;
	private readonly _breakpointsBody: HTMLElement;

	private readonly _inDebugMode: IContextKey<boolean>;
	private readonly _focusKey: IContextKey<boolean>;

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState: Event<void> = this._onDidChangeState.event;

	/**
	 * Listeners for the CURRENT render only. render() runs on every state change — including
	 * every line of program output — and rebuilds the toolbar, stack, variables and breakpoint
	 * rows, so their listeners must die with them.
	 */
	private readonly _rowDisposables = this._register(new DisposableStore());

	constructor(container: HTMLElement, private readonly _services: IDebugViewServices) {
		super();

		this.element = append(container, $('.debug-view', { tabindex: '0' }));

		this._toolbar = append(this.element, $('.debug-toolbar'));
		this._status = append(this.element, $('.debug-status'));

		append(this.element, $('.debug-section-header', {}, 'CALL STACK'));
		this._stackBody = append(this.element, $('.debug-stack'));

		append(this.element, $('.debug-section-header', {}, 'VARIABLES'));
		this._variablesBody = append(this.element, $('.debug-variables'));

		append(this.element, $('.debug-section-header', {}, 'BREAKPOINTS'));
		this._breakpointsBody = append(this.element, $('.debug-breakpoints'));

		this._inDebugMode = InDebugModeContext.bindTo(_services.contextKeyService);
		this._focusKey = DebugViewFocusContext.bindTo(_services.contextKeyService);
		this._register(addDisposableListener(this.element, 'focusin', () => this._focusKey.set(true)));
		this._register(addDisposableListener(this.element, 'focusout', () => this._focusKey.set(false)));

		this._register(this._services.debugService.onDidChangeState(() => this.render()));
		this._register(this._services.debugService.onDidChangeBreakpoints(() => this.render()));

		this.render();
	}

	focus(): void {
		this.element.focus();
	}

	render(): void {
		this._rowDisposables.clear();
		const debugService = this._services.debugService;
		const state = debugService.state;
		this._inDebugMode.set(debugService.isActive);

		// ---- toolbar: labels and enablement from the state alone
		this._toolbar.textContent = '';
		const button = (label: string, title: string, enabled: boolean, run: () => void): void => {
			const element = append(this._toolbar, $('span.debug-button', { title, tabindex: enabled ? '0' : '-1' }, label));
			element.classList.toggle('disabled', !enabled);
			if (!enabled) {
				return;
			}
			this._rowDisposables.add(addDisposableListener(element, 'click', run));
			this._rowDisposables.add(addDisposableListener(element, 'keydown', (event: KeyboardEvent) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					run();
				}
			}));
		};

		button('▶', state === 'stopped' ? 'Continue (F5)' : 'Start Debugging (F5)', state !== 'running',
			() => state === 'stopped' ? void debugService.continue() : this._services.start());
		button('⏭', 'Step Over (F10)', state === 'stopped', () => void debugService.next());
		button('⏹', 'Stop (Shift+F5)', debugService.isActive, () => void debugService.stop());

		this._status.textContent = debugService.isActive
			? `${debugService.sessionName} — ${state}`
			: 'Not debugging. Press F5 to start.';

		// ---- call stack
		this._stackBody.textContent = '';
		if (debugService.frames.length === 0) {
			append(this._stackBody, $('.debug-empty', {}, state === 'running' ? 'Running…' : 'No call stack.'));
		} else {
			for (const frame of debugService.frames) {
				this._renderFrame(frame, frame.id === debugService.focusedFrameId);
			}
		}

		// ---- variables
		this._variablesBody.textContent = '';
		if (debugService.scopes.length === 0) {
			append(this._variablesBody, $('.debug-empty', {}, 'No variables.'));
		} else {
			for (const scope of debugService.scopes) {
				const header = append(this._variablesBody, $('.debug-scope'));
				const twisty = append(header, $('span.debug-twisty'));
				twisty.classList.toggle('expanded', scope.expanded);
				append(header, $('span.debug-scope-name', {}, scope.name));
				const reference = scope.variablesReference;
				this._rowDisposables.add(addDisposableListener(header, 'click', () => void debugService.toggleScope(reference)));

				if (scope.expanded) {
					for (const variable of scope.variables) {
						const row = append(this._variablesBody, $('.debug-variable'));
						append(row, $('span.debug-variable-name', {}, variable.name));
						append(row, $('span.debug-variable-value', {}, variable.value));
					}
				}
			}
		}

		// ---- breakpoints
		this._breakpointsBody.textContent = '';
		if (debugService.breakpoints.length === 0) {
			append(this._breakpointsBody, $('.debug-empty', {}, 'No breakpoints.'));
		} else {
			for (const breakpoint of debugService.breakpoints) {
				const row = append(this._breakpointsBody, $('.debug-breakpoint', { title: `${breakpoint.path}:${breakpoint.line}` }));
				append(row, $('span.debug-breakpoint-dot'));
				append(row, $('span.debug-breakpoint-name', {}, `${splitPath(breakpoint.path)}:${breakpoint.line}`));
				const resource = URI.file(breakpoint.path);
				const line = breakpoint.line;
				this._rowDisposables.add(addDisposableListener(row, 'click', () => this._services.openFrame(resource, line, 1)));
			}
		}

		this._onDidChangeState.fire();
	}

	private _renderFrame(frame: IStackFrame, focused: boolean): void {
		const row = append(this._stackBody, $('.debug-frame', { title: frame.path ? `${frame.path}:${frame.line}` : frame.name }));
		row.classList.toggle('focused', focused);
		append(row, $('span.debug-frame-name', {}, frame.name));
		append(row, $('span.debug-frame-line', {}, frame.path ? `${splitPath(frame.path)}:${frame.line}` : `line ${frame.line}`));

		this._rowDisposables.add(addDisposableListener(row, 'click', () => {
			void this._services.debugService.focusFrame(frame.id);
			if (frame.path) {
				this._services.openFrame(URI.file(frame.path), frame.line, frame.column);
			}
		}));
	}
}
