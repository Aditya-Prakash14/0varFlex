// extensions/toy-lang/server/src/analysis.ts — the toy grammar, PURE functions only (no LSP
// imports): analyze / completionsAt / hoverAt. The server wires these into protocol handlers,
// and the unit tests exercise them without an editor or a socket.
//
// Grammar (also in the extension README):
//   - lines are `key = value`;
//   - `[path.to.section]` starts a section; keys inside resolve to `<section>.<key>`;
//   - `# …` runs to the end of the line;
//   - known keys: name, entry, timeout, workers, log.level, flags;
//   - values: true / false / auto or a number.
//
// All positions are LSP-style: 0-based line, 0-based UTF-16 character.

export interface IAnalysisPosition {
	readonly line: number;
	readonly character: number;
}

export interface IAnalysisRange {
	readonly start: IAnalysisPosition;
	readonly end: IAnalysisPosition;
}

export interface IAnalysisDiagnostic {
	readonly range: IAnalysisRange;
	/** DiagnosticSeverity: Error = 1, Warning = 2, Information = 3, Hint = 4 */
	readonly severity: number;
	readonly message: string;
	readonly code?: string;
}

export interface IAnalysisCompletion {
	readonly label: string;
	readonly kind: number;
	readonly detail?: string;
	readonly filterText: string;
	readonly textEdit: { readonly range: IAnalysisRange; readonly newText: string };
}

export const DiagnosticSeverity = { Error: 1, Warning: 2, Information: 3, Hint: 4 } as const;
export const CompletionItemKind = { Text: 1, Method: 2, Function: 3, Field: 5, Variable: 6, Class: 7, Property: 10, Value: 12, Keyword: 14, Constant: 21, Operator: 24 } as const;

export interface IKeyInfo {
	readonly description: string;
	readonly allowed: string;
	readonly example: string;
}

export const KNOWN_KEYS: Readonly<Record<string, IKeyInfo>> = {
	name: {
		description: 'The name of the configuration.',
		allowed: '`true`, `false`, `auto` or a number',
		example: 'name = auto'
	},
	entry: {
		description: 'The entry point the configuration loads.',
		allowed: '`true`, `false`, `auto` or a number',
		example: 'entry = auto'
	},
	timeout: {
		description: 'How long to wait before giving up.',
		allowed: '`true`, `false`, `auto` or a number',
		example: 'timeout = 30'
	},
	workers: {
		description: 'How many worker threads to start.',
		allowed: '`true`, `false`, `auto` or a number',
		example: 'workers = 4'
	},
	'log.level': {
		description: 'The verbosity of the log.',
		allowed: '`true`, `false`, `auto` or a number',
		example: 'log.level = auto'
	},
	flags: {
		description: 'Feature flags, as a boolean or automatic.',
		allowed: '`true`, `false`, `auto` or a number',
		example: 'flags = false'
	}
};

export const TRIGGER_CHARACTERS: readonly string[] = ['=', '[', ' '];

const VALUE_PATTERN = /^(-?\d+(\.\d+)?|true|false|auto)$/;
const KEY_FRAGMENT_PATTERN = /[A-Za-z0-9_.]/;

function rangeOnLine(line: number, startCharacter: number, endCharacter: number): IAnalysisRange {
	return { start: { line, character: startCharacter }, end: { line, character: endCharacter } };
}

function stripComment(lineText: string): string {
	const hash = lineText.indexOf('#');
	return hash === -1 ? lineText : lineText.slice(0, hash);
}

/** the section this line belongs to: the last `[section]` header at or before `line` */
export function sectionAtLine(lines: readonly string[], line: number): string {
	for (let index = line; index >= 0; index--) {
		const trimmed = stripComment(lines[index]).trim();
		if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
			return trimmed.slice(1, -1);
		}
	}
	return '';
}

/** `<key>` in the current section → the fully qualified known-key lookup name */
function resolveKey(key: string, section: string): string {
	if (section && KNOWN_KEYS[`${section}.${key}`]) {
		return `${section}.${key}`;
	}
	return key;
}

export function analyze(text: string): IAnalysisDiagnostic[] {
	const lines = text.split(/\r?\n/);
	const diagnostics: IAnalysisDiagnostic[] = [];
	const seenBySection = new Map<string, Set<string>>();

	for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
		const rawLine = lines[lineNumber];
		const content = stripComment(rawLine);
		const trimmed = content.trim();
		if (trimmed === '') {
			continue;
		}
		const indent = content.length - content.trimStart().length;

		if (trimmed.startsWith('[')) {
			if (!/^[\w.]+\]$/.test(trimmed.slice(1))) {
				diagnostics.push({
					range: rangeOnLine(lineNumber, indent, rawLine.trimEnd().length),
					severity: DiagnosticSeverity.Error,
					message: "Expected '[path.to.section]'",
					code: 'syntax'
				});
			}
			continue;
		}

		const equals = content.indexOf('=');
		if (equals === -1) {
			diagnostics.push({
				range: rangeOnLine(lineNumber, indent, rawLine.trimEnd().length),
				severity: DiagnosticSeverity.Error,
				message: "Expected 'key = value'",
				code: 'syntax'
			});
			continue;
		}

		const keyText = content.slice(0, equals);
		const key = keyText.trim();
		const keyStart = indent;
		const keyEnd = keyStart + keyText.trimEnd().length;

		if (key === '') {
			diagnostics.push({
				range: rangeOnLine(lineNumber, equals, equals + 1),
				severity: DiagnosticSeverity.Error,
				message: "Expected 'key = value'",
				code: 'syntax'
			});
			continue;
		}

		const section = sectionAtLine(lines, lineNumber);
		const seen = seenBySection.get(section) ?? new Set<string>();
		seenBySection.set(section, seen);
		if (seen.has(key)) {
			diagnostics.push({
				range: rangeOnLine(lineNumber, keyStart, keyEnd),
				severity: DiagnosticSeverity.Warning,
				message: `Duplicate key '${key}'${section ? ` in section '${section}'` : ''}`,
				code: 'duplicate-key'
			});
		}
		seen.add(key);

		const resolved = resolveKey(key, section);
		if (!KNOWN_KEYS[resolved]) {
			diagnostics.push({
				range: rangeOnLine(lineNumber, keyStart, keyEnd),
				severity: DiagnosticSeverity.Warning,
				message: `Unknown key '${key}'`,
				code: 'unknown-key'
			});
		}

		const valueText = content.slice(equals + 1);
		const value = valueText.trim();
		const valueStart = equals + 1 + (valueText.length - valueText.trimStart().length);
		const valueEnd = valueStart + value.length;

		if (value === '') {
			diagnostics.push({
				range: rangeOnLine(lineNumber, equals, equals + 1),
				severity: DiagnosticSeverity.Warning,
				message: `Missing value for '${key}'`,
				code: 'invalid-value'
			});
		} else if (!VALUE_PATTERN.test(value)) {
			diagnostics.push({
				range: rangeOnLine(lineNumber, valueStart, valueEnd),
				severity: DiagnosticSeverity.Warning,
				message: `Invalid value '${value}' — expected true/false/auto or a number`,
				code: 'invalid-value'
			});
		}
	}

	return diagnostics;
}

