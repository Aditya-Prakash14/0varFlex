// src/common/platform/files/common/files.ts — the file stack contract, ported in shape from
// vs/platform/files/common/files.ts. Values are the reference's (FileType flags, FileChangeType
// order, FileOperationResult order, FileSystemProviderErrorCode strings).
//
// delta vs real: string-only content (no VSBuffer/streams), no etag, no file permissions, no
// IFileService.readFileStream; everything that crosses a channel is JSON-safe (paths as strings,
// see fileIpc.ts).

import { Emitter, Event } from '../../../base/common/event.js';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';

// ---- file types & stats

/** ported flags: a symlink can ALSO carry File and/or Directory */
export const enum FileType {
	Unknown = 0,
	File = 1,
	Directory = 2,
	SymbolicLink = 64
}

export interface IFileStat {
	readonly resource: URI;
	readonly name: string;
	readonly type: FileType;
	readonly mtime: number;
	readonly size: number;
	readonly isFile: boolean;
	readonly isDirectory: boolean;
	readonly children?: IFileStat[];
}

export function newFileStat(resource: URI, name: string, type: FileType, mtime: number, size: number, children?: IFileStat[]): IFileStat {
	return {
		resource,
		name,
		type,
		mtime,
		size,
		isFile: (type & FileType.File) !== 0,
		isDirectory: (type & FileType.Directory) !== 0,
		children
	};
}

export interface IResolveFileOptions {
	/** also read the children of a directory (one level) */
	readonly resolveMetadata?: boolean;
}

// ---- changes

/** ported order: UPDATED=0, ADDED=1, DELETED=2 */
export const enum FileChangeType {
	UPDATED,
	ADDED,
	DELETED
}

export interface IFileChange {
	readonly resource: URI;
	readonly type: FileChangeType;
}

export class FileChangesEvent {

	readonly changes: readonly IFileChange[];

	constructor(changes: readonly IFileChange[]) {
		this.changes = changes;
	}

	/** any change for this resource? */
	contains(resource: URI, type?: FileChangeType): boolean {
		return this.changes.some(change =>
			change.resource.toString() === resource.toString()
			&& (type === undefined || change.type === type));
	}

	/** any change inside this directory? */
	affects(resource: URI): boolean {
		const prefix = resource.toString() + '/';
		return this.changes.some(change => change.resource.toString().startsWith(prefix));
	}
}

// ---- operations

export const enum FileOperation {
	CREATE,
	DELETE,
	MOVE,
	COPY,
	WRITE
}

export interface IFileOperationEvent {
	readonly resource: URI;
	readonly operation: FileOperation;
	/** for moves/copies */
	readonly target?: URI;
}

export interface IFileWriteOptions {
	/** write to `<name><postfix>` then rename over the target (postfix implies atomic) */
	readonly atomic?: boolean | { readonly postfix: string };
	readonly overwrite?: boolean;
}

export interface IFileDeleteOptions {
	/** move to the OS trash (default true); falls back to plain delete where unsupported */
	readonly useTrash: boolean;
	readonly recursive?: boolean;
}

export interface IWatchOptions {
	readonly recursive?: boolean;
	readonly excludes?: string[];
}

// ---- errors

/** ported names from FileSystemProviderErrorCode */
export const enum FileSystemProviderErrorCode {
	FileExists = 'FileExists',
	FileNotFound = 'FileNotFound',
	FileNotADirectory = 'FileNotADirectory',
	FileIsADirectory = 'FileIsADirectory',
	NoPermissions = 'NoPermissions',
	FileWriteLocked = 'FileWriteLocked',
	Unknown = 'Unknown'
}

/** ported order from FileOperationResult */
export const enum FileOperationResult {
	FILE_IS_DIRECTORY,
	FILE_NOT_FOUND,
	FILE_NOT_MODIFIED_SINCE,
	FILE_MODIFIED_SINCE,
	FILE_MOVE_CONFLICT,
	FILE_WRITE_LOCKED,
	FILE_PERMISSION_DENIED,
	FILE_TOO_LARGE,
	FILE_INVALID_PATH,
	FILE_NOT_DIRECTORY,
	FILE_OTHER_ERROR
}

