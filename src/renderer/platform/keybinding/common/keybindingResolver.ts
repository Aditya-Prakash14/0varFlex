// src/renderer/platform/keybinding/common/keybindingResolver.ts — ported from
// vs/platform/keybinding/common/keybindingResolver.ts. This is the exercise's core algorithm:
//
//   resolve(context, currentChords, keypress)
//     → bucket candidate items by their first chord
//     → filter by the chord prefix already pressed
//     → pick the last (highest precedence) item whose `when` matches, scanning backwards
//     → not enough chords pressed → enterChord
//
// shortcut: `-commandId` removal rules are not ported (see keybindingsRegistry).

import { IContext, ContextKeyExpression } from '../../contextkey/common/contextkey.js';
import { Keybinding } from './keybinding.js';
import { IKeybindingItem } from './keybindingsRegistry.js';

export class ResolvedKeybindingItem {

	readonly chords: string[];
	readonly command: string;
	readonly commandArgs: unknown;
	readonly when: ContextKeyExpression | undefined;
	readonly weight: number;
	readonly isDefault: boolean;
	readonly registrationIndex: number;

	constructor(keybinding: Keybinding, command: string, commandArgs: unknown, when: ContextKeyExpression | undefined, weight: number, isDefault: boolean, registrationIndex: number) {
		this.chords = keybinding.chords.map(chord => chord.toString());
		this.command = command;
		this.commandArgs = commandArgs;
		this.when = when;
		this.weight = weight;
		this.isDefault = isDefault;
		this.registrationIndex = registrationIndex;
	}

	static fromItem(item: IKeybindingItem): ResolvedKeybindingItem {
		return new ResolvedKeybindingItem(item.keybinding, item.command, item.commandArgs, item.when, item.weight, item.isDefault, item.registrationIndex);
	}
}

export interface ResolutionResult {
	readonly enterChord: boolean;
	readonly commandId?: string;
	readonly commandArgs?: unknown;
}

const NoMatchingKb: ResolutionResult = { enterChord: false };
const MoreChordsNeeded: ResolutionResult = { enterChord: true };

function KbFound(commandId: string, commandArgs: unknown): ResolutionResult {
	return { enterChord: false, commandId, commandArgs };
}

export class KeybindingResolver {

	private readonly _map = new Map<string, ResolvedKeybindingItem[]>();

	constructor(
		defaultKeybindings: readonly ResolvedKeybindingItem[],
		overrides: readonly ResolvedKeybindingItem[]
	) {
		const items: ResolvedKeybindingItem[] = [];

		// the precedence comparator assumes this exact concatenation: defaults, then user overrides
		for (const item of defaultKeybindings) {
			items.push(item);
		}
		for (const item of overrides) {
			items.push(item);
		}

		items.sort(compareResolvedItems);

		for (const item of items) {
			const firstChord = item.chords[0];
			let bucket = this._map.get(firstChord);
			if (!bucket) {
				bucket = [];
				this._map.set(firstChord, bucket);
			}
			bucket.push(item);
		}
	}

	public resolve(context: IContext, currentChords: string[], keypress: string): ResolutionResult {
		const pressedChords = [...currentChords, keypress];

		const kbCandidates = this._map.get(pressedChords[0]);
		if (kbCandidates === undefined) {
			// no bindings with such 0-th chord
			return NoMatchingKb;
		}

		let lookupMap: ResolvedKeybindingItem[];
		if (pressedChords.length < 2) {
			lookupMap = kbCandidates;
		} else {
			// fetch all chord bindings for the chords pressed so far
			lookupMap = [];
			for (const candidate of kbCandidates) {
				if (pressedChords.length > candidate.chords.length) {
					continue;
				}
				let prefixMatches = true;
				for (let i = 1; i < pressedChords.length; i++) {
					if (candidate.chords[i] !== pressedChords[i]) {
						prefixMatches = false;
						break;
					}
				}
				if (prefixMatches) {
					lookupMap.push(candidate);
				}
			}
		}

		// the last (highest precedence) candidate whose when clause matches
		const result = this._findCommand(context, lookupMap);
		if (!result) {
			return NoMatchingKb;
		}

		// not all chords pressed yet: this is a chord prefix
		if (pressedChords.length < result.chords.length) {
			return MoreChordsNeeded;
		}

		return KbFound(result.command, result.commandArgs);
	}

	private _findCommand(context: IContext, matches: ResolvedKeybindingItem[]): ResolvedKeybindingItem | null {
		for (let i = matches.length - 1; i >= 0; i--) {
			const candidate = matches[i];
			if (candidate.when && !candidate.when.evaluate(context)) {
				continue;
			}
			return candidate;
		}
		return null;
	}
}

/** ascending precedence (same axes as the registry), so the reverse scan ends on the winner */
function compareResolvedItems(a: ResolvedKeybindingItem, b: ResolvedKeybindingItem): number {
	if (a.isDefault !== b.isDefault) {
		return a.isDefault ? -1 : 1;
	}
	if (a.weight !== b.weight) {
		return a.weight - b.weight;
	}
	const aSpecificity = a.when ? a.when.keys().length : 0;
	const bSpecificity = b.when ? b.when.keys().length : 0;
	if (aSpecificity !== bSpecificity) {
		return aSpecificity - bSpecificity;
	}
	return a.registrationIndex - b.registrationIndex;
}
