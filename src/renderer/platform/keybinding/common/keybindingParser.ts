// src/renderer/platform/keybinding/common/keybindingParser.ts — ported from
// vs/base/common/keybindingParser.ts. `"cmd+k cmd+s"` parses into two chords; modifiers accept
// the reference's aliases (ctrl/shift/alt/meta/win/cmd with '+' or '-'); unknown keys fail.
//
// The key-name aliases ('esc', 'return', 'left', …) live in keyCodes.ts (KEY_CODE_ALIASES'
// modern home is the user-settings map there — same idea, ported with the parser).

import { KeyCode, KeyCodeUtils } from './keyCodes.js';
import { KeyCodeChord, Keybinding } from './keybinding.js';

export class KeybindingParser {

	private static _readModifiers(input: string): { remains: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean; key: string } {
		input = input.toLowerCase().trim();

		let ctrl = false;
		let shift = false;
		let alt = false;
		let meta = false;

		let matchedModifier: boolean;
		do {
			matchedModifier = false;
			if (/^ctrl(\+|\-)/.test(input)) {
				ctrl = true;
				input = input.substring('ctrl-'.length);
				matchedModifier = true;
			}
			if (/^shift(\+|\-)/.test(input)) {
				shift = true;
				input = input.substring('shift-'.length);
				matchedModifier = true;
			}
			if (/^alt(\+|\-)/.test(input)) {
				alt = true;
				input = input.substring('alt-'.length);
				matchedModifier = true;
			}
			if (/^meta(\+|\-)/.test(input)) {
				meta = true;
				input = input.substring('meta-'.length);
				matchedModifier = true;
			}
			if (/^win(\+|\-)/.test(input)) {
				meta = true;
				input = input.substring('win-'.length);
				matchedModifier = true;
			}
			if (/^cmd(\+|\-)/.test(input)) {
				meta = true;
				input = input.substring('cmd-'.length);
				matchedModifier = true;
			}
		} while (matchedModifier);

		let key: string;
		const firstSpaceIdx = input.indexOf(' ');
		if (firstSpaceIdx > 0) {
			key = input.substring(0, firstSpaceIdx);
			input = input.substring(firstSpaceIdx);
		} else {
			key = input;
			input = '';
		}

		return { remains: input, ctrl, shift, alt, meta, key };
	}

	private static parseChord(input: string): [KeyCodeChord | null, string] {
		const mods = this._readModifiers(input);
		const keyCode = KeyCodeUtils.fromUserSettings(mods.key);
		if (keyCode === KeyCode.Unknown) {
			return [null, mods.remains];
		}
		return [new KeyCodeChord(mods.ctrl, mods.shift, mods.alt, mods.meta, keyCode), mods.remains];
	}

	static parseKeybinding(input: string): Keybinding | null {
		if (!input) {
			return null;
		}

		const chords: KeyCodeChord[] = [];
		while (input.length > 0) {
			const [chord, remains] = this.parseChord(input);
			if (!chord) {
				return null; // unknown key fragment — the whole binding fails
			}
			chords.push(chord);
			input = remains.trim();
		}
		return chords.length > 0 ? new Keybinding(chords) : null;
	}
}

export function parseKeybinding(input: string): Keybinding | null {
	return KeybindingParser.parseKeybinding(input);
}
