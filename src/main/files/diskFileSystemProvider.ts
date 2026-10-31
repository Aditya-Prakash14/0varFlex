// src/main/files/diskFileSystemProvider.ts — the node fs provider, ported in behavior from
// vs/platform/files/node/diskFileSystemProvider.ts:
//
//   - atomic writes: write `<name><postfix>` in the SAME directory, flush it (fsync — the
//     reference's write handles flush lazily; syncing before the rename matters on macOS), then
//     rename over the target; on rename failure the temp file is cleaned up;
//   - deletes default to the OS trash (Electron shell.trashItem) with a logged rm fallback for
//     volumes where trash is unavailable;
//   - rename keeps the reference's EXDEV fallback (copy + delete) and skips the Windows
//     retry-in-use dance (documented delta — mac-only app);
//   - node errors map to the ported FileSystemProviderErrorCode table.

import { shell } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { URI } from '../../common/base/common/uri.js';
import {
	FileSystemProviderError,
	FileSystemProviderErrorCode,
	FileType,
	IFileDeleteOptions,
	IFileStat,
	IFileSystemProvider,
	IFileWriteOptions,
	createFileSystemProviderError,
	newFileStat
} from '../../common/platform/files/common/files.js';

/** default atomic-write postfix (the reference's `IFileWriteOptions.atomic.postfix`) */
export const ATOMIC_WRITE_POSTFIX = '.tmp-write';

export function toFileSystemProviderError(error: NodeJS.ErrnoException): FileSystemProviderError {
	if (error instanceof FileSystemProviderError) {
		return error;
	}
	let code: FileSystemProviderErrorCode;
	switch (error.code) {
		case 'ENOENT':
			code = FileSystemProviderErrorCode.FileNotFound;
			break;
		case 'EISDIR':
			code = FileSystemProviderErrorCode.FileIsADirectory;
			break;
		case 'ENOTDIR':
			code = FileSystemProviderErrorCode.FileNotADirectory;
			break;
		case 'EEXIST':
			code = FileSystemProviderErrorCode.FileExists;
			break;
		case 'EPERM':
		case 'EACCES':
			code = FileSystemProviderErrorCode.NoPermissions;
			break;
		default:
			code = FileSystemProviderErrorCode.Unknown;
	}
	return createFileSystemProviderError(error, code);
}

