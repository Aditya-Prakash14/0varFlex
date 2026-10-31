// src/common/platform/configuration/common/configurationService.ts — defaults ∪ user settings ∪
// workspace settings, live reload, surgical JSONC writes.
//
// Behaviors ported from vs/workbench/services/configuration/common/configurations.ts:
//  - invalid JSON: errors are reported with line info and the LAST GOOD model stays active
//  - updateValue edits the file formatting-preservingly (jsonc-parser modify + applyEdits)
//  - a `lastKnownDiskValue` guard keeps our own writes from re-triggering the watcher
//  - 10 adds the WORKSPACE layer: DEFAULT < USER < WORKSPACE (real precedence)
//
// delta: the workspace layer reads `<folder>/.mini/settings.json` (see workspace.ts)

import { applyEdits, findNodeAtLocation, modify, parse as parseJsonc, parseTree, ParseError, printParseErrorCode } from 'jsonc-parser';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import type { IFileService } from '../../files/common/files.js';
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
	/** 10: the workspace (folder) layer; empty until a folder with .mini/settings.json opens */
	private _workspaceModel: ConfigurationModel;
	private _merged: ConfigurationModel;

	/** the workspace settings file on disk (null when no folder is open) */
	private _workspaceSettingsPath: string | null = null;

	/** our own last write; the watcher skips identical text (the reference's lastKnownDiskValue dance) */
	private _lastKnownDiskValue: string | null = null;
	private _workspaceLastKnownDiskValue: string | null = null;

	private readonly _onDidChangeConfiguration = this._register(new Emitter<IConfigurationChangeEvent>());
	readonly onDidChangeConfiguration: Event<IConfigurationChangeEvent> = this._onDidChangeConfiguration.event;

	constructor(
		private readonly _settingsPath: string,
		private readonly _fileService: IFileService,
		private readonly _logService: ILogService
	) {
		super();

		this._defaultModel = new ConfigurationModel(this._createDefaultTree());
		this._userModel = new ConfigurationModel(undefined);
		this._workspaceModel = new ConfigurationModel(undefined);
		this._merged = this._defaultModel.merge(this._userModel).merge(this._workspaceModel);
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
			workspaceValue: this._workspaceModel.getValue(key) as T | undefined,
			value: this._merged.getValue(key) as T | undefined
		};
	}

	getSettingsPath(): string {
		return this._settingsPath;
	}

	/** 10: point the workspace layer at `<folder>/.mini/settings.json` (null closes the folder) */
	setWorkspaceSettingsPath(settingsPath: string | null): void {
		if (this._workspaceSettingsPath === settingsPath) {
			return;
		}
		this._workspaceSettingsPath = settingsPath;
		this._workspaceModel = new ConfigurationModel(undefined);
		this._workspaceLastKnownDiskValue = null;
		this._applyMerged();
	}

	/** initial load; watcher-driven reloads go through `reload()` */
	async load(): Promise<void> {
		await this._reloadLayer(this._settingsPath, ConfigurationTarget.USER);
		if (this._workspaceSettingsPath) {
			await this._reloadLayer(this._workspaceSettingsPath, ConfigurationTarget.WORKSPACE);
		}
	}

	async reload(): Promise<void> {
		await this.load();
	}

	async updateValue(key: string, value: unknown, target: ConfigurationTarget = ConfigurationTarget.USER): Promise<void> {
		const isWorkspace = target === ConfigurationTarget.WORKSPACE;
		const settingsPath = isWorkspace ? this._workspaceSettingsPath : this._settingsPath;
		if (!settingsPath) {
			throw new Error(`configuration target ${ConfigurationTargetToString(target)} is not available (no folder open)`);
		}
		const currentModel = isWorkspace ? this._workspaceModel : this._userModel;

		// same value: no-op (the reference does the same)
		if (currentModel.getValue(key) === value) {
			return;
		}

		const text = (await this._readSettingsFile(settingsPath)) ?? '{}\n';

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

		await this._fileService.writeFile(URI.file(settingsPath), newText, { atomic: true });

		// apply immediately; the watcher will see this exact text and skip it
		if (isWorkspace) {
			this._workspaceLastKnownDiskValue = newText;
		} else {
			this._lastKnownDiskValue = newText;
		}
		const parsed = this._parseText(newText);
		if (parsed !== undefined) {
			this._applyLayerValues(parsed, target);
		}
	}

	private _readSettingsFile(settingsPath: string): Promise<string | null> {
		return this._fileService.readFile(URI.file(settingsPath)).then(text => text, () => null);
	}

	private async _reloadLayer(settingsPath: string, target: ConfigurationTarget): Promise<void> {
		const isWorkspace = target === ConfigurationTarget.WORKSPACE;
		let text: string | null = null;
		try {
			text = await this._readSettingsFile(settingsPath);
		} catch {
			text = null;
		}

		// unchanged text (including our own writes): nothing to do
		const lastKnown = isWorkspace ? this._workspaceLastKnownDiskValue : this._lastKnownDiskValue;
		if (text !== null && text === lastKnown) {
			return;
		}
		if (isWorkspace) {
			this._workspaceLastKnownDiskValue = text;
		} else {
			this._lastKnownDiskValue = text;
		}

		const values = text === null ? {} : this._parseText(text);
		if (values === undefined) {
			// invalid JSON: reported with line info; the last good model stays active
			return;
		}
		this._applyLayerValues(values, target);
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

	private _applyLayerValues(values: { [key: string]: unknown }, target: ConfigurationTarget): void {
		const newLayerModel = new ConfigurationModel(values);
		if (target === ConfigurationTarget.WORKSPACE) {
			this._workspaceModel = newLayerModel;
		} else {
			this._userModel = newLayerModel;
		}
		const before = this._merged;
		this._applyMerged();
		const change = before.compare(this._merged);
		if (change.keys.length > 0) {
			this._onDidChangeConfiguration.fire(new ConfigurationChangeEvent(target, change));
		}
	}

	private _applyMerged(): void {
		this._merged = this._defaultModel.merge(this._userModel).merge(this._workspaceModel);
	}
}
