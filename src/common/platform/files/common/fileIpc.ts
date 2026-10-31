// src/common/platform/files/common/fileIpc.ts — the `file` channel: JSON-safe wire shapes and
// the two converters. The reference solves the same problem with DiskFileSystemProviderServer +
// a URITransformer; our channel protocol is plain JSON (02's documented delta), so URIs and
// FileChangesEvent objects are marshalled explicitly here — the renderer-facing FileServiceClient
// rehydrates them (see the disk provider server's job in the reference).

import { Emitter, Event } from '../../../base/common/event.js';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import {
	FileChangeType,
	FileChangesEvent,
	FileOperationError,
	FileOperationResult,
	IFileChange,
	IFileDeleteOptions,
	IFileOperationEvent,
	IFileService,
	IFileStat,
	IFileWriteOptions,
	IResolveFileOptions,
	IWatchOptions,
	newFileStat,
	FileType
} from './files.js';

// ---- wire shapes (everything JSON-safe: paths are strings)

export interface IWireFileStat {
	readonly path: string;
	readonly name: string;
	readonly type: FileType;
	readonly mtime: number;
	readonly size: number;
	readonly children?: IWireFileStat[];
}

export interface IWireFileChange {
	readonly path: string;
	readonly type: FileChangeType;
}

export interface IWireFileOperationEvent {
	readonly path: string;
	readonly operation: number;
	readonly targetPath?: string;
}

export function toWireStat(stat: IFileStat): IWireFileStat {
	return {
		path: stat.resource.fsPath,
		name: stat.name,
		type: stat.type,
		mtime: stat.mtime,
		size: stat.size,
		children: stat.children?.map(toWireStat)
	};
}

export function fromWireStat(wire: IWireFileStat): IFileStat {
	return newFileStat(URI.file(wire.path), wire.name, wire.type, wire.mtime, wire.size, wire.children?.map(fromWireStat));
}

export function toWireChange(change: IFileChange): IWireFileChange {
	return { path: change.resource.fsPath, type: change.type };
}

export function fromWireChange(wire: IWireFileChange): IFileChange {
	return { resource: URI.file(wire.path), type: wire.type };
}

// ---- the wire service (both sides implement/dispatch this shape)

export interface IFileServiceWire {
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string, options?: IFileWriteOptions): Promise<void>;
	del(path: string, options?: IFileDeleteOptions): Promise<void>;
	exists(path: string): Promise<boolean>;
	resolve(path: string, options?: IResolveFileOptions): Promise<IWireFileStat>;
	createFolder(path: string): Promise<IWireFileStat>;
	move(sourcePath: string, targetPath: string, overwrite?: boolean): Promise<void>;
	copy(sourcePath: string, targetPath: string, overwrite?: boolean): Promise<void>;
	watch(path: string, options?: IWatchOptions): Promise<number>;
	unwatch(watchId: number): Promise<void>;
	// the "onX" naming convention is what the proxy recognizes as events
	onDidFilesChange: Event<IWireFileChange[]>;
	onDidRunOperation: Event<IWireFileOperationEvent>;
}

