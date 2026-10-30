// src/renderer/platform/keybinding/common/keyCodes.ts — KeyCode/KeyMod values copied from
// vs/base/common/keyCodes.ts; the numeric values are part of keybindings.json compatibility.
//
// shortcut: no ScanCode split and no keyboard-layout service — we resolve against `event.code`
// (US layout). Upstream ships a generated scanner table for layout independence; that is the
// delta documented in the exercise.

export const enum KeyMod {
	CtrlCmd = (1 << 11) >>> 0, // 2048
	Shift = (1 << 10) >>> 0,   // 1024
	Alt = (1 << 9) >>> 0,      // 512
	WinCtrl = (1 << 8) >>> 0,  // 256
}

export const enum KeyCode {
	DependsOnKbLayout = -1,

	Unknown = 0,
	Backspace,
	Tab,
	Enter,
	Shift,
	Ctrl,
	Alt,
	PauseBreak,
	CapsLock,
	Escape,
	Space,
	PageUp,
	PageDown,
	End,
	Home,
	LeftArrow,
	UpArrow,
	RightArrow,
	DownArrow,
	Insert,
	Delete,

	Digit0,
	Digit1,
	Digit2,
	Digit3,
	Digit4,
	Digit5,
	Digit6,
	Digit7,
	Digit8,
	Digit9,

	KeyA,
	KeyB,
	KeyC,
	KeyD,
	KeyE,
	KeyF,
	KeyG,
	KeyH,
	KeyI,
	KeyJ,
	KeyK,
	KeyL,
	KeyM,
	KeyN,
	KeyO,
	KeyP,
	KeyQ,
	KeyR,
	KeyS,
	KeyT,
	KeyU,
	KeyV,
	KeyW,
	KeyX,
	KeyY,
	KeyZ,

	Meta,
	ContextMenu,

	F1,
	F2,
	F3,
	F4,
	F5,
	F6,
	F7,
	F8,
	F9,
	F10,
	F11,
	F12,
	F13,
	F14,
	F15,
	F16,
	F17,
	F18,
	F19,
	F20,
	F21,
	F22,
	F23,
	F24,

	NumLock,
	ScrollLock,
	Semicolon,
	Equal,
	Comma,
	Minus,
	Period,
	Slash,
	Backquote,
	BracketLeft,
	Backslash,
	BracketRight,
	Quote,
	OEM_8,
	Numpad0,
	Numpad1,
	Numpad2,
	Numpad3,
	Numpad4,
	Numpad5,
	Numpad6,
	Numpad7,
	Numpad8,
	Numpad9,
	NumpadMultiply,
	NumpadAdd,
	NumpadSeparator,
	NumpadSubtract,
	NumpadDecimal,
	NumpadDivide,
}

export function KeyChord(firstPart: number, secondPart: number): number {
	const chordPart = ((secondPart & 0x0000ffff) << 16) >>> 0;
	return (firstPart | chordPart) >>> 0;
}

export function isModifierKey(keyCode: KeyCode): boolean {
	return (
		keyCode === KeyCode.Ctrl
		|| keyCode === KeyCode.Shift
		|| keyCode === KeyCode.Alt
		|| keyCode === KeyCode.Meta
	);
}

// ---- names: the user-settings strings ("cmd+shift+p", "escape") and display names

// KeyCodeUtils.toString outputs; fromUserSettings accepts these lowercased plus aliases
const SPECIAL_KEY_LABELS: Array<[KeyCode, string]> = [
	[KeyCode.Backspace, 'Backspace'],
	[KeyCode.Tab, 'Tab'],
	[KeyCode.Enter, 'Enter'],
	[KeyCode.Escape, 'Escape'],
	[KeyCode.Space, 'Space'],
	[KeyCode.PageUp, 'PageUp'],
	[KeyCode.PageDown, 'PageDown'],
	[KeyCode.End, 'End'],
	[KeyCode.Home, 'Home'],
	[KeyCode.LeftArrow, 'LeftArrow'],
	[KeyCode.UpArrow, 'UpArrow'],
	[KeyCode.RightArrow, 'RightArrow'],
	[KeyCode.DownArrow, 'DownArrow'],
	[KeyCode.Insert, 'Insert'],
	[KeyCode.Delete, 'Delete'],
	[KeyCode.Semicolon, ';'],
	[KeyCode.Equal, '='],
	[KeyCode.Comma, ','],
	[KeyCode.Minus, '-'],
	[KeyCode.Period, '.'],
	[KeyCode.Slash, '/'],
	[KeyCode.Backquote, '`'],
	[KeyCode.BracketLeft, '['],
	[KeyCode.Backslash, '\\'],
	[KeyCode.BracketRight, ']'],
	[KeyCode.Quote, '\''],
	[KeyCode.Numpad0, 'Numpad0'],
	[KeyCode.Numpad1, 'Numpad1'],
	[KeyCode.Numpad2, 'Numpad2'],
	[KeyCode.Numpad3, 'Numpad3'],
	[KeyCode.Numpad4, 'Numpad4'],
	[KeyCode.Numpad5, 'Numpad5'],
	[KeyCode.Numpad6, 'Numpad6'],
	[KeyCode.Numpad7, 'Numpad7'],
	[KeyCode.Numpad8, 'Numpad8'],
	[KeyCode.Numpad9, 'Numpad9'],
	[KeyCode.NumpadMultiply, 'NumpadMultiply'],
	[KeyCode.NumpadAdd, 'NumpadAdd'],
	[KeyCode.NumpadSubtract, 'NumpadSubtract'],
	[KeyCode.NumpadDecimal, 'NumpadDecimal'],
	[KeyCode.NumpadDivide, 'NumpadDivide'],
];

