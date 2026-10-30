// src/common/platform/configuration/common/configurationService.ts — defaults ∪ user settings,
// live reload, surgical JSONC writes.
//
// Behaviors ported from vs/workbench/services/configuration/common/configurations.ts:
//  - invalid JSON: errors are reported with line info and the LAST GOOD model stays active
//  - updateValue edits the file formatting-preservingly (jsonc-parser modify + applyEdits)
//  - a `lastKnownDiskValue` guard keeps our own writes from re-triggering the watcher

import { applyEdits, findNodeAtLocation, modify, parse as parseJsonc, parseTree, ParseError, printParseErrorCode } from 'jsonc-parser';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import type { IFileIOChannel } from '../../fileIO/common/fileIO.js';
import type { ILogService } from '../../log/common/log.js';
import { ConfigurationTarget, ConfigurationTargetToString, IConfigurationChangeEvent, IConfigurationService, IInspectValue, toValuesTree } from './configuration.js';
import { ConfigurationChangeEvent, ConfigurationModel } from './configurationModels.js';
import { ConfigurationRegistry } from './configurationRegistry.js';

function lineOf(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			line++;
		}
	}
	return line;
}

export class ConfigurationService extends Disposable implements IConfigurationService {

	declare readonly _serviceBrand: undefined;

	private readonly _defaultModel: ConfigurationModel;
	private _userModel: ConfigurationModel;
	private _merged: ConfigurationModel;

	/** our own last write; the watcher skips identical text (the reference's lastKnownDiskValue dance) */
	private _lastKnownDiskValue: string | null = null;

	private readonly _onDidChangeConfiguration = this._register(new Emitter<IConfigurationChangeEvent>());
	readonly onDidChangeConfiguration: Event<IConfigurationChangeEvent> = this._onDidChangeConfiguration.event;

	constructor(
		private readonly _settingsPath: string,
		private readonly _fileIO: IFileIOChannel,
		private readonly _logService: ILogService
	) {
		super();

		this._defaultModel = new ConfigurationModel(this._createDefaultTree());
		this._userModel = new ConfigurationModel(undefined);
		this._merged = this._defaultModel.merge(this._userModel);
	}

	private _createDefaultTree(): { [key: string]: unknown } {
		const defaults: { [key: string]: unknown } = {};
		for (const [key, entry] of ConfigurationRegistry.getConfigurationProperties()) {
			if (entry.defaultValue !== undefined) {
				defaults[key] = entry.defaultValue;
			}
		}
		return toValuesTree(defaults, message => this._logService.warn(message));
	}

	getValue<T>(key: string): T | undefined {
		return this._merged.getValue(key) as T | undefined;
	}

	inspect<T>(key: string): IInspectValue<T> {
		return {
			defaultValue: this._defaultModel.getValue(key) as T | undefined,
			userValue: this._userModel.getValue(key) as T | undefined,
			workspaceValue: undefined,
			value: this._merged.getValue(key) as T | undefined
		};
	}

	getSettingsPath(): string {
		return this._settingsPath;
	}

	/** initial load; watcher-driven reloads go through `reload()` */
	async load(): Promise<void> {
		await this._reloadUserSettings(ConfigurationTarget.USER);
	}

	async reload(): Promise<void> {
		await this._reloadUserSettings(ConfigurationTarget.USER);
	}

	async updateValue(key: string, value: unknown, target: ConfigurationTarget = ConfigurationTarget.USER): Promise<void> {
		if (target !== ConfigurationTarget.USER) {
			throw new Error(`configuration target ${ConfigurationTargetToString(target)} is not supported yet`);
		}

		// same value: no-op (the reference does the same)
		if (this._userModel.getValue(key) === value) {
			return;
		}

		const text = (await this._fileIO.readTextFile(this._settingsPath)) ?? '{}\n';

		// settings files are usually FLAT (`"editor.fontSize": 16`), but nested objects are legal
		// too. Real VS Code resolves per file: if a nested node exists, edit it; otherwise the
		// whole dotted key is one segment (which keeps existing flat entries in place).
		const nestedPath = key.split('.');
		const tree = parseTree(text, []);
		const resolvedPath = tree && findNodeAtLocation(tree, nestedPath) ? nestedPath : [key];

		const edits = modify(text, resolvedPath, value, {
			formattingOptions: { insertSpaces: true, tabSize: 4, eol: '\n' }
		});
		const newText = applyEdits(text, edits);
		if (newText === text) {
			return; // modify produced nothing (e.g. unparseable file)
		}

		await this._fileIO.writeTextFile(this._settingsPath, newText);

		// apply immediately; the watcher will see this exact text and skip it
		this._lastKnownDiskValue = newText;
		const parsed = this._parseText(newText);
		if (parsed !== undefined) {
			this._applyUserValues(parsed, ConfigurationTarget.USER);
		}
	}

	private async _reloadUserSettings(source: ConfigurationTarget): Promise<void> {
		let text: string | null = null;
		try {
			text = await this._fileIO.readTextFile(this._settingsPath);
		} catch {
			text = null;
		}

		// unchanged text (including our own writes): nothing to do
		if (text !== null && text === this._lastKnownDiskValue) {
			return;
		}
		this._lastKnownDiskValue = text;

		const userValues = text === null ? {} : this._parseText(text);
		if (userValues === undefined) {
			// invalid JSON: reported with line info; the last good model stays active
			return;
		}
		this._applyUserValues(userValues, source);
	}

	private _parseText(text: string): { [key: string]: unknown } | undefined {
		const errors: ParseError[] = [];
		const parsed = parseJsonc(text, errors, { allowTrailingComma: true });

		if (errors.length > 0) {
			for (const error of errors) {
				this._logService.error(`settings.json: ${printParseErrorCode(error.error)} at line ${lineOf(text, error.offset)} (offset ${error.offset})`);
			}
			return undefined;
		}
		if (parsed === undefined || parsed === null) {
			return {};
		}
		if (typeof parsed !== 'object' || Array.isArray(parsed)) {
			this._logService.error('settings.json: expected an object at the root');
			return undefined;
		}
		// the file may hold flat dotted keys (`"editor.fontSize": 16`) or nested objects —
		// normalize to a nested tree so dotted reads work for both (upstream does the same)
		return toValuesTree(parsed as { [key: string]: unknown }, message => this._logService.warn(message));
	}

	private _applyUserValues(userValues: { [key: string]: unknown }, source: ConfigurationTarget): void {
		const newUserModel = new ConfigurationModel(userValues);
		const newMerged = this._defaultModel.merge(newUserModel);
		const change = this._merged.compare(newMerged);

		this._userModel = newUserModel;
		this._merged = newMerged;

		if (change.keys.length > 0) {
			this._onDidChangeConfiguration.fire(new ConfigurationChangeEvent(source, change));
		}
	}
}