function toFileType(stat: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileType {
	let type = FileType.Unknown;
	if (stat.isFile()) {
		type |= FileType.File;
	}
	if (stat.isDirectory()) {
		type |= FileType.Directory;
	}
	if (stat.isSymbolicLink()) {
		type |= FileType.SymbolicLink;
	}
	return type;
}

export class DiskFileSystemProvider implements IFileSystemProvider {

	private _log: (message: string) => void = () => { /* logging arrives via the channel */ };

	setLogger(log: (message: string) => void): void {
		this._log = log;
	}

	// ---- stat / readdir

	async stat(resource: URI): Promise<IFileStat> {
		try {
			const info = await fs.stat(resource.fsPath);
			return newFileStat(resource, path.basename(resource.fsPath), toFileType(info), info.mtimeMs, info.size);
		} catch (error) {
			throw toFileSystemProviderError(error as NodeJS.ErrnoException);
		}
	}

	async readdir(resource: URI): Promise<readonly { name: string; type: FileType }[]> {
		try {
			const entries = await fs.readdir(resource.fsPath, { withFileTypes: true });
			// the platform's order is kept; the explorer sorts folders-first itself
			return entries.map(entry => ({ name: entry.name, type: toDirentType(entry) }));
		} catch (error) {
			throw toFileSystemProviderError(error as NodeJS.ErrnoException);
		}
	}

	// ---- read / write

	async readFile(resource: URI): Promise<string> {
		try {
			return await fs.readFile(resource.fsPath, 'utf8');
		} catch (error) {
			throw toFileSystemProviderError(error as NodeJS.ErrnoException);
		}
	}

	async writeFile(resource: URI, content: string, options: IFileWriteOptions): Promise<void> {
		const postfix = typeof options.atomic === 'object'
			? options.atomic.postfix
			: (options.atomic ? ATOMIC_WRITE_POSTFIX : undefined);
		if (!postfix) {
			return this._doWriteFile(resource, content, options);
		}
		const tempPath = path.join(path.dirname(resource.fsPath), path.basename(resource.fsPath) + postfix);
		try {
			// 1. write the temp file and flush it to disk
			await this._doWriteFile(URI.file(tempPath), content, { overwrite: true });
			const handle = await fs.open(tempPath, 'r');
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
			// 2. atomic replace
			await fs.rename(tempPath, resource.fsPath);
		} catch (error) {
			// cleanup must not mask the original failure
			await fs.rm(tempPath, { force: true }).catch(() => { /* already gone */ });
			throw toFileSystemProviderError(error as NodeJS.ErrnoException);
		}
	}

	private async _doWriteFile(resource: URI, content: string, options: IFileWriteOptions): Promise<void> {
		try {
			if (options.overwrite === false && await this._exists(resource.fsPath)) {
				throw createFileSystemProviderError('File already exists', FileSystemProviderErrorCode.FileExists);
			}
			await fs.writeFile(resource.fsPath, content, 'utf8');
		} catch (error) {
			throw toFileSystemProviderError(error as NodeJS.ErrnoException);
		}
	}

	// ---- delete / create / rename / copy

	async delete(resource: URI, options: IFileDeleteOptions): Promise<void> {
		if (options.useTrash) {
			try {
				await shell.trashItem(resource.fsPath);
				return;
			} catch (error) {
				// trash is unavailable on some volumes — fall back to a plain delete, loudly
				this._log(`trash failed for ${resource.fsPath} (${(error as Error).message}), falling back to rm`);
			}
		}
		try {
			await fs.rm(resource.fsPath, { recursive: true, force: false });
		} catch (error) {
			throw toFileSystemProviderError(error as NodeJS.ErrnoException);
		}
	}

	async createFolder(resource: URI): Promise<void> {
		try {
			await fs.mkdir(resource.fsPath, { recursive: true });
		} catch (error) {
			throw toFileSystemProviderError(error as NodeJS.ErrnoException);
		}
	}

	async rename(from: URI, to: URI, options: { overwrite: boolean }): Promise<void> {
		if (from.fsPath === to.fsPath) {
			return; // node.js behavior: a no-op when paths match
		}
		try {
			// case-only renames skip the exists check: on case-insensitive volumes the target
			// "exists" (it IS the source) and the rename itself is legal (the reference's
			// validateMoveCopy does the same dance)
			const caseOnly = from.fsPath.toLowerCase() === to.fsPath.toLowerCase();
			if (!options.overwrite && !caseOnly && await this._exists(to.fsPath)) {
				throw createFileSystemProviderError('File already exists', FileSystemProviderErrorCode.FileExists);
			}
			await fs.rename(from.fsPath, to.fsPath);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'EXDEV') {
				// different devices: fall back to copy + delete (the reference does the same)
				await this._copyFile(from, to);
				await this.delete(from, { useTrash: false });
				return;
			}
			throw toFileSystemProviderError(error as NodeJS.ErrnoException);
		}
	}

	async clone(from: URI, to: URI, options: { overwrite: boolean }): Promise<void> {
		if (from.fsPath === to.fsPath) {
			return;
		}
		if (!options.overwrite && await this._exists(to.fsPath)) {
			throw createFileSystemProviderError('File already exists', FileSystemProviderErrorCode.FileExists);
		}
		await this._copyFile(from, to);
	}

	private async _copyFile(from: URI, to: URI): Promise<void> {
		try {
			await fs.copyFile(from.fsPath, to.fsPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				// maybe `to`'s directory does not exist yet (the reference clones with mkdir first)
				await fs.mkdir(path.dirname(to.fsPath), { recursive: true });
				await fs.copyFile(from.fsPath, to.fsPath).catch(nested => {
					throw toFileSystemProviderError(nested as NodeJS.ErrnoException);
				});
				return;
			}
			throw toFileSystemProviderError(error as NodeJS.ErrnoException);
		}
	}

	private async _exists(fsPath: string): Promise<boolean> {
		try {
			await fs.access(fsPath);
			return true;
		} catch {
			return false;
		}
	}
}

function toDirentType(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileType {
	return toFileType(entry);
}
