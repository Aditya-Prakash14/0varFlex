// src/extHost/extHostSCM.ts — the host half of the source control API, ported in subset from
// vs/workbench/api/common/extHostSCM.ts:
//
//   - `createSourceControl` hands back a handle with an input box, resource groups and an
//     `acceptInputCommand`; mutating any of them schedules ONE flush to the workbench, because
//     an extension setting three groups in a row must not cause three repaints;
//   - the workbench never learns what git is: a resource row carries a COMMAND id the extension
//     registered, and clicking it executes that command. That indirection is the whole lesson.
//
// delta: the real API has quickDiffProvider, `statusBarCommands`, per-resource decorations with
// icons/colors/strikethrough and resource-group `hideWhenEmpty`. Ours carries a status letter
// and a tooltip, which is what the view renders.
//
// shortcut: no `SourceControlResourceDecorations` theming — the letter drives the colour in CSS.

import type { IWireScmResourceGroup, IWireSourceControl } from '../common/platform/extensions/common/extensionHostProtocol.js';
import type { IMainThreadSCM } from './mainThreadTypes.js';
import { Disposable, EventEmitter, Uri } from './extHostTypes.js';

export interface ISourceControlResourceState {
	readonly resourceUri: Uri;
	readonly decorations?: { readonly tooltip?: string; readonly letter?: string };
	readonly command?: { readonly command: string; readonly arguments?: readonly unknown[] };
}

class ExtHostSourceControlResourceGroup {

	private _resourceStates: readonly ISourceControlResourceState[] = [];

	constructor(readonly id: string, public label: string, private readonly _onChange: () => void) { }

	get resourceStates(): readonly ISourceControlResourceState[] {
		return this._resourceStates;
	}

	set resourceStates(states: readonly ISourceControlResourceState[]) {
		this._resourceStates = states;
		this._onChange();
	}

	toWire(): IWireScmResourceGroup {
		return {
			id: this.id,
			label: this.label,
			resources: this._resourceStates.map(state => ({
				path: state.resourceUri.fsPath,
				letter: state.decorations?.letter ?? '',
				tooltip: state.decorations?.tooltip,
				command: state.command ? { id: state.command.command, args: state.command.arguments } : undefined
			}))
		};
	}

	dispose(): void {
		this._resourceStates = [];
		this._onChange();
	}
}

class ExtHostInputBox {

	private _value = '';

	constructor(public placeholder: string, private readonly _onChange: () => void) { }

	get value(): string {
		return this._value;
	}

	set value(value: string) {
		if (this._value !== value) {
			this._value = value;
			this._onChange();
		}
	}

	/** the workbench typed into it: update without echoing back (that would fight the caret) */
	acceptFromWorkbench(value: string): void {
		this._value = value;
	}
}

export class ExtHostSourceControl {

	readonly inputBox: ExtHostInputBox;
	acceptInputCommand: { command: string; arguments?: readonly unknown[] } | undefined;
	count = 0;

	private readonly _groups = new Map<string, ExtHostSourceControlResourceGroup>();
	private _disposed = false;

	constructor(
		readonly handle: number,
		readonly id: string,
		readonly label: string,
		readonly rootUri: Uri | undefined,
		private readonly _scheduleFlush: () => void
	) {
		this.inputBox = new ExtHostInputBox('Message (press Ctrl+Enter to commit)', () => this.update());
	}

	createResourceGroup(id: string, label: string): ExtHostSourceControlResourceGroup {
		const group = new ExtHostSourceControlResourceGroup(id, label, () => this.update());
		this._groups.set(id, group);
		this.update();
		return group;
	}

	/** push the current state to the workbench (coalesced) */
	update(): void {
		if (!this._disposed) {
			this._scheduleFlush();
		}
	}

	toWire(): IWireSourceControl {
		const groups = [...this._groups.values()].map(group => group.toWire());
		return {
			id: this.id,
			label: this.label,
			rootPath: this.rootUri?.fsPath,
			groups,
			inputBoxPlaceholder: this.inputBox.placeholder,
			inputBoxValue: this.inputBox.value,
			acceptCommand: this.acceptInputCommand
				? { id: this.acceptInputCommand.command, args: this.acceptInputCommand.arguments }
				: undefined,
			count: this.count || groups.reduce((total, group) => total + group.resources.length, 0)
		};
	}

	markDisposed(): void {
		this._disposed = true;
	}

	get isDisposed(): boolean {
		return this._disposed;
	}
}

export class ExtHostSCM {

	private readonly _onDidChangeInputBox = new EventEmitter<ExtHostSourceControl>();
	readonly onDidChangeInputBox = this._onDidChangeInputBox.event;

	private readonly _sourceControls = new Map<number, ExtHostSourceControl>();
	private _handlePool = 0;
	private readonly _dirty = new Set<number>();
	private _flushTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly _proxy: IMainThreadSCM, private readonly _onError: (message: string) => void) { }

	createSourceControl(id: string, label: string, rootUri?: Uri): ExtHostSourceControl & { dispose(): void } {
		const handle = this._handlePool++;
		const control = new ExtHostSourceControl(handle, id, label, rootUri, () => this._scheduleFlush(handle));
		this._sourceControls.set(handle, control);

		void this._proxy.$registerSourceControl(handle, id, label, rootUri?.fsPath)
			.catch(error => this._onError(`scm: registering '${id}' failed: ${(error as Error).message}`));

		const disposable = new Disposable(() => {
			control.markDisposed();
			this._sourceControls.delete(handle);
			this._dirty.delete(handle);
			void this._proxy.$unregisterSourceControl(handle).catch(() => { /* renderer gone */ });
		});

		// the handle IS the source control, with dispose() mixed in (the real API does the same)
		return Object.assign(control, { dispose: () => disposable.dispose() });
	}

	/** the workbench's input box changed: mirror it so the accept command can read it */
	$acceptInputBoxValue(handle: number, value: string): void {
		const control = this._sourceControls.get(handle);
		if (!control) {
			return;
		}
		control.inputBox.acceptFromWorkbench(value);
		this._onDidChangeInputBox.fire(control);
	}

	disposeAll(): void {
		if (this._flushTimer !== undefined) {
			clearTimeout(this._flushTimer);
			this._flushTimer = undefined;
		}
		this._dirty.clear();
		for (const control of this._sourceControls.values()) {
			control.markDisposed();
		}
		this._sourceControls.clear();
	}

	// ---- coalescing: many mutations in one turn become one $updateSourceControl

	private _scheduleFlush(handle: number): void {
		this._dirty.add(handle);
		if (this._flushTimer !== undefined) {
			return;
		}
		this._flushTimer = setTimeout(() => {
			this._flushTimer = undefined;
			const handles = [...this._dirty];
			this._dirty.clear();
			for (const dirtyHandle of handles) {
				const control = this._sourceControls.get(dirtyHandle);
				if (!control || control.isDisposed) {
					continue;
				}
				void this._proxy.$updateSourceControl(dirtyHandle, control.toWire())
					.catch(error => this._onError(`scm: update failed: ${(error as Error).message}`));
			}
		}, 0);
	}
}
