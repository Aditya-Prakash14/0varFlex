// src/common/platform/workspace/common/workspace.ts — the workspace context, ported in shape
// from vs/platform/workspace/common/workspace.ts: a workspace is a set of folders, and the
// context service publishes folder changes. Course scope: a SINGLE folder.
//
// delta: the real workspace settings live in `<folder>/.vscode/settings.json`; we use
// `<folder>/.mini/settings.json` so the app never touches a real VS Code workspace's files.

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';

export interface IWorkspaceFolder {
	readonly uri: URI;
	readonly name: string;
	readonly index: number;
}

export interface IWorkspace {
	readonly folders: readonly IWorkspaceFolder[];
}

export interface IWorkspaceFoldersChangeEvent {
	readonly added: readonly IWorkspaceFolder[];
	readonly removed: readonly IWorkspaceFolder[];
}

export const MINI_WORKSPACE_FOLDER = '.mini';

export function folderNameFromUri(uri: URI): string {
	const segments = uri.fsPath.replace(/[\\/]+$/, '').split(/[\\/]/);
	return segments[segments.length - 1] || uri.fsPath;
}

export function createWorkspaceFolder(uri: URI, index: number = 0): IWorkspaceFolder {
	return { uri, name: folderNameFromUri(uri), index };
}

export function workspaceSettingsUri(folder: IWorkspaceFolder): URI {
	return URI.joinPath(folder.uri, MINI_WORKSPACE_FOLDER, 'settings.json');
}

export class WorkspaceContextService extends Disposable {

	private _folders: IWorkspaceFolder[] = [];

	private readonly _onDidChangeWorkspaceFolders = this._register(new Emitter<IWorkspaceFoldersChangeEvent>());
	readonly onDidChangeWorkspaceFolders: Event<IWorkspaceFoldersChangeEvent> = this._onDidChangeWorkspaceFolders.event;

	getWorkspace(): IWorkspace {
		return { folders: this._folders };
	}

	get folder(): IWorkspaceFolder | undefined {
		return this._folders[0];
	}

	/** open (or close, with undefined) the course's single folder */
	setFolder(uri: URI | undefined): void {
		if (!uri) {
			if (this._folders.length === 0) {
				return;
			}
			const removed = this._folders;
			this._folders = [];
			this._onDidChangeWorkspaceFolders.fire({ added: [], removed });
			return;
		}
		if (this._folders.length === 1 && this._folders[0].uri.toString() === uri.toString()) {
			return;
		}
		const removed = this._folders;
		const added = [createWorkspaceFolder(uri, 0)];
		this._folders = added;
		this._onDidChangeWorkspaceFolders.fire({ added, removed });
	}
}
