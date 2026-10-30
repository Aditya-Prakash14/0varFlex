// Keybinding resolution: the resolver table (weight, when-specificity, user-vs-default, chords),
// parser round-trips, platform labels and event → KeyCode conversion.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ContextKeyExpr, ContextKeyExpression } from '../src/renderer/platform/contextkey/common/contextkey.js';
import { eventToKeyCode, KeyChord, KeyCode, KeyMod } from '../src/renderer/platform/keybinding/common/keyCodes.js';
import { getUserSettingsLabel, getAriaLabel, getLabel, OperatingSystem } from '../src/renderer/platform/keybinding/common/keybindingLabels.js';
import { parseKeybinding } from '../src/renderer/platform/keybinding/common/keybindingParser.js';
import { decodeKeybinding, getDefaultKeybindings, IKeybindingItem, KeybindingsRegistry, KeybindingWeight } from '../src/renderer/platform/keybinding/common/keybindingsRegistry.js';
import { KeybindingResolver, ResolvedKeybindingItem } from '../src/renderer/platform/keybinding/common/keybindingResolver.js';
import { eventToChord } from '../src/renderer/platform/keybinding/browser/keybindingService.js';

const MAC = OperatingSystem.Macintosh;

function item(key: string, command: string, options: { weight?: number; when?: ContextKeyExpression; isDefault?: boolean; index?: number } = {}): IKeybindingItem {
	const keybinding = parseKeybinding(key);
	assert.ok(keybinding, `test setup: '${key}' must parse`);
	return {
		keybinding: keybinding!,
		command,
		commandArgs: undefined,
		when: options.when,
		weight: options.weight ?? KeybindingWeight.WorkbenchContrib,
		isDefault: options.isDefault ?? true,
		registrationIndex: options.index ?? 0
	};
}

function resolveWith(items: IKeybindingItem[], contextValues: Record<string, unknown>, currentChords: string[], keypress: string) {
	const resolver = new KeybindingResolver(items.map(entry => ResolvedKeybindingItem.fromItem(entry)), []);
	return resolver.resolve({ getValue: <T,>(key: string) => contextValues[key] as T | undefined }, currentChords, keypress);
}

test('resolver: plain match', () => {
	const result = resolveWith([item('cmd+b', 'cmd.a')], {}, [], 'cmd+b');
	assert.equal(result.commandId, 'cmd.a');
	assert.equal(result.enterChord, false);
});

test('resolver: when false falls through to a lower-weight rule', () => {
	const items = [
		item('cmd+b', 'high.weight', { weight: 200, when: ContextKeyExpr.has('flag') }),
		item('cmd+b', 'lower.weight', { weight: 100 })
	];
	assert.equal(resolveWith(items, {}, [], 'cmd+b').commandId, 'lower.weight');
	assert.equal(resolveWith(items, { flag: true }, [], 'cmd+b').commandId, 'high.weight');
});

test('resolver: user override beats a default with the same key', () => {
	const items = [
		item('cmd+b', 'builtin', { isDefault: true }),
		item('cmd+b', 'from.user', { isDefault: false })
	];
	assert.equal(resolveWith(items, {}, [], 'cmd+b').commandId, 'from.user');
});

test('resolver: two defaults, higher weight wins', () => {
	const items = [
		item('cmd+b', 'light', { weight: 100, index: 1 }),
		item('cmd+b', 'heavy', { weight: 200, index: 0 })
	];
	assert.equal(resolveWith(items, {}, [], 'cmd+b').commandId, 'heavy');
});

test('resolver: first chord enters a chord instead of firing a command', () => {
	const result = resolveWith([item('cmd+k cmd+a', 'chord.a', { weight: 300 })], {}, [], 'cmd+k');
	assert.equal(result.enterChord, true);
	assert.equal(result.commandId, undefined);
});

test('resolver: second chord resolves the command', () => {
	const result = resolveWith([item('cmd+k cmd+a', 'chord.a', { weight: 300 })], {}, ['cmd+k'], 'cmd+a');
	assert.equal(result.enterChord, false);
	assert.equal(result.commandId, 'chord.a');
});

test('resolver: wrong second chord matches nothing', () => {
	const result = resolveWith([item('cmd+k cmd+a', 'chord.a', { weight: 300 })], {}, ['cmd+k'], 'cmd+z');
	assert.equal(result.enterChord, false);
	assert.equal(result.commandId, undefined);
});

