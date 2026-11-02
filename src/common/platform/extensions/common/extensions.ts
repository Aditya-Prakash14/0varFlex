// src/common/platform/extensions/common/extensions.ts — the manifest contract, ported in
// structure from vs/platform/extensions/common/extensions.ts (the subset this course supports)
// plus the validator rules from extensionValidator.ts.
//
// Identity rules ported: the IDENTITY is `publisher.name` LOWERCASED; the display id keeps the
// original casing. One lowercase identity prevents a whole class of duplicate-extension bugs.

/**
 * One canonical spelling for an extension's directory, for comparing `extensionLocation`
 * against a real file path.
 *
 * The scanner joins paths with '/' — it is filesystem-abstracted and has no platform path
 * module — so on Windows `extensionLocation` reads `C:\...\extensions/git-lite` while Node
 * reports `C:\...\extensions\git-lite\out\extension.js`. Comparing those raw strings fails,
 * which made EVERY extension die with "Cannot find module 'vscode'". Found by running the app.
 */
export function normalizeExtensionPath(value: string): string {
	const unified = value.replace(/\\/g, '/');
	// Windows paths are case-insensitive, and the drive letter can arrive in either case
	return typeof process !== 'undefined' && process.platform === 'win32' ? unified.toLowerCase() : unified;
}

/** true when `filePath` is the extension directory itself or a file inside it */
export function isInsideExtension(extensionLocation: string, filePath: string): boolean {
	const location = normalizeExtensionPath(extensionLocation);
	const file = normalizeExtensionPath(filePath);
	// the trailing separator keeps `.../git-lite` from also matching `.../git-lite-extra`
	return file === location || file.startsWith(`${location}/`);
}

export interface IExtensionCommandContribution {
	readonly command: string;
	readonly title: string;
	readonly category?: string;
}

export interface IExtensionKeybindingContribution {
	readonly command: string;
	/** a keybinding string like `cmd+alt+t` or `ctrl+shift+p` (parsed by 05's parser) */
	readonly key?: string;
	readonly mac?: string;
	readonly when?: string;
}

export interface IExtensionConfigurationContribution {
	readonly title?: string;
	readonly properties: { readonly [key: string]: unknown };
}

export interface IExtensionLanguageContribution {
	readonly id: string;
	readonly aliases?: readonly string[];
	/** file extensions WITHOUT the dot (`.txt` ⇒ `txt`), matching real manifests */
	readonly extensions?: readonly string[];
}

export interface IExtensionContributions {
	readonly commands?: readonly IExtensionCommandContribution[];
	readonly keybindings?: readonly IExtensionKeybindingContribution[];
	/** both manifest shapes are found in the wild: one object, or an array of titled groups */
	readonly configuration?: IExtensionConfigurationContribution | readonly IExtensionConfigurationContribution[];
	readonly languages?: readonly IExtensionLanguageContribution[];
}

export interface IExtensionManifest {
	readonly name: string;
	readonly publisher: string;
	readonly version: string;
	readonly engines: { readonly '0varflex': string };
	readonly main?: string;
	readonly activationEvents?: readonly string[];
	readonly contributes?: IExtensionContributions;
}

/** a validated extension, ready for the registries and the extension host */
export interface IExtensionDescription {
	/** lowercase `publisher.name` — the identity */
	readonly identifier: string;
	/** `Publisher.name` with the original casing */
	readonly displayId: string;
	readonly name: string;
	readonly publisher: string;
	readonly version: string;
	readonly engines: string;
	readonly main: string | undefined;
	readonly activationEvents: readonly string[];
	readonly contributes: IExtensionContributions;
	/** the extension's folder */
	readonly extensionLocation: string;
}

// ---- identity

export function toExtensionIdentifier(publisher: string, name: string): string {
	return `${publisher}.${name}`.toLowerCase();
}

export function toDisplayId(publisher: string, name: string): string {
	const capitalize = (value: string): string => value.length > 0 ? value[0].toUpperCase() + value.substring(1) : value;
	return `${capitalize(publisher)}.${capitalize(name)}`;
}

// ---- validation (ported required-field list from extensionValidator.ts)

export interface IExtensionValidationMessage {
	readonly severity: 'error' | 'warning';
	readonly message: string;
}

export interface IValidationResult {
	readonly manifest?: IExtensionManifest;
	readonly messages: IExtensionValidationMessage[];
}

function isString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

