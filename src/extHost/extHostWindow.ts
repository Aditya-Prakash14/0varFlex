// src/extHost/extHostWindow.ts — `window.showInformationMessage`/`showErrorMessage` + status bar
// items, ported in shape from vs/workbench/api/common/extHostMessageService.ts +
// extHostStatusBar.ts. Items are keyed `${extensionId}.${index}` so a second item never clobbers
// the first (the reference's identity rule).

import type { IMainThreadMessage, IMainThreadStatusBar } from './mainThreadTypes.js';
import type { IWireMessageSeverity, IWireStatusBarEntry } from '../common/platform/extensions/common/extensionHostProtocol.js';
import { Disposable, StatusBarAlignment } from './extHostTypes.js';

export class ExtHostStatusBarEntry extends Disposable {

	private readonly _id: string;
	private _visible = false;
	private _text = '';
	private _tooltip: string | undefined;
	private _command: string | undefined;

	constructor(
		private readonly _proxy: IMainThreadStatusBar,
		private readonly _extensionId: string,
		index: number,
		private readonly _alignment: StatusBarAlignment,
		private readonly _priority: number
	) {
		super(() => {
			void this._proxy.$disposeEntry(this._id).catch(() => { /* renderer gone */ });
		});
		this._id = `${_extensionId}.${index}`;
	}

	get id(): string {
		return this._id;
	}

	get text(): string {
		return this._text;
	}

	set text(value: string) {
		this._text = value;
		this._update();
	}

	get tooltip(): string | undefined {
		return this._tooltip;
	}

	set tooltip(value: string | undefined) {
		this._tooltip = value;
		this._update();
	}

	get command(): string | undefined {
		return this._command;
	}

	set command(value: string | undefined) {
		this._command = value;
		this._update();
	}

	show(): void {
		this._visible = true;
		this._update();
	}

	hide(): void {
		this._visible = false;
		void this._proxy.$disposeEntry(this._id).catch(() => { /* renderer gone */ });
	}

	private _update(): void {
		if (!this._visible) {
			return;
		}
		const entry: IWireStatusBarEntry = {
			text: this._text,
			tooltip: this._tooltip,
			command: this._command,
			alignment: this._alignment,
			priority: this._priority,
			extensionId: this._extensionId
		};
		void this._proxy.$setEntry(this._id, entry).catch(error => {
			console.error(`[${this._extensionId}] status bar update failed: ${(error as Error).message}`);
		});
	}
}

export class ExtHostWindow {

	private _statusBarItemIndex = 0;

	constructor(
		private readonly _messageProxy: IMainThreadMessage,
		private readonly _statusBarProxy: IMainThreadStatusBar
	) { }

	showMessage(severity: IWireMessageSeverity, message: string, items: string[]): Promise<string | undefined> {
		return this._messageProxy.$showMessage(severity, message, items);
	}

	createStatusBarItem(extensionId: string, alignment: StatusBarAlignment = StatusBarAlignment.Left, priority?: number): ExtHostStatusBarEntry {
		// the per-extension index: two items from one extension coexist (${extensionId}.${index})
		return new ExtHostStatusBarEntry(this._statusBarProxy, extensionId, ++this._statusBarItemIndex, alignment, priority ?? 0);
	}
}
