// tests/harness/fileSystem.ts — an in-memory IFileSystemProvider + a real FileService over it.
// Three test files drive the actual service paths through this (the reference ships the same
// idea as inMemoryFilesystemProvider.ts).

import { URI } from '../../src/common/base/common/uri.js';
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
} from '../../src/common/platform/files/common/files.js';
import { FileService } from '../../src/common/platform/files/common/fileService.js';

interface IEntry {
	type: FileType;
	content: string;
	mtime: number;
}

export class InMemoryFileSystemProvider implements IFileSystemProvider {

	private readonly _entries = new Map<string, IEntry>();
	private _clock = 1000;

	// ---- test helpers

	setFolder(path: string): void {
		this._ensureParents(path);
		this._entries.set(path, { type: FileType.Directory, content: '', mtime: ++this._clock });
	}

	setFile(path: string, content: string): void {
		this._ensureParents(path);
		this._entries.set(path, { type: FileType.File, content, mtime: ++this._clock });
	}

	getFile(path: string): string | undefined {
		return this._entries.get(path)?.content;
	}

	has(path: string): boolean {
		return this._entries.has(path);
	}

	paths(): string[] {
		return [...this._entries.keys()].sort();
	}

	private _ensureParents(path: string): void {
		const segments = path.split('/').filter(Boolean);
		segments.pop();
		let current = '';
		for (const segment of segments) {
			current += '/' + segment;
			if (!this._entries.has(current)) {
				this._entries.set(current, { type: FileType.Directory, content: '', mtime: ++this._clock });
			}
		}
	}

	private _entry(path: string): IEntry {
		const entry = this._entries.get(path);
		if (!entry) {
			throw createFileSystemProviderError(`no such file: ${path}`, FileSystemProviderErrorCode.FileNotFound);
		}
		return entry;
	}

	// ---- provider

	async stat(resource: URI): Promise<IFileStat> {
		const entry = this._entry(resource.fsPath);
		const name = resource.fsPath.split('/').filter(Boolean).pop() ?? resource.fsPath;
		return newFileStat(resource, name, entry.type, entry.mtime, entry.content.length);
	}

	async readdir(resource: URI): Promise<readonly { name: string; type: FileType }[]> {
		const entry = this._entry(resource.fsPath);
		if (!(entry.type & FileType.Directory)) {
			throw createFileSystemProviderError('not a directory', FileSystemProviderErrorCode.FileNotADirectory);
		}
		const prefix = resource.fsPath.endsWith('/') ? resource.fsPath : resource.fsPath + '/';
		const children: { name: string; type: FileType }[] = [];
		for (const [path, candidate] of this._entries) {
			if (!path.startsWith(prefix)) {
				continue;
			}
			const rest = path.substring(prefix.length);
			if (rest.length === 0 || rest.includes('/')) {
				continue;
			}
			children.push({ name: rest, type: candidate.type });
		}
		return children;
	}

	async readFile(resource: URI): Promise<string> {
		const entry = this._entry(resource.fsPath);
		if (entry.type & FileType.Directory) {
			throw createFileSystemProviderError('is a directory', FileSystemProviderErrorCode.FileIsADirectory);
		}
		return entry.content;
	}

	async writeFile(resource: URI, content: string, options: IFileWriteOptions): Promise<void> {
		const existing = this._entries.get(resource.fsPath);
		if (existing && existing.type & FileType.Directory) {
			throw createFileSystemProviderError('is a directory', FileSystemProviderErrorCode.FileIsADirectory);
		}
		if (!existing && options.overwrite === false && this._entries.has(resource.fsPath)) {
			throw createFileSystemProviderError('file exists', FileSystemProviderErrorCode.FileExists);
		}
		this._ensureParents(resource.fsPath);
		this._entries.set(resource.fsPath, { type: FileType.File, content, mtime: ++this._clock });
	}

	async delete(resource: URI, _options: IFileDeleteOptions): Promise<void> {
		this._entry(resource.fsPath);
		const prefix = resource.fsPath + '/';
		for (const path of [...this._entries.keys()]) {
			if (path === resource.fsPath || path.startsWith(prefix)) {
				this._entries.delete(path);
			}
		}
	}

	async createFolder(resource: URI): Promise<void> {
		this._ensureParents(resource.fsPath);
		this._entries.set(resource.fsPath, { type: FileType.Directory, content: '', mtime: ++this._clock });
	}

	async rename(from: URI, to: URI, options: { overwrite: boolean }): Promise<void> {
		const entry = this._entry(from.fsPath);
		if (!options.overwrite && this._entries.has(to.fsPath)) {
			throw createFileSystemProviderError('target exists', FileSystemProviderErrorCode.FileExists);
		}
		this._ensureParents(to.fsPath);
		const prefix = from.fsPath + '/';
		const moves: [string, IEntry][] = [[to.fsPath, entry]];
		for (const [path, candidate] of this._entries) {
			if (path.startsWith(prefix)) {
				moves.push([to.fsPath + path.substring(from.fsPath.length), candidate]);
			}
		}
		for (const [path] of moves) {
			if (path === from.fsPath || path.startsWith(prefix)) {
				this._entries.delete(path);
			}
		}
		for (const [path, candidate] of moves) {
			this._entries.set(path, candidate);
		}
	}

	async clone(from: URI, to: URI, options: { overwrite: boolean }): Promise<void> {
		const entry = this._entry(from.fsPath);
		if (entry.type & FileType.Directory) {
			throw createFileSystemProviderError('directory copy is not supported', FileSystemProviderErrorCode.Unknown);
		}
		if (!options.overwrite && this._entries.has(to.fsPath)) {
			throw createFileSystemProviderError('target exists', FileSystemProviderErrorCode.FileExists);
		}
		this._ensureParents(to.fsPath);
		this._entries.set(to.fsPath, { ...entry, mtime: ++this._clock });
	}
}

export function createTestFileService(): { fileService: FileService; fs: InMemoryFileSystemProvider } {
	const fs = new InMemoryFileSystemProvider();
	const fileService = new FileService();
	fileService.registerProvider('file', fs);
	return { fileService, fs };
}

export { FileSystemProviderError };
