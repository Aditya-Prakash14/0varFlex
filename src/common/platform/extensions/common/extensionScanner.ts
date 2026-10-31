// src/common/platform/extensions/common/extensionScanner.ts — walk extension directories, read
// package.json, validate, normalize identity, dedupe. Ported in shape from
// vs/platform/extensions/common/extensionsScannerService.ts (electron-main scanner + validator).
//
// The file system is injected (`IExtensionScannerFileSystem`): main passes node fs, tests pass
// an in-memory one — the scanner logic itself stays environment-free.
//
// The manifest cache (real: one JSON per language, `getManifestCacheFileName`) is a single
// `<userData>/extensions.json` keyed by directory mtime: unchanged directory → cached parse.

import {
	checkEngineCompatibility,
	IExtensionDescription,
	IExtensionManifest,
	toDisplayId,
	toExtensionIdentifier,
	validateManifest
} from './extensions.js';

export interface IScannerFileSystem {
	readdir(path: string): Promise<readonly { name: string; isDirectory: boolean }[]>;
	readFile(path: string): Promise<string>;
	stat(path: string): Promise<{ mtimeMs: number }>;
}

export interface IScannerLog {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface IExtensionScanDirectory {
	readonly path: string;
	readonly kind: 'builtin' | 'user';
}

export interface IScannedExtension {
	readonly description: IExtensionDescription;
	readonly kind: 'builtin' | 'user';
}

export interface IExtensionScanError {
	readonly path: string;
	readonly message: string;
}

export interface IExtensionScanResult {
	readonly extensions: readonly IScannedExtension[];
	readonly errors: readonly IExtensionScanError[];
	/** directories inspected (cache hits included) */
	readonly scanned: number;
	readonly cacheHits: number;
}

export interface IManifestCacheEntry {
	readonly mtimeMs: number;
	readonly manifest?: IExtensionManifest;
	readonly errors?: readonly string[];
}

export interface IManifestCache {
	version: 1;
	entries: { [directory: string]: IManifestCacheEntry };
}

export function emptyManifestCache(): IManifestCache {
	return { version: 1, entries: {} };
}

function isCacheCompatible(candidate: unknown): candidate is IManifestCache {
	return !!candidate && typeof candidate === 'object' && (candidate as IManifestCache).version === 1 && typeof (candidate as IManifestCache).entries === 'object';
}

export function parseManifestCache(text: string | null): IManifestCache {
	if (!text) {
		return emptyManifestCache();
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		return isCacheCompatible(parsed) ? parsed : emptyManifestCache();
	} catch {
		return emptyManifestCache();
	}
}

export interface IScanOptions {
	readonly directories: readonly IExtensionScanDirectory[];
	readonly currentVersion: string;
	readonly cache?: IManifestCache;
	readonly log: IScannerLog;
}

export async function scanExtensions(fileSystem: IScannerFileSystem, options: IScanOptions): Promise<{ result: IExtensionScanResult; cache: IManifestCache }> {
	const extensions: IScannedExtension[] = [];
	const errors: IExtensionScanError[] = [];
	const byIdentifier = new Map<string, IExtensionDescription>();
	const cache: IManifestCache = options.cache && isCacheCompatible(options.cache) ? { version: 1, entries: { ...options.cache.entries } } : emptyManifestCache();
	const nextCacheEntries: { [directory: string]: IManifestCacheEntry } = {};
	let scanned = 0;
	let cacheHits = 0;

	for (const directory of options.directories) {
		let children: readonly { name: string; isDirectory: boolean }[];
		try {
			children = await fileSystem.readdir(directory.path);
		} catch {
			// a missing directory (no user extensions yet) is not an error
			options.log.info(`extension directory not found: ${directory.path}`);
			continue;
		}

		for (const child of [...children].sort((a, b) => a.name.localeCompare(b.name))) {
			if (!child.isDirectory || child.name.startsWith('.')) {
				continue;
			}
			const directoryPath = `${directory.path.replace(/\/+$/, '')}/${child.name}`;
			scanned++;

			let mtimeMs: number;
			try {
				mtimeMs = (await fileSystem.stat(directoryPath)).mtimeMs;
			} catch {
				continue;
			}

			const cached = cache.entries[directoryPath];
			let manifest: IExtensionManifest | undefined;
			let entryErrors: string[] | undefined;

			if (cached && cached.mtimeMs === mtimeMs) {
				cacheHits++;
				manifest = cached.manifest;
				entryErrors = cached.errors ? [...cached.errors] : undefined;
			} else {
				const packageJsonPath = `${directoryPath}/package.json`;
				let text: string | null = null;
				try {
					text = await fileSystem.readFile(packageJsonPath);
				} catch {
					entryErrors = [`no package.json at ${packageJsonPath}`];
				}
				if (text !== null) {
					try {
						const validation = validateManifest(JSON.parse(text));
						for (const message of validation.messages) {
							if (message.severity === 'error') {
								entryErrors = [...(entryErrors ?? []), message.message];
							} else {
								options.log.warn(`${child.name}: ${message.message}`);
							}
						}
						manifest = validation.manifest;
					} catch (error) {
						entryErrors = [`package.json is not valid JSON: ${(error as Error).message}`];
					}
				}
			}

			nextCacheEntries[directoryPath] = { mtimeMs, manifest, errors: entryErrors };

			if (entryErrors && entryErrors.length > 0) {
				for (const message of entryErrors) {
					errors.push({ path: directoryPath, message });
					options.log.error(`extension ${child.name} skipped: ${message}`);
				}
				continue;
			}
			if (!manifest) {
				continue;
			}

			// engines: incompatible → log and DISABLE, never crash (the acceptance relies on it)
			const compatibility = checkEngineCompatibility(manifest.engines['mini-vscode'], options.currentVersion);
			if (!compatibility.compatible) {
				errors.push({ path: directoryPath, message: compatibility.message ?? 'incompatible' });
				options.log.warn(`extension ${toExtensionIdentifier(manifest.publisher, manifest.name)} disabled: ${compatibility.message}`);
				continue;
			}

			const identifier = toExtensionIdentifier(manifest.publisher, manifest.name);
			const existing = byIdentifier.get(identifier);
			if (existing) {
				options.log.warn(`duplicate extension ${identifier}: keeping ${existing.extensionLocation}, ignoring ${directoryPath}`);
				continue;
			}

			const description: IExtensionDescription = {
				identifier,
				displayId: toDisplayId(manifest.publisher, manifest.name),
				name: manifest.name,
				publisher: manifest.publisher,
				version: manifest.version,
				engines: manifest.engines['mini-vscode'],
				main: manifest.main,
				activationEvents: manifest.activationEvents ?? [],
				contributes: manifest.contributes ?? {},
				extensionLocation: directoryPath
			};
			byIdentifier.set(identifier, description);
			extensions.push({ description, kind: directory.kind });
		}
	}

	return {
		result: { extensions, errors, scanned, cacheHits },
		cache: { version: 1, entries: nextCacheEntries }
	};
}
