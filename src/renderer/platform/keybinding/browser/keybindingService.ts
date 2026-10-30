// src/renderer/platform/keybinding/browser/keybindingService.ts — the dispatcher: one capture-phase
// keydown listener, chord state machine, and the preventDefault policy. Ported in spirit from
// vs/workbench/services/keybinding/browser/keybindingService.ts (the _dispatch contract).

import { addDisposableListener } from '../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../common/base/common/event.js';
import { Disposable } from '../../../../common/base/common/lifecycle.js';
import type { ILogService } from '../../../../common/platform/log/common/log.js';
import type { IContextKeyService } from '../../contextkey/common/contextkey.js';
import type { ICommandService } from '../../commands/common/commands.js';
import { KeyCode, eventToKeyCode, isModifierKey } from '../common/keyCodes.js';
import { KeyCodeChord, Keybinding } from '../common/keybinding.js';
import { getLabel, OperatingSystem } from '../common/keybindingLabels.js';
import { parseKeybinding } from '../common/keybindingParser.js';
import { getDefaultKeybindings, IKeybindingItem } from '../common/keybindingsRegistry.js';
import { KeybindingResolver, ResolvedKeybindingItem } from '../common/keybindingResolver.js';

export function eventToChord(e: KeyboardEvent): KeyCodeChord | null {
	const keyCode = eventToKeyCode(e);
	if (keyCode === KeyCode.Unknown || isModifierKey(keyCode)) {
		return null; // modifier-only presses never form a chord here (single-modifier chords are a delta)
	}
	return new KeyCodeChord(e.ctrlKey, e.shiftKey, e.altKey, e.metaKey, keyCode);
}

export class KeybindingService extends Disposable {

	private _resolver: KeybindingResolver;
	private _currentChords: string[] = [];
	private _userKeybindings: IKeybindingItem[] = [];

	private readonly _onDidChangeChordState = this._register(new Emitter<void>());
	/** fires while a chord is pending and when it resolves/cancels — drives the status bar */
	readonly onDidChangeChordState: Event<void> = this._onDidChangeChordState.event;

	constructor(
		private readonly _commandService: ICommandService,
		private readonly _contextKeyService: IContextKeyService,
		private readonly _logService: ILogService,
		private readonly _os: OperatingSystem
	) {
		super();

		this._resolver = this._buildResolver();

		// we listen on keydown ONLY, deliberately: users hold the modifier between the two parts
		// of a chord. On some platforms (Windows) a keyup arrives between the two keydowns —
		// clearing chord state on keyup would silently reset the pending chord. (The reference
		// listens on keyup only for single-modifier chords such as `shift shift`, which are a
		// delta here.)
		this._register(addDisposableListener(window, 'keydown', (e: KeyboardEvent) => this._handleKeydown(e), true));
	}

	setUserKeybindings(items: readonly IKeybindingItem[]): void {
		this._userKeybindings = [...items];
		this._resolver = this._buildResolver();
		this._cancelChord();
	}

	/** re-reads the registry defaults (used when a rule is registered after startup) */
	rebuild(): void {
		this._resolver = this._buildResolver();
	}

	/** display label of the pending chord(s): '⌘K' — undefined when no chord is pending */
	get pendingChordLabel(): string | undefined {
		if (this._currentChords.length === 0) {
			return undefined;
		}
		const binding: Keybinding | null = parseKeybinding(this._currentChords.join(' '));
		return binding ? getLabel(binding, this._os) : this._currentChords.join(' ');
	}

	/** for tests/dev: resolve without a DOM event */
	resolveKeypress(currentChords: string[], keypress: string) {
		return this._resolver.resolve(this._contextKeyService, currentChords, keypress);
	}

	private _buildResolver(): KeybindingResolver {
		const defaults = getDefaultKeybindings(this._os).map(item => ResolvedKeybindingItem.fromItem(item));

		// a user binding for a command rebinds it: drop that command's *unconditional* default
		// bindings, so the old key goes dead immediately
		// shortcut: upstream keeps defaults alive and requires an explicit `-commandId` removal
		// entry; the course's rebind-wins expectation is simpler and lives here
		const reboundCommands = new Set(this._userKeybindings.filter(item => !item.when).map(item => item.command));
		const effectiveDefaults = defaults.filter(item => !(reboundCommands.has(item.command) && !item.when));

		return new KeybindingResolver(
			effectiveDefaults,
			this._userKeybindings.map(item => ResolvedKeybindingItem.fromItem(item))
		);
	}

	private _cancelChord(): void {
		if (this._currentChords.length > 0) {
			this._currentChords = [];
			this._onDidChangeChordState.fire();
		}
	}

	private _handleKeydown(e: KeyboardEvent): void {
		// Escape during a pending chord cancels it — real behavior, and it consumes the key
		if (this._currentChords.length > 0 && e.key === 'Escape') {
			this._cancelChord();
			e.preventDefault();
			return;
		}

		const chord = eventToChord(e);
		if (!chord) {
			return;
		}

		const chordString = chord.toString();
		const resolution = this._resolver.resolve(this._contextKeyService, this._currentChords, chordString);

		if (resolution.enterChord) {
			// a chord was entered: remember it, show the pending state, consume the keypress
			this._currentChords.push(chordString);
			this._onDidChangeChordState.fire();
			e.preventDefault();
			return;
		}

		if (!resolution.commandId) {
			// nothing claimed this keypress: cancel a pending chord silently, and — importantly —
			// do NOT preventDefault, so typing keeps flowing into inputs
			this._cancelChord();
			return;
		}

		// a command claimed the keypress: clear the chord state, consume the event even when the
		// focus sits in a textarea (otherwise `cmd+b` would toggle bold instead of the sidebar)
		this._cancelChord();
		e.preventDefault();

		void this._commandService
			.executeCommand(resolution.commandId, ...(resolution.commandArgs !== undefined ? [resolution.commandArgs] : []))
			.catch(error => this._logService.error(`keybinding command '${resolution.commandId}' failed: ${(error as Error).message}`));
	}
}