export class FileOperationError extends Error {
	constructor(message: string, readonly fileOperationResult: FileOperationResult, readonly options?: { path?: string }) {
		super(message);
		this.name = 'FileOperationError';
	}
}

export function mapProviderErrorToOperationResult(code: FileSystemProviderErrorCode): FileOperationResult {
	switch (code) {
		case FileSystemProviderErrorCode.FileNotFound:
			return FileOperationResult.FILE_NOT_FOUND;
		case FileSystemProviderErrorCode.FileIsADirectory:
			return FileOperationResult.FILE_IS_DIRECTORY;
		case FileSystemProviderErrorCode.FileNotADirectory:
			return FileOperationResult.FILE_NOT_DIRECTORY;
		case FileSystemProviderErrorCode.NoPermissions:
			return FileOperationResult.FILE_PERMISSION_DENIED;
		case FileSystemProviderErrorCode.FileExists:
			return FileOperationResult.FILE_MOVE_CONFLICT;
		case FileSystemProviderErrorCode.FileWriteLocked:
			return FileOperationResult.FILE_WRITE_LOCKED;
		default:
			return FileOperationResult.FILE_OTHER_ERROR;
	}
}

// ---- the service

export interface IFileService {

	readonly onDidFilesChange: Event<FileChangesEvent>;
	readonly onDidRunOperation: Event<IFileOperationEvent>;

	readFile(resource: URI): Promise<string>;
	writeFile(resource: URI, content: string, options?: IFileWriteOptions): Promise<void>;
	del(resource: URI, options?: IFileDeleteOptions): Promise<void>;
	exists(resource: URI): Promise<boolean>;
	resolve(resource: URI, options?: IResolveFileOptions): Promise<IFileStat>;
	createFolder(resource: URI): Promise<IFileStat>;
	move(source: URI, target: URI, overwrite?: boolean): Promise<void>;
	copy(source: URI, target: URI, overwrite?: boolean): Promise<void>;

	/** watch a file or folder; returns the watch id to unwatch with. Events arrive on onDidFilesChange */
	watch(resource: URI, options?: IWatchOptions): Promise<number>;
	unwatch(watchId: number): Promise<void>;
}

// ---- the provider (what the disk implementation in main satisfies)

export interface IFileSystemProvider {

	stat(resource: URI): Promise<IFileStat>;
	readdir(resource: URI): Promise<readonly { name: string; type: FileType }[]>;
	readFile(resource: URI): Promise<string>;
	writeFile(resource: URI, content: string, options: IFileWriteOptions): Promise<void>;
	delete(resource: URI, options: IFileDeleteOptions): Promise<void>;
	createFolder(resource: URI): Promise<void>;
	rename(from: URI, to: URI, options: { overwrite: boolean }): Promise<void>;
	/** optional: file-level copy */
	clone?(from: URI, to: URI, options: { overwrite: boolean }): Promise<void>;
}

/** thrown by providers; carries the ported error code across to FileOperationError */
export class FileSystemProviderError extends Error {
	constructor(message: string, readonly code: FileSystemProviderErrorCode) {
		super(message);
		this.name = 'FileSystemProviderError';
	}
}

export function createFileSystemProviderError(error: Error | string, code: FileSystemProviderErrorCode): FileSystemProviderError {
	return new FileSystemProviderError(typeof error === 'string' ? error : error.message, code);
}

/** helper for callers that need a one-off event */
export function toFileChangesEvent(changes: readonly IFileChange[]): FileChangesEvent {
	return new FileChangesEvent(changes);
}

/**
 * Collapse duplicate separators in a file path (`…/T//folder` → `…/T/folder`). Boundaries must
 * agree on ONE spelling: the main process normalizes via `path.join`, so a renderer that opened
 * a folder from a script-generated `$DIR/` path would otherwise keep its own key vocabulary and
 * every later path comparison (remap, watcher fan-out) would miss.
 */
export function normalizeFileResource(resource: URI): URI {
	const fsPath = resource.fsPath;
	const collapsed = fsPath.replace(/\/{2,}/g, '/');
	return collapsed === fsPath ? resource : URI.file(collapsed);
}