test('resolver: when flips between two same-key bindings', () => {
	const items = [
		item('cmd+b', 'when.flag', { when: ContextKeyExpr.has('flag'), index: 0 }),
		item('cmd+b', 'when.not.flag', { when: ContextKeyExpr.not('flag'), index: 1 })
	];
	assert.equal(resolveWith(items, { flag: true }, [], 'cmd+b').commandId, 'when.flag');
	assert.equal(resolveWith(items, {}, [], 'cmd+b').commandId, 'when.not.flag');
});

test('resolver: wrong first chord matches nothing', () => {
	const result = resolveWith([item('cmd+k cmd+a', 'chord.a', { weight: 300 })], {}, ['cmd+b'], 'cmd+a');
	assert.equal(result.commandId, undefined);
	assert.equal(result.enterChord, false);
});

test('resolver: a higher-weight single binding beats a lower-weight chord on the same first key', () => {
	const single = item('cmd+k', 'single', { weight: 400 });
	const chord = item('cmd+k cmd+a', 'chord.a', { weight: 300 });
	assert.equal(resolveWith([single, chord], {}, [], 'cmd+k').commandId, 'single');

	const lowSingle = item('cmd+k', 'single', { weight: 100 });
	const highChord = item('cmd+k cmd+a', 'chord.a', { weight: 300 });
	assert.equal(resolveWith([lowSingle, highChord], {}, [], 'cmd+k').enterChord, true);
});

test('resolver: later registration wins on a full tie', () => {
	const items = [
		item('cmd+b', 'first', { index: 0 }),
		item('cmd+b', 'second', { index: 1 })
	];
	assert.equal(resolveWith(items, {}, [], 'cmd+b').commandId, 'second');
});

test('resolver: the more specific when clause wins when both match', () => {
	const items = [
		item('cmd+b', 'specific', { when: ContextKeyExpr.has('flag'), index: 0 }),
		item('cmd+b', 'general', { index: 1 })
	];
	assert.equal(resolveWith(items, { flag: true }, [], 'cmd+b').commandId, 'specific');
	assert.equal(resolveWith(items, {}, [], 'cmd+b').commandId, 'general');
});

test('parser: getUserSettingsLabel round-trips through parseKeybinding', () => {
	const bindings = [
		'cmd+p', 'ctrl+shift+p', 'alt+enter', 'cmd+k cmd+s', 'f1', 'shift+f5', 'cmd+b',
		'ctrl+cmd+f', 'escape', 'shift+alt+f', 'cmd+alt+p', 'ctrl+j', 'cmd+\\', 'cmd+-',
		'cmd+=', 'cmd+[', 'cmd+]', 'cmd+;', 'cmd+\'', 'cmd+k cmd+a', 'pagedown', 'cmd+numpadadd'
	];
	for (const input of bindings) {
		const parsed = parseKeybinding(input);
		assert.ok(parsed, `'${input}' must parse`);
		const label = getUserSettingsLabel(parsed!);
		const reparsed = parseKeybinding(label);
		assert.ok(reparsed, `label '${label}' must reparse`);
		assert.deepEqual(reparsed!.chords.map(c => c.toString()), parsed!.chords.map(c => c.toString()), `round trip for '${input}'`);
	}
});

test('parser: unknown fragments fail', () => {
	assert.equal(parseKeybinding('cmd+notakey'), null);
	assert.equal(parseKeybinding(''), null);
});

test('labels: mac symbols and modifier order, other platforms spelled out', () => {
	assert.equal(getLabel(parseKeybinding('cmd+k cmd+s')!, MAC), '⌘K ⌘S');
	assert.equal(getLabel(parseKeybinding('ctrl+shift+p')!, MAC), '⌃⇧P');
	assert.equal(getLabel(parseKeybinding('alt+enter')!, MAC), '⌥⏎');
	assert.equal(getLabel(parseKeybinding('cmd+b')!, MAC), '⌘B');
	assert.equal(getLabel(parseKeybinding('ctrl+cmd+f')!, MAC), '⌃⌘F');
	assert.equal(getLabel(parseKeybinding('ctrl+shift+p')!, OperatingSystem.Windows), 'Ctrl+Shift+P');
	assert.equal(getLabel(parseKeybinding('cmd+b')!, OperatingSystem.Windows), 'Win+B');
});

