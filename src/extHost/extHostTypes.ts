// src/extHost/extHostTypes.ts — the classes extensions actually touch, ported in shape from
// vs/workbench/api/common/extHostTypes.ts (12 grows this file). These are the HOST-side copies;
// the renderer has its own (URI, Position, Selection) — the boundary converts between them.

export class Disposable {

	static from(...disposables: { dispose(): void }[]): Disposable {
		return new Disposable(() => {
			for (const disposable of disposables) {
				disposable.dispose();
			}
		});
	}

	constructor(private readonly _callOnDispose: () => void) { }

	dispose(): void {
		this._callOnDispose();
	}
}

export interface IEvent<T> {
	(listener: (event: T) => void, thisArgs?: unknown, disposables?: { add(disposable: { dispose(): void }): void }[]): Disposable;
}

export class EventEmitter<T> {

	private readonly _listeners = new Set<(event: T) => void>();

	readonly event: IEvent<T> = (listener: (event: T) => void) => {
		this._listeners.add(listener);
		return new Disposable(() => this._listeners.delete(listener));
	};

	fire(data: T): void {
		for (const listener of [...this._listeners]) {
			try {
				listener(data);
			} catch (error) {
				console.error(`[event listener threw] ${(error as Error).message}`);
			}
		}
	}

	dispose(): void {
		this._listeners.clear();
	}
}

export class Uri {

	static file(path: string): Uri {
		const normalized = path.replace(/\\/g, '/');
		return new Uri('file', normalized.startsWith('/') ? normalized : `/${normalized}`);
	}

	static parse(value: string): Uri {
		const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(value);
		if (match) {
			return new Uri(match[1].toLowerCase(), match[2]);
		}
		const simple = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(value);
		if (simple) {
			return new Uri(simple[1].toLowerCase(), simple[2]);
		}
		return Uri.file(value);
	}

	constructor(readonly scheme: string, readonly path: string) { }

	get fsPath(): string {
		return this.scheme === 'file' ? decodeURIComponent(this.path) : this.toString();
	}

	toString(): string {
		return `${this.scheme}://${this.path}`;
	}

	with(change: { scheme?: string; path?: string }): Uri {
		return new Uri(change.scheme ?? this.scheme, change.path ?? this.path);
	}

	joinPath(...segments: string[]): Uri {
		const parts = [this.path.replace(/\/+$/, ''), ...segments.map(segment => segment.replace(/^\/+|\/+$/g, ''))];
		return new Uri(this.scheme, parts.filter(part => part.length > 0).join('/'));
	}

	toJSON(): { scheme: string; path: string } {
		return { scheme: this.scheme, path: this.path };
	}
}

export class Position {

	constructor(readonly line: number, readonly character: number) { }

	isBefore(other: Position): boolean {
		return this.line < other.line || (this.line === other.line && this.character < other.character);
	}

	isBeforeOrEqual(other: Position): boolean {
		return this.line < other.line || (this.line === other.line && this.character <= other.character);
	}

	isAfter(other: Position): boolean {
		return other.isBefore(this);
	}

	isEqual(other: Position): boolean {
		return this.line === other.line && this.character === other.character;
	}

	translate(lineDelta = 0, characterDelta = 0): Position {
		return new Position(this.line + lineDelta, this.character + characterDelta);
	}

	with(line = this.line, character = this.character): Position {
		return new Position(line, character);
	}
}

export class Range {

	constructor(
		readonly start: Position | { line: number; character: number },
		readonly end: Position | { line: number; character: number }
	) { }

	get startLine(): number { return this.start.line; }
	get startCharacter(): number { return this.start.character; }
	get endLine(): number { return this.end.line; }
	get endCharacter(): number { return this.end.character; }

	contains(position: Position): boolean {
		return !position.isBefore(new Position(this.startLine, this.startCharacter))
			&& !position.isAfter(new Position(this.endLine, this.endCharacter));
	}

	isEqual(other: Range): boolean {
		return this.startLine === other.startLine && this.startCharacter === other.startCharacter
			&& this.endLine === other.endLine && this.endCharacter === other.endCharacter;
	}
}

export class Selection extends Range {

	constructor(public readonly anchor: Position, public readonly active: Position) {
		super(anchor, active);
	}

	get isReversed(): boolean {
		return this.active.isBefore(this.anchor);
	}
}

export enum StatusBarAlignment {
	Left = 1,
	Right = 2
}

export enum ConfigurationTarget {
	Global = 1,
	Workspace = 2,
	WorkspaceFolder = 3
}

export enum ViewColumn {
	Active = -1,
	Beside = -2,
	One = 1
}

export enum ExtensionMode {
	Production = 1,
	Development = 2,
	Test = 3
}