export function validateManifest(candidate: unknown): IValidationResult {
	const messages: IExtensionValidationMessage[] = [];
	const manifest = candidate as Partial<IExtensionManifest> | undefined;

	if (!manifest || typeof manifest !== 'object') {
		messages.push({ severity: 'error', message: 'extension package.json must be an object' });
		return { messages };
	}

	if (!isString(manifest.publisher)) {
		messages.push({ severity: 'error', message: 'property publisher must be of type `string`.' });
	}
	if (!isString(manifest.name)) {
		messages.push({ severity: 'error', message: 'property `name` is mandatory and must be of type `string`.' });
	}
	if (!isString(manifest.version)) {
		messages.push({ severity: 'error', message: 'property `version` is mandatory and must be of type `string`.' });
	}
	if (!manifest.engines || typeof manifest.engines !== 'object') {
		messages.push({ severity: 'error', message: 'property `engines` is mandatory and must be of type `object`.' });
	} else if (!isString((manifest.engines as { [key: string]: unknown })['0varflex'])) {
		messages.push({ severity: 'error', message: 'property `engines.0varflex` is mandatory and must be of type `string`.' });
	}
	if (manifest.activationEvents !== undefined && !isValidStringArray(manifest.activationEvents)) {
		messages.push({ severity: 'error', message: 'property `activationEvents` can be omitted or must be of type `string[]`.' });
	}
	if (manifest.activationEvents !== undefined && manifest.activationEvents.length > 0 && !isString(manifest.main)) {
		messages.push({ severity: 'error', message: 'property `activationEvents` should be omitted if the extension doesn\'t have a `main` property.' });
	}
	if (manifest.main !== undefined && !isString(manifest.main)) {
		messages.push({ severity: 'error', message: 'property `main` can be omitted or must be of type `string`.' });
	}

	if (messages.some(message => message.severity === 'error')) {
		return { messages };
	}
	return { manifest: manifest as IExtensionManifest, messages };
}

function isValidStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === 'string');
}

// ---- engines (delta: the reference parses full npm ranges; we support the common subset)

export function parseVersion(version: string): [number, number, number] | null {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (!match) {
		return null;
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) {
			return a[i] - b[i];
		}
	}
	return 0;
}

export interface IEngineCompatibility {
	readonly compatible: boolean;
	readonly message?: string;
}

/**
 * delta: supports `*`, `^a.b.c`, `>=a.b.c`, `a.b.x` and exact `a.b.c` — the reference parses
 * arbitrary npm ranges (distinctNotices for syntax/specificity mismatch are ported as messages).
 */
export function checkEngineCompatibility(engineRange: string, currentVersion: string): IEngineCompatibility {
	const requested = engineRange.trim();
	if (requested === '*') {
		return { compatible: true };
	}

	const current = parseVersion(currentVersion);
	if (!current) {
		return { compatible: false, message: `the current version ${currentVersion} is not semver parsable` };
	}
	if (requested.startsWith('^')) {
		const wanted = parseVersion(requested.substring(1));
		if (!wanted) {
			return { compatible: false, message: `Could not parse \`engines.0varflex\` value ${requested}. Please use, for example: ^1.22.0, ^1.22.x, etc.` };
		}
		const compatible = current[0] === wanted[0] && compareVersions(current, wanted) >= 0;
		return compatible ? { compatible } : { compatible, message: `Extension is not compatible with 0varflex ${currentVersion}. Extension requires: ${requested}.` };
	}
	if (requested.startsWith('>=')) {
		const wanted = parseVersion(requested.substring(2));
		if (!wanted) {
			return { compatible: false, message: `Could not parse \`engines.0varflex\` value ${requested}.` };
		}
		const compatible = compareVersions(current, wanted) >= 0;
		return compatible ? { compatible } : { compatible, message: `Extension is not compatible with 0varflex ${currentVersion}. Extension requires: ${requested}.` };
	}

	// `a.b.x` allows any patch, like the reference's caret-adjacent forms
	const wildcard = /^(\d+)\.(\d+)\.x$/.exec(requested);
	if (wildcard) {
		const compatible = current[0] === Number(wildcard[1]) && current[1] === Number(wildcard[2]);
		return compatible ? { compatible } : { compatible, message: `Extension is not compatible with 0varflex ${currentVersion}. Extension requires: ${requested}.` };
	}

	const exact = parseVersion(requested);
	if (exact) {
		const compatible = compareVersions(current, exact) === 0;
		return compatible ? { compatible } : { compatible, message: `Extension is not compatible with 0varflex ${currentVersion}. Extension requires: ${requested}.` };
	}

	return { compatible: false, message: `Could not parse \`engines.0varflex\` value ${requested}. Please use, for example: ^1.22.0, ^1.22.x, etc.` };
}
