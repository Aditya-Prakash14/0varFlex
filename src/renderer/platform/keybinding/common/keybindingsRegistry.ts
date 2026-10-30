// src/renderer/platform/keybinding/common/keybindingsRegistry.ts — ported from
// vs/platform/keybinding/common/keybindingsRegistry.ts: rules with real weights, the packed
// `KeyMod | KeyCode` / `KeyChord(...)` decoding and per-platform overrides.
//
// shortcut: no `-commandId` removal rules (unbinding via keybindings.json) and no contribution
// args beyond a single optional `args` — deltas to revisit when a feature needs them.

import { IDisposable, toDisposable } from '../../../../common/base/common/lifecycle.js';
import { ContextKeyExpression } from '../../contextkey/common/contextkey.js';
import { KeyCode, KeyMod } from './keyCodes.js';
import { KeyCodeChord, Keybinding } from './keybinding.js';
import { OperatingSystem } from './keybindingLabels.js';

export const enum KeybindingWeight {
	EditorCore = 0,
	EditorContrib = 100,
	WorkbenchContrib = 200,
	SessionsContrib = 250,
	BuiltinExtension = 300,
	ExternalExtension = 400,
}

export interface IKeybindingRule {
	readonly id: string;
	readonly weight: number;
	readonly when?: ContextKeyExpression;
	/** `KeyMod.CtrlCmd | KeyCode.KeyB`, arrays of chords, or a parsed Keybinding */
	readonly primary?: number | number[] | Keybinding;
	readonly secondary?: number | number[] | Keybinding;
	readonly mac?: number | number[] | Keybinding;
	readonly win?: number | number[] | Keybinding;
	readonly linux?: number | number[] | Keybinding;
}

function decodeChord(code: number, os: OperatingSystem): KeyCodeChord {
	// the modifier bits live ABOVE the key code (CtrlCmd = 1 << 11), so split by the known mask
	const modifierMask = KeyMod.CtrlCmd | KeyMod.Shift | KeyMod.Alt | KeyMod.WinCtrl;
	const keyCode = code & ~modifierMask;
	const modifiers = code & modifierMask;
	const isMac = os === OperatingSystem.Macintosh;

	// CtrlCmd is ⌘ on mac and ctrl elsewhere; WinCtrl is ⌃ on mac and the Win key elsewhere
	const ctrl = isMac ? !!(modifiers & KeyMod.WinCtrl) : !!(modifiers & KeyMod.CtrlCmd);
	const meta = isMac ? !!(modifiers & KeyMod.CtrlCmd) : !!(modifiers & KeyMod.WinCtrl);

	return new KeyCodeChord(ctrl, !!(modifiers & KeyMod.Shift), !!(modifiers & KeyMod.Alt), meta, keyCode);
}

export function decodeKeybinding(keybinding: number | number[] | Keybinding, os: OperatingSystem): Keybinding | null {
	if (typeof keybinding === 'number') {
		// a packed KeyChord(first, second) carries the second part in the high 16 bits
		if (keybinding > 0x0000ffff) {
			const first = decodeChord(keybinding & 0x0000ffff, os);
			const second = decodeChord(keybinding >>> 16, os);
			return new Keybinding([first, second]);
		}
		return new Keybinding([decodeChord(keybinding, os)]);
	}
	if (Array.isArray(keybinding)) {
		return new Keybinding(keybinding.map(part => decodeChord(part, os)));
	}
	return keybinding;
}

export interface IKeybindingItem {
	readonly keybinding: Keybinding;
	readonly command: string;
	readonly commandArgs: unknown;
	readonly when: ContextKeyExpression | undefined;
	readonly weight: number;
	readonly isDefault: boolean;
	readonly registrationIndex: number;
}

const _defaultKeybindings: IKeybindingRule[] = [];
let _registrationCounter = 0;

export function registerKeybindingRule(rule: IKeybindingRule): IDisposable {
	if (!rule.id) {
		throw new Error('invalid rule, no id');
	}
	_defaultKeybindings.push(rule);
	return toDisposable(() => {
		const index = _defaultKeybindings.indexOf(rule);
		if (index >= 0) {
			_defaultKeybindings.splice(index, 1);
		}
	});
}

export function registerDefaultKeybindings(rules: readonly IKeybindingRule[]): IDisposable {
	const disposables = rules.map(rule => registerKeybindingRule(rule));
	return toDisposable(() => disposables.forEach(disposable => disposable.dispose()));
}

/**
 * The default keybindings decoded for an OS, ordered by precedence *ascending* — the resolver
 * picks from the end of a bucket, so the highest precedence sits last:
 *   weight → more specific when clause → later registration
 */
export function getDefaultKeybindings(os: OperatingSystem): IKeybindingItem[] {
	const result: IKeybindingItem[] = [];

	for (const rule of _defaultKeybindings) {
		const registrationIndex = _registrationCounter++;

		const platformOverride = os === OperatingSystem.Macintosh ? rule.mac : os === OperatingSystem.Windows ? rule.win : rule.linux;
		const primarySource = platformOverride !== undefined ? platformOverride : rule.primary;

		if (primarySource !== undefined) {
			const keybinding = decodeKeybinding(primarySource, os);
			if (keybinding) {
				result.push({ keybinding, command: rule.id, commandArgs: undefined, when: rule.when, weight: rule.weight, isDefault: true, registrationIndex });
			}
		}

		if (rule.secondary !== undefined) {
			const secondaries = Array.isArray(rule.secondary) && typeof rule.secondary[0] === 'number'
				? rule.secondary.map(code => decodeKeybinding(code, os)).filter((kb): kb is Keybinding => !!kb)
				: [decodeKeybinding(rule.secondary, os)].filter((kb): kb is Keybinding => !!kb);
			for (const keybinding of secondaries) {
				result.push({ keybinding, command: rule.id, commandArgs: undefined, when: rule.when, weight: rule.weight, isDefault: true, registrationIndex });
			}
		}
	}

	result.sort(compareKeybindingItems);
	return result;
}

/** ascending precedence: the resolver's reverse scan ends on the winner */
export function compareKeybindingItems(a: IKeybindingItem, b: IKeybindingItem): number {
	// defaults first, user last (user wins)
	if (a.isDefault !== b.isDefault) {
		return a.isDefault ? -1 : 1;
	}
	// higher weight wins
	if (a.weight !== b.weight) {
		return a.weight - b.weight;
	}
	// a more specific when clause wins
	const aSpecificity = a.when ? a.when.keys().length : 0;
	const bSpecificity = b.when ? b.when.keys().length : 0;
	if (aSpecificity !== bSpecificity) {
		return aSpecificity - bSpecificity;
	}
	// later registration wins
	return a.registrationIndex - b.registrationIndex;
}

export const KeybindingsRegistry = {
	registerKeybindingRule,
	registerDefaultKeybindings,
	getDefaultKeybindings
};