const keyCodeToStr = new Map<KeyCode, string>();
const strToKeyCode = new Map<string, KeyCode>();

for (let i = 0; i <= 9; i++) {
	keyCodeToStr.set(KeyCode.Digit0 + i, String(i));
}
for (let i = 0; i < 26; i++) {
	keyCodeToStr.set(KeyCode.KeyA + i, String.fromCharCode('A'.charCodeAt(0) + i));
}
for (let i = 0; i <= 23; i++) {
	keyCodeToStr.set(KeyCode.F1 + i, `F${i + 1}`);
}
for (const [keyCode, label] of SPECIAL_KEY_LABELS) {
	keyCodeToStr.set(keyCode, label);
}

// user-settings aliases, mirroring the reference's userSettingsUSMap + KEY_CODE_ALIASES spirit
const USER_SETTINGS_ALIASES: Array<[string, KeyCode]> = [
	['esc', KeyCode.Escape],
	['escape', KeyCode.Escape],
	['return', KeyCode.Enter],
	['enter', KeyCode.Enter],
	['space', KeyCode.Space],
	['backspace', KeyCode.Backspace],
	['tab', KeyCode.Tab],
	['del', KeyCode.Delete],
	['delete', KeyCode.Delete],
	['ins', KeyCode.Insert],
	['insert', KeyCode.Insert],
	['home', KeyCode.Home],
	['end', KeyCode.End],
	['pgup', KeyCode.PageUp],
	['pageup', KeyCode.PageUp],
	['pgdn', KeyCode.PageDown],
	['pagedown', KeyCode.PageDown],
	['left', KeyCode.LeftArrow],
	['leftarrow', KeyCode.LeftArrow],
	['right', KeyCode.RightArrow],
	['rightarrow', KeyCode.RightArrow],
	['up', KeyCode.UpArrow],
	['uparrow', KeyCode.UpArrow],
	['down', KeyCode.DownArrow],
	['downarrow', KeyCode.DownArrow],
	['minus', KeyCode.Minus],
	['equal', KeyCode.Equal],
	['comma', KeyCode.Comma],
	['period', KeyCode.Period],
	['dot', KeyCode.Period],
	['slash', KeyCode.Slash],
	['backquote', KeyCode.Backquote],
	['backslash', KeyCode.Backslash],
	['semicolon', KeyCode.Semicolon],
	['quote', KeyCode.Quote],
	['bracketleft', KeyCode.BracketLeft],
	['bracketright', KeyCode.BracketRight],
	['numpadmultiply', KeyCode.NumpadMultiply],
	['numpadadd', KeyCode.NumpadAdd],
	['numpadsubtract', KeyCode.NumpadSubtract],
	['numpaddecimal', KeyCode.NumpadDecimal],
	['numpaddivide', KeyCode.NumpadDivide],
];

for (const [keyCode, label] of keyCodeToStr) {
	strToKeyCode.set(label.toLowerCase(), keyCode);
}
for (let i = 0; i < 26; i++) {
	strToKeyCode.set(String.fromCharCode('a'.charCodeAt(0) + i), KeyCode.KeyA + i);
}
for (const [alias, keyCode] of USER_SETTINGS_ALIASES) {
	strToKeyCode.set(alias, keyCode);
}

export namespace KeyCodeUtils {

	/** display/round-trip name: 'A', '1', 'F5', 'Escape', '-' */
	export function toString(keyCode: KeyCode): string {
		return keyCodeToStr.get(keyCode) ?? `Unknown${keyCode}`;
	}

