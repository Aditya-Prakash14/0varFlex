// src/renderer/workbench/services/languages/common/languageService.ts — the language registry,
// ported in shape from vs/workbench/services/languages/common/languages.ts: extensions
// contribute `{id, aliases, extensions}` and the workbench resolves a resource to a language id
// by file extension. 12 (syntax highlighting per language) and the status bar consume this.

import { Disposable } from '../../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../../common/base/common/uri.js';
import type { ILogService } from '../../../../../common/platform/log/common/log.js';
import type { IExtensionLanguageContribution } from '../../../../../common/platform/extensions/common/extensions.js';

interface ILanguageEntry {
	readonly id: string;
	readonly aliases: readonly string[];
	readonly extensions: readonly string[];
}

export const PLAINTEXT_LANGUAGE_ID = 'plaintext';

export class LanguageService extends Disposable {

	private readonly _languages = new Map<string, ILanguageEntry>();
	private readonly _byExtension = new Map<string, string>();

	constructor(private readonly _logService: ILogService) {
		super();
		this._registerDefaults();
	}

	private _registerDefaults(): void {
		const defaults: IExtensionLanguageContribution[] = [
			{ id: PLAINTEXT_LANGUAGE_ID, aliases: ['Plain Text'], extensions: ['txt'] },
			{ id: 'typescript', aliases: ['TypeScript'], extensions: ['ts'] },
			{ id: 'javascript', aliases: ['JavaScript'], extensions: ['js', 'mjs', 'cjs'] },
			{ id: 'json', aliases: ['JSON'], extensions: ['json'] },
			{ id: 'markdown', aliases: ['Markdown'], extensions: ['md'] },
			{ id: 'css', aliases: ['CSS'], extensions: ['css'] },
			{ id: 'html', aliases: ['HTML'], extensions: ['html'] }
		];
		for (const language of defaults) {
			this._addLanguage(language, 'builtin');
		}
	}

	/** extensions contribute on top; conflicts (a file extension already claimed) FIRST WINS */
	registerLanguage(contribution: IExtensionLanguageContribution, source: string): void {
		this._addLanguage(contribution, source);
	}

	private _addLanguage(contribution: IExtensionLanguageContribution, source: string): void {
		if (!contribution.id) {
			this._logService.warn(`[${source}] language contribution without id ignored`);
			return;
		}
		const extensions = (contribution.extensions ?? []).map(extension => extension.replace(/^\./, '').toLowerCase());
		this._languages.set(contribution.id, {
			id: contribution.id,
			aliases: contribution.aliases ?? [],
			extensions
		});
		for (const extension of extensions) {
			const existing = this._byExtension.get(extension);
			if (existing && existing !== contribution.id) {
				this._logService.warn(`[${source}] the file extension '.${extension}' is already claimed by '${existing}'; ignoring '${contribution.id}'`);
				continue;
			}
			this._byExtension.set(extension, contribution.id);
		}
	}

	getLanguages(): readonly { id: string; aliases: readonly string[]; extensions: readonly string[] }[] {
		return [...this._languages.values()];
	}

	/** `.txt` → plaintext; unknown extensions fall back to plaintext (real: plaintext too) */
	languageIdForResource(resource: URI): string {
		const fsPath = resource.fsPath;
		const index = fsPath.lastIndexOf('.');
		if (index <= 0) {
			return PLAINTEXT_LANGUAGE_ID;
		}
		return this._byExtension.get(fsPath.substring(index + 1).toLowerCase()) ?? PLAINTEXT_LANGUAGE_ID;
	}
}
