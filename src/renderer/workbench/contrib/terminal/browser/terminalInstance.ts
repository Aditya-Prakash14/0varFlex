// src/renderer/workbench/contrib/terminal/browser/terminalInstance.ts — one terminal: the xterm
// wrapper + FitAddon + the data flow, ported in shape from
// vs/workbench/contrib/terminal/browser/terminalInstance.ts + xterm/xtermTerminal.ts:
//
//   - xterm options come from the `terminal.integrated.*` settings and live-apply;
//   - open → fit → THEN $createProcess/$start (the ported order: a pty created with the default
//     80x24 then resized swallows zsh's first prompt);
//   - pty data → xterm.write; the ACK is sent from the write CALLBACK (parsed, not received) and
//     batched at CharCountAckSize — acking on receive makes flow control decorative;
//   - fitting only happens while visible with a real size (the #1 multi-terminal bug);
//   - resize is debounced onto the pty (real debounces the fit while the sash is dragged);
//   - the key handler rule: let the workbench keybindings try first; if a command claims the
//     keypress xterm must NOT handle it, otherwise xterm gets it;
//   - on exit the tab PERSISTS with the ported `[exited with code N]` banner (this reference
//     revision disposes instead — documented delta, the acceptance pins the classic behavior).

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { Disposable } from '../../../../../common/base/common/lifecycle.js';
import { append, $ } from '../../../../base/browser/dom.js';
import { IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { eventToChord } from '../../../../platform/keybinding/browser/keybindingService.js';
import {
	FlowControlConstants,
	formatMessageForTerminal,
	RESIZE_DEBOUNCE_MS
} from '../../../../../common/platform/terminal/common/terminal.js';
import type { TerminalService, ITerminalServiceOptions } from './terminalService.js';

/** the workbench palette whenever a real theme registry is ported (delta: no theme service) */
const TERMINAL_THEME = {
	background: '#1e1e1e',
	foreground: '#cccccc',
	cursor: '#aeafad',
	cursorAccent: '#1e1e1e',
	selectionBackground: '#264f78',
	black: '#000000',
	red: '#cd3131',
	green: '#0dbc79',
	yellow: '#e5e510',
	blue: '#2472c8',
	magenta: '#bc3fbc',
	cyan: '#11a8cd',
	white: '#e5e5e5',
	brightBlack: '#666666',
	brightRed: '#f14c4c',
	brightGreen: '#23d18b',
	brightYellow: '#f5f543',
	brightBlue: '#3b8eea',
	brightMagenta: '#d670d6',
	brightCyan: '#29b8db',
	brightWhite: '#e5e5e5'
} as const;

export const TerminalFocusContext = new RawContextKey<boolean>('terminalFocus', false);
export const TerminalIsOpenContext = new RawContextKey<boolean>('terminalIsOpen', false);

export class TerminalInstance extends Disposable {

	private readonly _xterm: Terminal;
	private readonly _fitAddon = new FitAddon();
	private readonly _element: HTMLElement;
	private readonly _focusKey: IContextKey<boolean>;

	private _id: number | undefined;
	private _shellName = 'zsh';
	private _exited = false;
	private _started = false;
	private _visible = false;
	private _lastCols = 0;
	private _lastRows = 0;
	private _ackAccumulated = 0;
	private _resizeTimer: ReturnType<typeof setTimeout> | undefined;

	private readonly _onDidChangeTitle = this._register(new Emitter<void>());
	readonly onDidChangeTitle: Event<void> = this._onDidChangeTitle.event;
	private readonly _onDidFocus = this._register(new Emitter<void>());
	readonly onDidFocus: Event<void> = this._onDidFocus.event;

	constructor(private readonly _service: TerminalService, private readonly _options: ITerminalServiceOptions) {
		super();
		const config = this._options.configuration;
		this._element = $('.terminal-xterm');
		this._focusKey = TerminalFocusContext.bindTo(_options.contextKeyService);

		this._xterm = this._register(new Terminal({
			fontFamily: config.getValue<string>('terminal.integrated.fontFamily') || `Menlo, Monaco, 'Courier New', monospace`,
			// the reference's default is 12 on macOS, 14 elsewhere
			fontSize: config.getValue<number>('terminal.integrated.fontSize') ?? (navigator.platform.startsWith('Mac') ? 12 : 14),
			scrollback: config.getValue<number>('terminal.integrated.scrollback') ?? 1000,
			cursorBlink: config.getValue<boolean>('terminal.integrated.cursorBlinking') ?? false,
			macOptionIsMeta: config.getValue<boolean>('terminal.integrated.macOptionIsMeta') ?? false,
			theme: TERMINAL_THEME,
			scrollOnUserInput: true
		}));
		this._xterm.loadAddon(this._fitAddon);
		// focus tracking on the CONTAINER: xterm creates its textarea inside open(), and in some
		// renderer paths only after a frame — focusin/out on the container never miss it
		this._element.addEventListener('focusin', () => {
			this._focusKey.set(true);
			this._onDidFocus.fire();
		});
		this._element.addEventListener('focusout', (event: FocusEvent) => {
			if (!this._element.contains(event.relatedTarget as Node | null)) {
				this._focusKey.set(false);
			}
		});

		this._xterm.onData(data => {
			if (this._id !== undefined && !this._exited) {
				this._service.input(this._id, data);
			}
		});
		this._xterm.onResize(size => this._scheduleResize(size.cols, size.rows));
		// the ported rule: the workbench keybindings get first refusal on every keypress
		this._xterm.attachCustomKeyEventHandler(event => {
			if (event.type !== 'keydown') {
				return true;
			}
			const chord = eventToChord(event);
			if (!chord) {
				return true;
			}
			const resolution = _options.keybindingService.resolveKeypress([], chord.toString());
			// a command claimed it → xterm must not consume it; the workbench handles it
			return !resolution.commandId;
		});
		this._xterm.textarea?.addEventListener('blur', () => this._focusKey.set(false));
		this._register(_options.configuration.onDidChangeConfiguration(event => {
			if (!event.change.keys.some(key => key.startsWith('terminal.integrated'))) {
				return;
			}
			this._applyConfiguration();
		}));
	}


	get element(): HTMLElement {
		return this._element;
	}

	get xterm(): Terminal {
		return this._xterm;
	}

	get id(): number | undefined {
		return this._id;
	}

	get title(): string {
		return this._shellName;
	}

	get isExited(): boolean {
		return this._exited;
	}

	get hasFocus(): boolean {
		return this._focusKey.get() ?? false;
	}

	/** the panel calls this with a visible, sized container: the ported open → fit → start order */
	async attach(container: HTMLElement): Promise<void> {
		append(container, this._element);
		this._xterm.open(this._element);
		this._visible = true;
		// a best-effort fit right away; the post-start resize below covers the case where the
		// container is not laid out yet (rAF-driven waits HANG in occluded windows — 13's lesson)
		this.fit();
		if (this._started) {
			return;
		}
		this._started = true;
		const size = { cols: this._xterm.cols, rows: this._xterm.rows };
		const result = await this._service.createProcess(size.cols, size.rows);
		this._id = result.id;
		this._shellName = result.shellName;
		this._onDidChangeTitle.fire();
		await this._service.start(result.id);
		// the first fit may have happened before the id existed (or while hidden): make the pty
		// match the current grid — the ported "resize right after launch" step
		this._service.resize(result.id, this._xterm.cols, this._xterm.rows);
		this._lastCols = this._xterm.cols;
		this._lastRows = this._xterm.rows;
	}

	setVisible(visible: boolean): void {
		this._visible = visible;
		this._element.style.display = visible ? '' : 'none';
		if (visible) {
			this.fit();
			this.focus();
		}
	}

	/** only fit when visible with a real size — a hidden fit yields 1xN and nukes wrapping */
	fit(): void {
		if (!this._visible || this._element.clientWidth < 20 || this._element.clientHeight < 20) {
			return;
		}
		try {
			this._fitAddon.fit();
		} catch { /* transient layout state */ }
	}

	focus(): void {
		// an already-focused textarea fires no focusin: the key would stay stale after setActive
		this._focusKey.set(true);
		this._xterm.focus();
	}

	clear(): void {
		this._xterm.clear();
	}

	/** pty data → xterm; the ack rides the write callback and batches at 5k chars */
	acceptData(data: string, service: TerminalService): void {
		this._xterm.write(data, () => {
			this._ackAccumulated += data.length;
			if (this._ackAccumulated >= FlowControlConstants.CharCountAckSize && this._id !== undefined) {
				service.ackData(this._id, this._ackAccumulated);
				this._ackAccumulated = 0;
			}
		});
	}

	acceptReady(): void {
		// the pty produced its first data: nothing extra to do (the tab exists already)
	}

	acceptExit(exitCode: number, service: TerminalService): void {
		if (this._exited) {
			return;
		}
		this._exited = true;
		this._xterm.write(formatMessageForTerminal(`[exited with code ${exitCode}]`));
		this._xterm.options.disableStdin = true;
		this._onDidChangeTitle.fire();
		void service;
	}

	/** the pty host died under us: every terminal prints the real message and goes read-only */
	acceptHostDied(message: string, service: TerminalService): void {
		this.acceptExit(0, service);
		this._xterm.write(formatMessageForTerminal(message, { loudFormatting: true }));
	}

	private _scheduleResize(cols: number, rows: number): void {
		if (cols === this._lastCols && rows === this._lastRows) {
			return;
		}
		this._lastCols = cols;
		this._lastRows = rows;
		if (this._resizeTimer !== undefined) {
			clearTimeout(this._resizeTimer);
		}
		this._resizeTimer = setTimeout(() => {
			this._resizeTimer = undefined;
			if (this._id !== undefined && !this._exited) {
				this._service.resize(this._id, cols, rows);
			}
		}, RESIZE_DEBOUNCE_MS);
	}

	private _applyConfiguration(): void {
		const config = this._options.configuration;
		const fontSize = config.getValue<number>('terminal.integrated.fontSize') ?? (navigator.platform.startsWith('Mac') ? 12 : 14);
		const fontFamily = config.getValue<string>('terminal.integrated.fontFamily') || `Menlo, Monaco, 'Courier New', monospace`;
		const scrollback = config.getValue<number>('terminal.integrated.scrollback') ?? 1000;
		const cursorBlinking = config.getValue<boolean>('terminal.integrated.cursorBlinking') ?? false;
		const macOptionIsMeta = config.getValue<boolean>('terminal.integrated.macOptionIsMeta') ?? false;

		if (this._xterm.options.fontSize !== fontSize || this._xterm.options.fontFamily !== fontFamily) {
			this._xterm.options.fontSize = fontSize;
			this._xterm.options.fontFamily = fontFamily;
			this.fit();
		}
		// note: xterm resizes the buffer for scrollback; the existing content beyond the new
		// limit is trimmed (observed behavior; the real one documents the same)
		this._xterm.options.scrollback = scrollback;
		this._xterm.options.cursorBlink = cursorBlinking;
		this._xterm.options.macOptionIsMeta = macOptionIsMeta;
	}

	override dispose(): void {
		if (this._resizeTimer !== undefined) {
			clearTimeout(this._resizeTimer);
		}
		this._element.remove();
		super.dispose();
	}
}
