// src/renderer/workbench/browser/stateStore.ts — the shallow holder for the workbench's
// provisional state.json (single debounced writer, one slice per consumer).
//
// shortcut: ad-hoc state file; replaced by StorageService in 06

import { Disposable } from '../../../common/base/common/lifecycle.js';
import { URI } from '../../../common/base/common/uri.js';
import type { IFileIOChannel } from '../../../common/platform/fileIO/common/fileIO.js';
import type { ILogService } from '../../../common/platform/log/common/log.js';

export class StateStore extends Disposable {

	private _data: Record<string, unknown> = {};
	private _statePath: string | undefined;
	private _saveTimer: number | undefined;

	constructor(
		private readonly _fileIO: IFileIOChannel,
		private readonly _logService: ILogService
	) {
		super();
	}

	async load(): Promise<void> {
		try {
			const userDataPath = await this._fileIO.getUserDataPath();
			this._statePath = URI.joinPath(URI.file(userDataPath), 'state.json').fsPath;
			const raw = await this._fileIO.readTextFile(this._statePath);
			const parsed = raw ? JSON.parse(raw) : undefined;
			if (parsed && typeof parsed === 'object') {
				this._data = parsed;
			}
			// migrate the exercise-03 shape ({ sidebar, panel } at the top level) into the layout slice
			if ((this._data.sidebar || this._data.panel) && !this._data.layout) {
				this._data.layout = { sidebar: this._data.sidebar, panel: this._data.panel };
			}
			delete this._data.sidebar;
			delete this._data.panel;
		} catch (error) {
			this._logService.warn(`workbench state could not be loaded: ${(error as Error).message}`);
		}
	}

	get<T>(key: string): T | undefined {
		return this._data[key] as T | undefined;
	}

	set(key: string, value: unknown): void {
		this._data[key] = value;
		this._scheduleSave();
	}

	override dispose(): void {
		if (this._saveTimer !== undefined) {
			window.clearTimeout(this._saveTimer);
			this._saveTimer = undefined;
			void this._save();
		}
		super.dispose();
	}

	private _scheduleSave(): void {
		if (this._saveTimer !== undefined) {
			window.clearTimeout(this._saveTimer);
		}
		this._saveTimer = window.setTimeout(() => {
			this._saveTimer = undefined;
			void this._save();
		}, 300);
	}

	private async _save(): Promise<void> {
		if (!this._statePath) {
			return;
		}
		try {
			await this._fileIO.writeTextFile(this._statePath, JSON.stringify(this._data, null, '\t'));
		} catch (error) {
			this._logService.warn(`workbench state could not be saved: ${(error as Error).message}`);
		}
	}
}
