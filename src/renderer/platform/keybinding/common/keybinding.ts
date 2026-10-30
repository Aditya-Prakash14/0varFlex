// src/renderer/platform/keybinding/common/keybinding.ts — Keybinding + ResolvedKeybinding shapes.

import { KeyCode, KeyCodeUtils } from './keyCodes.js';

export class KeyCodeChord {

	constructor(
		readonly ctrl: boolean,
		readonly shift: boolean,
		readonly alt: boolean,
		readonly meta: boolean,
		readonly keyCode: KeyCode
	) { }

	/**
	 * canonical round-trip string: 'cmd+shift+p', 'ctrl+k', 'f1' — modifier order ctrl, cmd,
	 * shift, alt (the course's convention; the parser accepts any order)
	 */
	toString(): string {
		let result = '';
		if (this.ctrl) {
			result += 'ctrl+';
		}
		if (this.meta) {
			result += 'cmd+';
		}
		if (this.shift) {
			result += 'shift+';
		}
		if (this.alt) {
			result += 'alt+';
		}
		result += KeyCodeUtils.toUserSettingsUS(this.keyCode).toLowerCase();
		return result;
	}

	equals(other: KeyCodeChord): boolean {
		return this.keyCode === other.keyCode
			&& this.ctrl === other.ctrl
			&& this.shift === other.shift
			&& this.alt === other.alt
			&& this.meta === other.meta;
	}
}

export class Keybinding {

	readonly chords: KeyCodeChord[];

	constructor(chords: KeyCodeChord[]) {
		if (chords.length < 1) {
			throw new Error('chords must have at least one element');
		}
		this.chords = chords;
	}

	/** 'cmd+k cmd+a' */
	toString(): string {
		return this.chords.map(chord => chord.toString()).join(' ');
	}

	equals(other: Keybinding): boolean {
		return this.chords.length === other.chords.length
			&& this.chords.every((chord, index) => chord.equals(other.chords[index]));
	}
}

/**
 * A keybinding resolved for a specific platform — the label layer's input.
 */
export class ResolvedKeybinding {

	constructor(readonly binding: Keybinding) { }

	/** the chord strings the dispatcher matches against: ['cmd+k', 'cmd+a'] */
	getDispatchChords(): string[] {
		return this.binding.chords.map(chord => chord.toString());
	}
}