test('labels: aria spelling for screen readers', () => {
	assert.equal(getAriaLabel(parseKeybinding('cmd+k cmd+a')!, MAC), 'Command K Command A');
});

test('registry: packed codes decode per platform', () => {
	assert.equal(decodeKeybinding(KeyMod.CtrlCmd | KeyCode.KeyB, MAC)!.toString(), 'cmd+b');
	assert.equal(decodeKeybinding(KeyMod.CtrlCmd | KeyCode.KeyB, OperatingSystem.Windows)!.toString(), 'ctrl+b');
	assert.equal(decodeKeybinding(KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyF, MAC)!.toString(), 'ctrl+cmd+f');
	assert.equal(decodeKeybinding(KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyA), MAC)!.toString(), 'cmd+k cmd+a');
});

test('registry: getDefaultKeybindings expands platform overrides and secondaries', () => {
	const disposable = KeybindingsRegistry.registerKeybindingRule({
		id: 'test.registry.binding',
		weight: KeybindingWeight.WorkbenchContrib,
		primary: KeyMod.CtrlCmd | KeyCode.KeyP,
		secondary: [KeyCode.F1],
		mac: KeyMod.CtrlCmd | KeyCode.KeyQ
	});
	try {
		const macItems = getDefaultKeybindings(MAC).filter(entry => entry.command === 'test.registry.binding');
		assert.deepEqual(macItems.map(entry => entry.keybinding.toString()).sort(), ['cmd+q', 'f1']);
		const winItems = getDefaultKeybindings(OperatingSystem.Windows).filter(entry => entry.command === 'test.registry.binding');
		assert.deepEqual(winItems.map(entry => entry.keybinding.toString()).sort(), ['ctrl+p', 'f1']);
	} finally {
		disposable.dispose();
	}
});

test('eventToKeyCode: event.code mapping for 20 keys', () => {
	const codeCases: Array<[string, KeyCode]> = [
		['KeyA', KeyCode.KeyA], ['KeyM', KeyCode.KeyM], ['KeyZ', KeyCode.KeyZ],
		['Digit1', KeyCode.Digit1], ['Digit9', KeyCode.Digit9],
		['F1', KeyCode.F1], ['F12', KeyCode.F12],
		['Minus', KeyCode.Minus], ['Equal', KeyCode.Equal], ['Comma', KeyCode.Comma], ['Period', KeyCode.Period],
		['Slash', KeyCode.Slash], ['Backquote', KeyCode.Backquote], ['Backslash', KeyCode.Backslash],
		['Semicolon', KeyCode.Semicolon], ['Quote', KeyCode.Quote], ['BracketLeft', KeyCode.BracketLeft], ['BracketRight', KeyCode.BracketRight],
		['ArrowLeft', KeyCode.LeftArrow], ['Enter', KeyCode.Enter], ['Escape', KeyCode.Escape], ['Space', KeyCode.Space],
		['Backspace', KeyCode.Backspace], ['Tab', KeyCode.Tab], ['PageUp', KeyCode.PageUp], ['PageDown', KeyCode.PageDown],
		['Home', KeyCode.Home], ['End', KeyCode.End], ['Insert', KeyCode.Insert], ['Delete', KeyCode.Delete],
		['Numpad5', KeyCode.Numpad5]
	];
	for (const [code, expected] of codeCases) {
		const fake = { code, keyCode: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false } as unknown as KeyboardEvent;
		assert.equal(eventToKeyCode(fake), expected, `code '${code}'`);
	}
});

test('eventToChord: modifiers to canonical chord strings; modifier-only presses produce no chord', () => {
	const fake = (code: string, mods: Partial<KeyboardEvent>): KeyboardEvent =>
		({ code, keyCode: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods } as unknown as KeyboardEvent);

	assert.equal(eventToChord(fake('KeyP', { metaKey: true, shiftKey: true }))!.toString(), 'cmd+shift+p');
	assert.equal(eventToChord(fake('KeyB', { metaKey: true }))!.toString(), 'cmd+b');
	assert.equal(eventToChord(fake('KeyF', { metaKey: true, ctrlKey: true }))!.toString(), 'ctrl+cmd+f');
	assert.equal(eventToChord(fake('F1', {}))!.toString(), 'f1');
	assert.equal(eventToChord(fake('MetaLeft', { metaKey: true })), null);
	assert.equal(eventToChord(fake('ShiftLeft', { shiftKey: true })), null);
});
