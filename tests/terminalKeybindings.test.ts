// The terminal keybinding matrix (13) — the trickiest interplay in the course, pinned as a unit
// test:
//
//   editor focused:  cmd+k enters the chord; cmd+k cmd+a fires it; clear must NOT fire
//   terminal focused: cmd+k FIRES CLEAR (weight WorkbenchContrib + 1 beats the chord rules
//                   once their `editorTextFocus` when-clause excludes them); the chord never
//                   completes from the terminal
//
// The rules mirror the real registrations: the 05 demo chords (BuiltinExtension weight, gated
// by editorTextFocus) against the terminal clear (WorkbenchContrib + 1, `terminalFocus`).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ContextKeyExpr, ContextKeyExpression } from '../src/renderer/platform/contextkey/common/contextkey.js';
import { parseKeybinding } from '../src/renderer/platform/keybinding/common/keybindingParser.js';
import { IKeybindingItem, KeybindingWeight } from '../src/renderer/platform/keybinding/common/keybindingsRegistry.js';
import { KeybindingResolver, ResolvedKeybindingItem } from '../src/renderer/platform/keybinding/common/keybindingResolver.js';

function item(key: string, command: string, options: { weight?: number; when?: ContextKeyExpression } = {}): IKeybindingItem {
	const keybinding = parseKeybinding(key);
	assert.ok(keybinding, `test setup: '${key}' must parse`);
	return {
		keybinding: keybinding!,
		command,
		commandArgs: undefined,
		when: options.when,
		weight: options.weight ?? KeybindingWeight.WorkbenchContrib,
		isDefault: true,
		registrationIndex: 0
	};
}

function resolve(rules: IKeybindingItem[], contextValues: Record<string, unknown>, currentChords: string[], keypress: string) {
	const resolver = new KeybindingResolver(rules.map(entry => ResolvedKeybindingItem.fromItem(entry)), []);
	return resolver.resolve({ getValue: <T,>(key: string) => contextValues[key] as T | undefined }, currentChords, keypress);
}

/** the real registrations, at their real weights */
const RULES: IKeybindingItem[] = [
	item('cmd+k cmd+a', 'mini.probe.chordA', {
		weight: KeybindingWeight.BuiltinExtension,
		when: ContextKeyExpr.has('editorTextFocus')
	}),
	item('cmd+k cmd+b', 'mini.probe.chordB', {
		weight: KeybindingWeight.BuiltinExtension,
		when: ContextKeyExpr.has('editorTextFocus')
	}),
	item('cmd+k', 'workbench.action.terminal.clear', {
		// the reference's exact choice: one above the workbench contributions
		weight: KeybindingWeight.WorkbenchContrib + 1,
		when: ContextKeyExpr.has('terminalFocus')
	})
];

test('editor focused: cmd+k enters the chord', () => {
	const result = resolve(RULES, { editorTextFocus: true, terminalFocus: false }, [], 'cmd+k');
	assert.equal(result.enterChord, true);
	assert.equal(result.commandId, undefined);
});

test('editor focused: cmd+k cmd+a completes the chord (clear does not fire)', () => {
	let result = resolve(RULES, { editorTextFocus: true, terminalFocus: false }, [], 'cmd+k');
	assert.equal(result.enterChord, true);
	result = resolve(RULES, { editorTextFocus: true, terminalFocus: false }, ['cmd+k'], 'cmd+a');
	assert.equal(result.commandId, 'mini.probe.chordA');
});

test('editor focused: cmd+k cmd+b completes the other chord', () => {
	const result = resolve(RULES, { editorTextFocus: true, terminalFocus: false }, ['cmd+k'], 'cmd+b');
	assert.equal(result.commandId, 'mini.probe.chordB');
});

test('terminal focused: cmd+k fires CLEAR — no chord is entered', () => {
	const result = resolve(RULES, { editorTextFocus: false, terminalFocus: true }, [], 'cmd+k');
	assert.equal(result.commandId, 'workbench.action.terminal.clear');
	assert.equal(result.enterChord, false);
});

test('terminal focused: cmd+k cmd+a never completes the chord (clear already claimed cmd+k)', () => {
	// after clear fired nothing is pending: cmd+a alone resolves to nothing
	const result = resolve(RULES, { editorTextFocus: false, terminalFocus: true }, [], 'cmd+a');
	assert.equal(result.commandId, undefined);
	assert.equal(result.enterChord, false);
});

test('neither focused: cmd+k resolves to nothing (no clear, no chord)', () => {
	const result = resolve(RULES, { editorTextFocus: false, terminalFocus: false }, [], 'cmd+k');
	assert.equal(result.commandId, undefined);
	assert.equal(result.enterChord, false);
});