/** main side: adapts the FileService to the wire shape (like DiskFileSystemProviderServer) */
export function createFileServiceWire(service: IFileService): {
	service: IFileServiceWire;
	dispose(): void;
} {
	const onDidFilesChange = new Emitter<IWireFileChange[]>();
	const onDidRunOperation = new Emitter<IWireFileOperationEvent>();
	const disposables: IDisposable[] = [
		service.onDidFilesChange(event => onDidFilesChange.fire(event.changes.map(toWireChange))),
		service.onDidRunOperation(event => onDidRunOperation.fire({
			path: event.resource.fsPath,
			operation: event.operation,
			targetPath: event.target?.fsPath
		}))
	];

	const wire: IFileServiceWire = {
		readFile: path => service.readFile(URI.file(path)),
		writeFile: (path, content, options) => service.writeFile(URI.file(path), content, options),
		del: (path, options) => service.del(URI.file(path), options),
		exists: path => service.exists(URI.file(path)),
		resolve: async (path, options) => toWireStat(await service.resolve(URI.file(path), options)),
		createFolder: async path => toWireStat(await service.createFolder(URI.file(path))),
		move: (sourcePath, targetPath, overwrite) => service.move(URI.file(sourcePath), URI.file(targetPath), overwrite),
		copy: (sourcePath, targetPath, overwrite) => service.copy(URI.file(sourcePath), URI.file(targetPath), overwrite),
		watch: (path, options) => service.watch(URI.file(path), options),
		unwatch: watchId => service.unwatch(watchId),
		onDidFilesChange: onDidFilesChange.event,
		onDidRunOperation: onDidRunOperation.event
	};

	return {
		service: wire,
		dispose() {
			for (const disposable of disposables) {
				disposable.dispose();
			}
			onDidFilesChange.dispose();
			onDidRunOperation.dispose();
		}
	};
}

/** renderer side: rehydrates wire values into the IFileService contract */
export class FileServiceClient implements IFileService {

	readonly onDidFilesChange: Event<FileChangesEvent>;
	readonly onDidRunOperation: Event<IFileOperationEvent>;

	constructor(private readonly _wire: IFileServiceWire) {
		this.onDidFilesChange = (listener, thisArgs, disposables) => {
			const disposable = _wire.onDidFilesChange(changes => {
				listener.call(thisArgs, new FileChangesEvent(changes.map(fromWireChange)));
			});
			addDisposable(disposables, disposable);
			return disposable;
		};
		this.onDidRunOperation = (listener, thisArgs, disposables) => {
			const disposable = _wire.onDidRunOperation(event => {
				listener.call(thisArgs, {
					resource: URI.file(event.path),
					operation: event.operation,
					target: event.targetPath ? URI.file(event.targetPath) : undefined
				});
			});
			addDisposable(disposables, disposable);
			return disposable;
		};
	}

	readFile(resource: URI): Promise<string> {
		return this._wire.readFile(resource.fsPath);
	}

	writeFile(resource: URI, content: string, options?: IFileWriteOptions): Promise<void> {
		return this._wire.writeFile(resource.fsPath, content, options);
	}

	del(resource: URI, options?: IFileDeleteOptions): Promise<void> {
		return this._wire.del(resource.fsPath, options);
	}

	exists(resource: URI): Promise<boolean> {
		return this._wire.exists(resource.fsPath);
	}

	async resolve(resource: URI, options?: IResolveFileOptions): Promise<IFileStat> {
		return fromWireStat(await this._wire.resolve(resource.fsPath, options));
	}

	async createFolder(resource: URI): Promise<IFileStat> {
		return fromWireStat(await this._wire.createFolder(resource.fsPath));
	}

	move(source: URI, target: URI, overwrite?: boolean): Promise<void> {
		return this._wire.move(source.fsPath, target.fsPath, overwrite);
	}

	copy(source: URI, target: URI, overwrite?: boolean): Promise<void> {
		return this._wire.copy(source.fsPath, target.fsPath, overwrite);
	}

	watch(resource: URI, options?: IWatchOptions): Promise<number> {
		return this._wire.watch(resource.fsPath, options);
	}

	unwatch(watchId: number): Promise<void> {
		return this._wire.unwatch(watchId);
	}
}

/** errors crossing the channel lose their class; re-attach the operation result when present */
export function asFileOperationError(error: unknown): FileOperationError {
	if (error instanceof FileOperationError) {
		return error;
	}
	const message = error instanceof Error ? error.message : String(error);
	return new FileOperationError(message, FileOperationResult.FILE_OTHER_ERROR);
}

function addDisposable(disposables: IDisposable[] | { add(disposable: IDisposable): void } | undefined, disposable: IDisposable): void {
	if (!disposables) {
		return;
	}
	if (Array.isArray(disposables)) {
		disposables.push(disposable);
	} else {
		disposables.add(disposable);
	}
}