	export function fromUserSettings(key: string): KeyCode {
		return strToKeyCode.get(key.trim().toLowerCase()) ?? KeyCode.Unknown;
	}

	export function toUserSettingsUS(keyCode: KeyCode): string {
		return toString(keyCode);
	}
}

// ---- KeyboardEvent → KeyCode (event.code preferred; event.keyCode only as the ancient fallback)

const CODE_TO_KEY_CODE = new Map<string, KeyCode>([
	['Backspace', KeyCode.Backspace],
	['Tab', KeyCode.Tab],
	['Enter', KeyCode.Enter],
	['Escape', KeyCode.Escape],
	['Space', KeyCode.Space],
	['PageUp', KeyCode.PageUp],
	['PageDown', KeyCode.PageDown],
	['End', KeyCode.End],
	['Home', KeyCode.Home],
	['Insert', KeyCode.Insert],
	['Delete', KeyCode.Delete],
	['ArrowLeft', KeyCode.LeftArrow],
	['ArrowUp', KeyCode.UpArrow],
	['ArrowRight', KeyCode.RightArrow],
	['ArrowDown', KeyCode.DownArrow],
	['Minus', KeyCode.Minus],
	['Equal', KeyCode.Equal],
	['Comma', KeyCode.Comma],
	['Period', KeyCode.Period],
	['Slash', KeyCode.Slash],
	['Backquote', KeyCode.Backquote],
	['BracketLeft', KeyCode.BracketLeft],
	['Backslash', KeyCode.Backslash],
	['BracketRight', KeyCode.BracketRight],
	['Semicolon', KeyCode.Semicolon],
	['Quote', KeyCode.Quote],
	['NumpadMultiply', KeyCode.NumpadMultiply],
	['NumpadAdd', KeyCode.NumpadAdd],
	['NumpadSubtract', KeyCode.NumpadSubtract],
	['NumpadDecimal', KeyCode.NumpadDecimal],
	['NumpadDivide', KeyCode.NumpadDivide],
]);

/** the deprecated event.keyCode fallback for events without a usable `code` */
const LEGACY_KEY_CODE: { [keyCode: number]: KeyCode } = {
	8: KeyCode.Backspace, 9: KeyCode.Tab, 13: KeyCode.Enter, 27: KeyCode.Escape, 32: KeyCode.Space,
	33: KeyCode.PageUp, 34: KeyCode.PageDown, 35: KeyCode.End, 36: KeyCode.Home,
	37: KeyCode.LeftArrow, 38: KeyCode.UpArrow, 39: KeyCode.RightArrow, 40: KeyCode.DownArrow,
	45: KeyCode.Insert, 46: KeyCode.Delete,
	186: KeyCode.Semicolon, 187: KeyCode.Equal, 188: KeyCode.Comma, 189: KeyCode.Minus,
	190: KeyCode.Period, 191: KeyCode.Slash, 192: KeyCode.Backquote,
	219: KeyCode.BracketLeft, 220: KeyCode.Backslash, 221: KeyCode.BracketRight, 222: KeyCode.Quote,
};

export function eventToKeyCode(e: KeyboardEvent): KeyCode {
	const code = e.code;

	const match = code.match(/^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|F([1-9]|1[0-9]|2[0-4]))$/);
	if (match) {
		if (code.startsWith('Key')) {
			return KeyCode.KeyA + (code.charCodeAt(3) - 'A'.charCodeAt(0));
		}
		if (code.startsWith('Digit')) {
			return KeyCode.Digit0 + (code.charCodeAt(5) - '0'.charCodeAt(0));
		}
		if (code.startsWith('Numpad') && code.length === 7) {
			return KeyCode.Numpad0 + (code.charCodeAt(6) - '0'.charCodeAt(0));
		}
		if (code.startsWith('F')) {
			return KeyCode.F1 + (parseInt(code.substring(1), 10) - 1);
		}
	}

	const mapped = CODE_TO_KEY_CODE.get(code);
	if (mapped !== undefined) {
		return mapped;
	}

	// fallback for ancient paths only — event.keyCode lies on non-US layouts
	const legacy = e.keyCode;
	if (legacy >= 65 && legacy <= 90) {
		return KeyCode.KeyA + (legacy - 65);
	}
	if (legacy >= 48 && legacy <= 57) {
		return KeyCode.Digit0 + (legacy - 48);
	}
	if (legacy >= 112 && legacy <= 123) {
		return KeyCode.F1 + (legacy - 112);
	}
	return LEGACY_KEY_CODE[legacy] ?? KeyCode.Unknown;
}