export interface ICompletionResult {
	readonly items: readonly IAnalysisCompletion[];
	readonly isIncomplete: boolean;
}

const VALUE_COMPLETIONS: readonly { label: string; detail: string }[] = [
	{ label: 'true', detail: 'boolean' },
	{ label: 'false', detail: 'boolean' },
	{ label: 'auto', detail: 'automatic' },
	{ label: '30', detail: 'number' }
];

export function completionsAt(text: string, line: number, character: number): ICompletionResult {
	const lines = text.split(/\r?\n/);
	const lineText = lines[line] ?? '';
	const beforeCursor = lineText.slice(0, character);
	const trimmed = beforeCursor.trimStart();

	// inside a section header: nothing to offer (the ']' ends it)
	if (trimmed.startsWith('[')) {
		return { items: [], isIncomplete: false };
	}

	const equals = beforeCursor.indexOf('=');
	if (equals !== -1) {
		// the value slot: true/false/auto/<number>, replacing whatever was typed after the '='
		const valueFragment = beforeCursor.slice(equals + 1);
		const valueStart = equals + 1 + (valueFragment.length - valueFragment.trimStart().length);
		return {
			items: VALUE_COMPLETIONS.map(completion => ({
				label: completion.label,
				kind: completion.label === 'auto' ? CompletionItemKind.Constant : CompletionItemKind.Value,
				detail: completion.detail,
				filterText: completion.label,
				textEdit: { range: rangeOnLine(line, valueStart, character), newText: completion.label }
			})),
			// the value list may be refined with every keystroke: ask the client to re-query —
			// this is the isIncomplete path the exercise wants exercised (server log proves it)
			isIncomplete: true
		};
	}

	// the key slot: local names for the active section, else every known key; '[' starts one
	const section = sectionAtLine(lines, line);
	const items: IAnalysisCompletion[] = [];
	let keyStart = character;
	while (keyStart > 0 && KEY_FRAGMENT_PATTERN.test(beforeCursor[keyStart - 1])) {
		keyStart--;
	}

	for (const knownKey of Object.keys(KNOWN_KEYS)) {
		let label = knownKey;
		if (section && knownKey.startsWith(`${section}.`)) {
			label = knownKey.slice(section.length + 1);
		} else if (section && knownKey.includes('.')) {
			continue; // a nested key from another section cannot be set here
		}
		items.push({
			label,
			kind: CompletionItemKind.Property,
			detail: KNOWN_KEYS[knownKey].description,
			filterText: label,
			textEdit: { range: rangeOnLine(line, keyStart, character), newText: label }
		});
	}
	items.push({
		label: '[',
		kind: CompletionItemKind.Keyword,
		detail: 'start a new section',
		filterText: '[',
		textEdit: { range: rangeOnLine(line, keyStart, character), newText: '[' }
	});

	return { items, isIncomplete: false };
}

export interface IHoverResult {
	readonly contents: string;
	readonly range: IAnalysisRange;
}

export function hoverAt(text: string, line: number, character: number): IHoverResult | null {
	const lines = text.split(/\r?\n/);
	const lineText = lines[line] ?? '';
	if (character > lineText.length) {
		return null;
	}
	// the word under the cursor: key names may contain dots
	let start = character;
	let end = character;
	while (start > 0 && KEY_FRAGMENT_PATTERN.test(lineText[start - 1])) {
		start--;
	}
	while (end < lineText.length && KEY_FRAGMENT_PATTERN.test(lineText[end])) {
		end++;
	}
	const word = lineText.slice(start, end);
	if (!word) {
		return null;
	}

	const section = sectionAtLine(lines, line);
	// hovering a key, or a value whose line has a known key
	let resolved = resolveKey(word, section);
	if (!KNOWN_KEYS[resolved]) {
		const equals = lineText.indexOf('=');
		if (equals !== -1 && character > equals) {
			resolved = resolveKey(lineText.slice(0, equals).trim(), section);
		}
	}
	const info = KNOWN_KEYS[resolved];
	if (!info) {
		return null;
	}

	return {
		contents: [
			`\`${resolved}\``,
			'',
			info.description,
			'',
			`Allowed values: ${info.allowed}`,
			'',
			'Example:',
			'```',
			info.example,
			'```'
		].join('\n'),
		range: rangeOnLine(line, start, end)
	};
}
