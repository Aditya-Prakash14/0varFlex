// src/common/platform/files/common/fileService.ts — the FileService, ported in shape from
// vs/platform/files/common/fileService.ts: a provider registry keyed by scheme, operations that
// resolve the provider and delegate, error normalization into FileOperationError, and the
// onDidRunOperation event so UI can react before watcher events arrive.
//
// The provider registry is refcounted exactly like the reference's registerProvider (which
// exists because several features register the same scheme; the last dispose unregisters).

import { Emitter, Event } from '../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import {
	FileChangesEvent,
	FileOperation,
	FileOperationError,
	FileOperationResult,
	FileSystemProviderError,
	FileSystemProviderErrorCode,
	IFileChange,
	IFileDeleteOptions,
	IFileOperationEvent,
	IFileService,
	IFileStat,
	IFileSystemProvider,
	IFileWriteOptions,
	IResolveFileOptions,
	IWatchOptions,
	createFileSystemProviderError,
	mapProviderErrorToOperationResult,
	newFileStat
} from './files.js';
import type { FileWatcherService } from './watcher.js';

interface IProviderRegistration {
	readonly provider: IFileSystemProvider;
	registrations: number;
}

export class FileService implements IFileService {

	protected readonly _onDidFilesChange = new Emitter<FileChangesEvent>();
	readonly onDidFilesChange: Event<FileChangesEvent> = this._onDidFilesChange.event;
	protected readonly _onDidRunOperation = new Emitter<IFileOperationEvent>();
	readonly onDidRunOperation: Event<IFileOperationEvent> = this._onDidRunOperation.event;

	private readonly _providers = new Map<string, IProviderRegistration>();
	private _watcher: FileWatcherService | undefined;

	constructor() { }

	/** the main process wires its watcher service in; the renderer never has one */
	setWatcher(watcher: FileWatcherService): void {
		this._watcher = watcher;
	}

	/** the watcher's flush lands here (main side) */
	fireFileChanges(changes: readonly IFileChange[]): void {
		this._onDidFilesChange.fire(new FileChangesEvent(changes));
	}

	// ---- provider registry

	registerProvider(scheme: string, provider: IFileSystemProvider): IDisposable {
		const existing = this._providers.get(scheme);
		if (existing) {
			existing.registrations++;
			return this._unregisterProvider(scheme);
		}
		this._providers.set(scheme, { provider, registrations: 1 });
		return this._unregisterProvider(scheme);
	}

	private _unregisterProvider(scheme: string): IDisposable {
		let disposed = false;
		return toDisposable(() => {
			if (disposed) {
				return;
			}
			disposed = true;
			const registration = this._providers.get(scheme);
			if (!registration) {
				return;
			}
			registration.registrations--;
			if (registration.registrations === 0) {
				this._providers.delete(scheme);
			}
		});
	}

	private _provider(resource: URI): IFileSystemProvider {
		const registration = this._providers.get(resource.scheme);
		if (!registration) {
			throw new FileOperationError(`No file system provider for the scheme '${resource.scheme}'`, FileOperationResult.FILE_OTHER_ERROR, { path: resource.fsPath });
		}
		return registration.provider;
	}

	protected _wrapError(error: unknown, resource: URI): FileOperationError {
		if (error instanceof FileOperationError) {
			return error;
		}
		if (error instanceof FileSystemProviderError) {
			return new FileOperationError(error.message, mapProviderErrorToOperationResult(error.code), { path: resource.fsPath });
		}
		const message = error instanceof Error ? error.message : String(error);
		return new FileOperationError(message, FileOperationResult.FILE_OTHER_ERROR, { path: resource.fsPath });
	}

	// ---- operations

	async readFile(resource: URI): Promise<string> {
		try {
			return await this._provider(resource).readFile(resource);
		} catch (error) {
			throw this._wrapError(error, resource);
		}
	}

	async writeFile(resource: URI, content: string, options?: IFileWriteOptions): Promise<void> {
		try {
			await this._provider(resource).writeFile(resource, content, options ?? {});
			this._onDidRunOperation.fire({ resource, operation: FileOperation.WRITE });
		} catch (error) {
			throw this._wrapError(error, resource);
		}
	}

	async del(resource: URI, options?: IFileDeleteOptions): Promise<void> {
		try {
			await this._provider(resource).delete(resource, options ?? { useTrash: true });
			this._onDidRunOperation.fire({ resource, operation: FileOperation.DELETE });
		} catch (error) {
			throw this._wrapError(error, resource);
		}
	}

	async exists(resource: URI): Promise<boolean> {
		try {
			await this._provider(resource).stat(resource);
			return true;
		} catch (error) {
			if (error instanceof FileSystemProviderError && error.code === FileSystemProviderErrorCode.FileNotFound) {
				return false;
			}
			throw this._wrapError(error, resource);
		}
	}

	async resolve(resource: URI, options?: IResolveFileOptions): Promise<IFileStat> {
		try {
			const provider = this._provider(resource);
			const stat = await provider.stat(resource);
			if (!options?.resolveMetadata || !stat.isDirectory) {
				return stat;
			}
			const entries = await provider.readdir(resource);
			const children: IFileStat[] = [];
			for (const entry of entries) {
				const childResource = URI.joinPath(resource, entry.name);
				try {
					children.push(await provider.stat(childResource));
				} catch (error) {
					// a child vanished between readdir and stat: skip it (real logs and continues)
					continue;
				}
			}
			return newFileStat(stat.resource, stat.name, stat.type, stat.mtime, stat.size, children);
		} catch (error) {
			throw this._wrapError(error, resource);
		}
	}

	async createFolder(resource: URI): Promise<IFileStat> {
		try {
			const provider = this._provider(resource);
			await provider.createFolder(resource);
			this._onDidRunOperation.fire({ resource, operation: FileOperation.CREATE });
			return await provider.stat(resource);
		} catch (error) {
			throw this._wrapError(error, resource);
		}
	}

	async move(source: URI, target: URI, overwrite: boolean = false): Promise<void> {
		try {
			await this._provider(source).rename(source, target, { overwrite });
			this._onDidRunOperation.fire({ resource: source, operation: FileOperation.MOVE, target });
		} catch (error) {
			throw this._wrapError(error, source);
		}
	}

	async copy(source: URI, target: URI, overwrite: boolean = false): Promise<void> {
		try {
			const provider = this._provider(source);
			if (!provider.clone) {
				throw createFileSystemProviderError('copy is not supported by this provider', FileSystemProviderErrorCode.Unknown);
			}
			await provider.clone(source, target, { overwrite });
			this._onDidRunOperation.fire({ resource: source, operation: FileOperation.COPY, target });
		} catch (error) {
			throw this._wrapError(error, source);
		}
	}

	// ---- watching

	async watch(resource: URI, options?: IWatchOptions): Promise<number> {
		if (!this._watcher) {
			// the renderer's proxy never watches locally; the main process owns the watcher
			throw new FileOperationError('watchers are not available in this context', FileOperationResult.FILE_OTHER_ERROR, { path: resource.fsPath });
		}
		return this._watcher.watch({
			resource,
			recursive: options?.recursive ?? false,
			excludes: options?.excludes
		});
	}

	async unwatch(watchId: number): Promise<void> {
		this._watcher?.unwatch(watchId);
	}

	dispose(): void {
		this._onDidFilesChange.dispose();
		this._onDidRunOperation.dispose();
	}
}
