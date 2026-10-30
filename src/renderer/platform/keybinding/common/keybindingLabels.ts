// src/renderer/platform/keybinding/common/keybindingLabels.ts — how bindings render per platform.
// macOS: modifiers in ⌃⌥⇧⌘ order with symbols; other platforms spell out Ctrl+Alt+Shift+Win.
// Display (getLabel) and round-trip (getUserSettingsLabel) are separate on purpose — mirroring
// the reference's USLayoutResolvedKeybinding.

import { KeyCode } from './keyCodes.js';
import { KeyCodeChord, Keybinding } from './keybinding.js';

export const enum OperatingSystem {
	Windows = 0,
	Macintosh = 1,
	Linux = 2
}

export function getCurrentOS(): OperatingSystem {
	const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
	if (/Mac/i.test(ua)) {
		return OperatingSystem.Macintosh;
	}
	if (/Win/i.test(ua)) {
		return OperatingSystem.Windows;
	}
	return OperatingSystem.Linux;
}

const MAC_KEY_SYMBOLS = new Map<KeyCode, string>([
	[KeyCode.LeftArrow, '←'],
	[KeyCode.RightArrow, '→'],
	[KeyCode.UpArrow, '↑'],
	[KeyCode.DownArrow, '↓'],
	[KeyCode.Enter, '⏎'],
	[KeyCode.Escape, 'esc'],
	[KeyCode.Backspace, '⌫'],
	[KeyCode.Delete, '⌦'],
	[KeyCode.Tab, '⇥'],
	[KeyCode.PageUp, '⇞'],
	[KeyCode.PageDown, '⇟'],
	[KeyCode.Home, '↖'],
	[KeyCode.End, '↘'],
]);

function keyLabel(chord: KeyCodeChord, os: OperatingSystem): string {
	if (os === OperatingSystem.Macintosh) {
		const symbol = MAC_KEY_SYMBOLS.get(chord.keyCode);
		if (symbol) {
			return symbol;
		}
	}
	if (chord.keyCode >= KeyCode.KeyA && chord.keyCode <= KeyCode.KeyZ) {
		return String.fromCharCode('A'.charCodeAt(0) + (chord.keyCode - KeyCode.KeyA));
	}
	if (chord.keyCode >= KeyCode.Digit0 && chord.keyCode <= KeyCode.Digit9) {
		return String.fromCharCode('0'.charCodeAt(0) + (chord.keyCode - KeyCode.Digit0));
	}
	if (chord.keyCode >= KeyCode.F1 && chord.keyCode <= KeyCode.F24) {
		return `F${chord.keyCode - KeyCode.F1 + 1}`;
	}
	return chord.toString().split('+').pop()!;
}

/** the display label of one chord: '⌘K' on mac, 'Ctrl+K' elsewhere */
export function getChordLabel(chord: KeyCodeChord, os: OperatingSystem): string {
	if (os === OperatingSystem.Macintosh) {
		// mac modifier order: ⌃⌥⇧⌘ (control, option, shift, command)
		let result = '';
		if (chord.ctrl) {
			result += '⌃';
		}
		if (chord.alt) {
			result += '⌥';
		}
		if (chord.shift) {
			result += '⇧';
		}
		if (chord.meta) {
			result += '⌘';
		}
		return result + keyLabel(chord, os);
	}

	const parts: string[] = [];
	if (chord.ctrl) {
		parts.push('Ctrl');
	}
	if (chord.alt) {
		parts.push('Alt');
	}
	if (chord.shift) {
		parts.push('Shift');
	}
	if (chord.meta) {
		parts.push('Win');
	}
	parts.push(keyLabel(chord, os));
	return parts.join('+');
}

/** display for the whole (possibly multi-chord) binding: '⌘K ⌘S' */
export function getLabel(binding: Keybinding, os: OperatingSystem): string {
	return binding.chords.map(chord => getChordLabel(chord, os)).join(' ');
}

/** the keybindings.json format — round-trips through parseKeybinding */
export function getUserSettingsLabel(binding: Keybinding): string {
	return binding.toString();
}

/** screen-reader spelling, e.g. '⌘K ⌘A' → 'Command K Command A' */
export function getAriaLabel(binding: Keybinding, os: OperatingSystem): string {
	const chordLabels: string[] = [];
	for (const chord of binding.chords) {
		const parts: string[] = [];
		if (os === OperatingSystem.Macintosh) {
			if (chord.ctrl) {
				parts.push('Control');
			}
			if (chord.alt) {
				parts.push('Option');
			}
			if (chord.shift) {
				parts.push('Shift');
			}
			if (chord.meta) {
				parts.push('Command');
			}
		} else {
			if (chord.ctrl) {
				parts.push('Control');
			}
			if (chord.alt) {
				parts.push('Alt');
			}
			if (chord.shift) {
				parts.push('Shift');
			}
			if (chord.meta) {
				parts.push('Windows');
			}
		}
		parts.push(keyLabel(chord, os));
		chordLabels.push(parts.join(' '));
	}
	return chordLabels.join(' ');
}
