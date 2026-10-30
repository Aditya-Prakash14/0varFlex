// src/renderer/platform/keybinding/common/userKeybindings.ts — load and validate
// keybindings.json (JSONC, via Microsoft's jsonc-parser — the same package VS Code uses for
// every settings-like file).
//
// shortcut: no `-commandId` unbinding, no `systemWide`, no bubble `^` prefix — deltas noted in
// the registry; this parses the shapes our rules use.

import { parse as parseJsonc, ParseError, printParseErrorCode } from 'jsonc-parser';
import { ContextKeyExpr } from '../../contextkey/common/contextkey.js';
import { Keybinding } from './keybinding.js';
import { OperatingSystem } from './keybindingLabels.js';
import { parseKeybinding } from './keybindingParser.js';
import { IKeybindingItem } from './keybindingsRegistry.js';

interface IUserKeybindingEntry {
	readonly key?: string;
	readonly command?: string;
	readonly when?: string;
	readonly args?: unknown;
	readonly mac?: string;
	readonly win?: string;
	readonly linux?: string;
}

export interface IParsedUserKeybindings {
	readonly items: IKeybindingItem[];
	readonly errors: string[];
}

function lineOf(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			line++;
		}
	}
	return line;
}

export function parseUserKeybindings(text: string, os: OperatingSystem): IParsedUserKeybindings {
	const errors: string[] = [];
	const jsonErrors: ParseError[] = [];
	const parsed = parseJsonc(text, jsonErrors, { allowTrailingComma: true });

	if (jsonErrors.length > 0) {
		for (const error of jsonErrors) {
			errors.push(`${printParseErrorCode(error.error)} at line ${lineOf(text, error.offset)}`);
		}
		return { items: [], errors };
	}

	if (!Array.isArray(parsed)) {
		errors.push('keybindings.json must contain an array');
		return { items: [], errors };
	}

	const items: IKeybindingItem[] = [];

	for (let index = 0; index < parsed.length; index++) {
		const entry = parsed[index] as IUserKeybindingEntry;
		if (!entry || typeof entry !== 'object') {
			errors.push(`entry ${index}: not an object`);
			continue;
		}

		const platformKey = os === OperatingSystem.Macintosh ? entry.mac : os === OperatingSystem.Windows ? entry.win : entry.linux;
		const key = platformKey ?? entry.key;
		const command = entry.command;

		if (typeof command !== 'string' || !command) {
			errors.push(`entry ${index}: missing 'command'`);
			continue;
		}
		if (typeof key !== 'string' || !key) {
			errors.push(`entry ${index}: missing 'key'`);
			continue;
		}

		const keybinding: Keybinding | null = parseKeybinding(key);
		if (!keybinding) {
			errors.push(`entry ${index}: could not parse key binding '${key}'`);
			continue;
		}

		let when;
		if (typeof entry.when === 'string' && entry.when !== '') {
			when = ContextKeyExpr.deserialize(entry.when);
			if (!when) {
				errors.push(`entry ${index}: could not parse when clause '${entry.when}'`);
				continue;
			}
		}

		items.push({
			keybinding,
			command,
			commandArgs: entry.args,
			when,
			weight: 0,
			isDefault: false,
			registrationIndex: index
		});
	}

	return { items, errors };
}
