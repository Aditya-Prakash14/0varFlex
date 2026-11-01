// src/renderer/workbench/services/scm/common/scmService.ts — the generic SCM model, ported in
// subset from vs/workbench/contrib/scm/common/scmService.ts:
//
//   - repositories are registered BY PROVIDERS (the extension host here), never by the
//     workbench; this file contains no git concept and no `child_process`;
//   - a resource row carries a command id the provider owns, so "open the diff" is the
//     extension's business and the view just executes what it was handed;
//   - the input box is two-way: the workbench owns the caret, the provider reads the value.
//
// delta: no ISCMProvider contextValue/statusBarCommands, no quick diff, no per-repository
// selection or sorting. One repository is the realistic case for a single-folder workspace.

import { Emitter, Event } from '../../../../../common/base/common/event.js';
import { Disposable } from '../../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../../common/base/common/uri.js';
import type { IWireSourceControl } from '../../../../../common/platform/extensions/common/extensionHostProtocol.js';

export interface ISCMResource {
	readonly resource: URI;
	readonly letter: string;
	readonly tooltip?: string;
	readonly command?: { readonly id: string; readonly args?: readonly unknown[] };
}

export interface ISCMResourceGroup {
	readonly id: string;
	readonly label: string;
	readonly resources: readonly ISCMResource[];
}

export interface ISCMRepository {
	readonly handle: number;
	readonly id: string;
	readonly label: string;
	readonly rootPath?: string;
	readonly groups: readonly ISCMResourceGroup[];
	readonly inputBoxPlaceholder: string;
	readonly inputBoxValue: string;
	readonly acceptCommand?: { readonly id: string; readonly args?: readonly unknown[] };
	readonly count: number;
}

export class SCMService extends Disposable {

	private readonly _repositories = new Map<number, ISCMRepository>();

	private readonly _onDidChangeRepositories = this._register(new Emitter<void>());
	readonly onDidChangeRepositories: Event<void> = this._onDidChangeRepositories.event;

	/** set by the workbench wiring: how to reach the provider's host */
	private _inputSink: ((handle: number, value: string) => void) | undefined;

	setInputSink(sink: (handle: number, value: string) => void): void {
		this._inputSink = sink;
	}

	get repositories(): readonly ISCMRepository[] {
		return [...this._repositories.values()];
	}

	/** the first (and, for a single-folder workspace, only) repository */
	get activeRepository(): ISCMRepository | undefined {
		return this._repositories.values().next().value;
	}

	// ---- called by MainThreadSCM

	registerSourceControl(handle: number, id: string, label: string, rootPath?: string): void {
		this._repositories.set(handle, {
			handle,
			id,
			label,
			rootPath,
			groups: [],
			inputBoxPlaceholder: 'Message (press Ctrl+Enter to commit)',
			inputBoxValue: '',
			count: 0
		});
		this._onDidChangeRepositories.fire();
	}

	unregisterSourceControl(handle: number): void {
		if (this._repositories.delete(handle)) {
			this._onDidChangeRepositories.fire();
		}
	}

	updateSourceControl(handle: number, state: IWireSourceControl): void {
		const existing = this._repositories.get(handle);
		if (!existing) {
			return; // an update racing an unregister
		}
		this._repositories.set(handle, {
			handle,
			id: state.id,
			label: state.label,
			rootPath: state.rootPath,
			groups: state.groups.map(group => ({
				id: group.id,
				label: group.label,
				resources: group.resources.map(resource => ({
					resource: URI.file(resource.path),
					letter: resource.letter,
					tooltip: resource.tooltip,
					command: resource.command
				}))
			})),
			inputBoxPlaceholder: state.inputBoxPlaceholder,
			// the workbench owns the caret: keep what the user is typing rather than echoing the
			// provider's copy back and resetting the cursor mid-word
			inputBoxValue: existing.inputBoxValue,
			acceptCommand: state.acceptCommand,
			count: state.count
		});
		this._onDidChangeRepositories.fire();
	}

	// ---- called by the view

	/** the user typed: keep it locally and mirror it to the provider */
	setInputBoxValue(handle: number, value: string): void {
		const existing = this._repositories.get(handle);
		if (!existing || existing.inputBoxValue === value) {
			return;
		}
		this._repositories.set(handle, { ...existing, inputBoxValue: value });
		this._inputSink?.(handle, value);
	}

	/** after a successful commit the provider clears the box through here */
	clearInputBox(handle: number): void {
		const existing = this._repositories.get(handle);
		if (existing && existing.inputBoxValue !== '') {
			this._repositories.set(handle, { ...existing, inputBoxValue: '' });
			this._inputSink?.(handle, '');
			this._onDidChangeRepositories.fire();
		}
	}
}
