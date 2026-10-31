// src/extHost/extHostWorkspace.ts — the workspace subset: configuration (a LOCAL mirror, so
// `get()` stays synchronous like the real API — the renderer pushes the whole snapshot on every
// change instead of per-key deltas) and the document mirror (`textDocuments`, open/change/close).
//
// Ported in shape from vs/workbench/api/common/extHostConfiguration.ts + extHostDocuments.ts +
// extHostDocumentData.ts (identity per URI, full-text sync — delta noted at the protocol).

import type { IExtHostConfiguration, IExtHostDocuments, IMainThreadConfiguration, IMainThreadDocuments } from './mainThreadTypes.js';
import type { IWireActiveEditor, IWireTextDocument } from '../common/platform/extensions/common/extensionHostProtocol.js';
import { Disposable, EventEmitter, Position, Range, Selection, Uri } from './extHostTypes.js';

// ---- documents

export class ExtHostDocumentData {

	readonly uri: Uri;
	readonly languageId: string;
	private _text: string;
	private _version: number;

	constructor(document: IWireTextDocument) {
		this.uri = new Uri(document.uri.scheme, document.uri.path);
		this.languageId = document.languageId;
		this._text = document.text;
		this._version = document.version;
	}

	get version(): number {
		return this._version;
	}

	getText(range?: Range): string {
		if (!range) {
			return this._text;
		}
		const lines = this._text.split('\n');
		if (range.startLine === range.endLine) {
			return (lines[range.startLine] ?? '').substring(range.startCharacter, range.endCharacter);
		}
		const parts: string[] = [(lines[range.startLine] ?? '').substring(range.startCharacter)];
		for (let line = range.startLine + 1; line < range.endLine; line++) {
			parts.push(lines[line] ?? '');
		}
		parts.push((lines[range.endLine] ?? '').substring(0, range.endCharacter));
		return parts.join('\n');
	}

	get lineCount(): number {
		return this._text.split('\n').length;
	}

	get isDirty(): boolean {
		return this._isDirty;
	}

	readonly _isDirty: boolean = false;

	public $acceptChange(document: IWireTextDocument): void {
		this._text = document.text;
		this._version = document.version;
	}

	public static fromWire(document: IWireTextDocument): ExtHostDocumentData {
		return new ExtHostDocumentData(document);
	}
}

export interface IExtHostTextEditor {
	readonly document: ExtHostDocumentData;
	readonly selection: Selection;
}

export class ExtHostWorkspace {

	private readonly _onDidOpenTextDocument = new EventEmitter<ExtHostDocumentData>();
	readonly onDidOpenTextDocument = this._onDidOpenTextDocument.event;
	private readonly _onDidChangeTextDocument = new EventEmitter<{ document: ExtHostDocumentData; contentChanges: unknown[] }>();
	readonly onDidChangeTextDocument = this._onDidChangeTextDocument.event;
	private readonly _onDidCloseTextDocument = new EventEmitter<ExtHostDocumentData>();
	readonly onDidCloseTextDocument = this._onDidCloseTextDocument.event;
	private readonly _onDidChangeActiveTextEditor = new EventEmitter<IExtHostTextEditor | undefined>();
	readonly onDidChangeActiveTextEditor = this._onDidChangeActiveTextEditor.event;

	private readonly _documents = new Map<string, ExtHostDocumentData>();
	private _activeEditor: IExtHostTextEditor | undefined;

	/** configuration mirror + its per-section change events */
	private _configuration: { [key: string]: unknown } = {};
	private readonly _sectionEmitters = new Map<string, EventEmitter<{ affectsConfiguration(section: string): boolean }>>();
	private readonly _configurationProxy: IMainThreadConfiguration;
	private readonly _documentsProxy: IMainThreadDocuments;

	constructor(configurationProxy: IMainThreadConfiguration, documentsProxy: IMainThreadDocuments) {
		this._configurationProxy = configurationProxy;
		this._documentsProxy = documentsProxy;
	}

	get textDocuments(): readonly ExtHostDocumentData[] {
		return [...this._documents.values()];
	}

	get activeTextEditor(): IExtHostTextEditor | undefined {
		return this._activeEditor;
	}

	/** the provider calls resolve the wire uri to the mirrored document */
	getDocument(uri: { scheme: string; path: string }): ExtHostDocumentData | undefined {
		return this._documents.get(`${uri.scheme}://${uri.path}`);
	}

	// ---- the reinitialize sequence: seed from the renderer's current state

	async initialize(): Promise<void> {
		this._configuration = await this._configurationProxy.$getAllConfiguration();
		for (const document of await this._documentsProxy.$getAllDocuments()) {
			this._documents.set(`${document.uri.scheme}://${document.uri.path}`, new ExtHostDocumentData(document));
		}
		const active = await this._documentsProxy.$getActiveEditor();
		this._acceptActiveEditor(active);
	}

	// ---- configuration (vscode.workspace.getConfiguration)

	getConfiguration(section?: string) {
		const workspace = this;
		return {
			get<T>(key: string, defaultValue?: T): T {
				const value = workspace._lookup(section, key);
				return (value === undefined ? defaultValue : value) as T;
			},
			has(key: string): boolean {
				return workspace._lookup(section, key) !== undefined;
			},
			inspect<T>(key: string) {
				const value = workspace._lookup(section, key) as T | undefined;
				return value === undefined ? undefined : { key: section ? `${section}.${key}` : key, defaultValue: value };
			},
			async update(key: string, value: unknown, target?: number): Promise<void> {
				await workspace._configurationProxy.$updateValue(section, key, value);
				void target;
			},
			onDidChange(callback: (event: { affectsConfiguration(section: string): boolean }) => void): Disposable {
				const emitter = workspace._sectionEmitter(section ?? '');
				return emitter.event(callback);
			}
		};
	}

	/** the API's `vscode.workspace.onDidChangeConfiguration` */
	onDidChangeConfiguration(callback: (event: { affectsConfiguration(section: string): boolean }) => void): Disposable {
		return this._sectionEmitter('').event(callback);
	}

	private _sectionEmitter(section: string): EventEmitter<{ affectsConfiguration(section: string): boolean }> {
		let emitter = this._sectionEmitters.get(section);
		if (!emitter) {
			emitter = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();
			this._sectionEmitters.set(section, emitter);
		}
		return emitter;
	}

	private _lookup(section: string | undefined, key: string): unknown {
		const fullKey = section ? `${section}.${key}` : key;
		// tolerate FLAT dotted keys too (defensive: a mirror built flat still resolves)
		if (this._configuration[fullKey] !== undefined) {
			return this._configuration[fullKey];
		}
		let node: unknown = this._configuration;
		for (const segment of fullKey.split('.')) {
			if (!node || typeof node !== 'object') {
				return undefined;
			}
			node = (node as { [key: string]: unknown })[segment];
		}
		return node;
	}

	// ---- pushes from the renderer (the ExtHostConfiguration/Documents channels)

	async $acceptConfigurationChanged(all: { [key: string]: unknown }, changedKeys: readonly string[]): Promise<void> {
		this._configuration = all;
		const eventFor = (section: string) => ({
			affectsConfiguration: (candidate: string) => changedKeys.some(key => key === candidate || key.startsWith(`${candidate}.`) || candidate.startsWith(`${key}.`))
		});
		for (const [section, emitter] of this._sectionEmitters) {
			emitter.fire(eventFor(section));
		}
	}

	async $acceptOpenDocument(document: IWireTextDocument): Promise<void> {
		if (this._documents.has(`${document.uri.scheme}://${document.uri.path}`)) {
			return; // already known (the renderer may re-announce after a reload)
		}
		const data = new ExtHostDocumentData(document);
		this._documents.set(`${document.uri.scheme}://${document.uri.path}`, data);
		this._onDidOpenTextDocument.fire(data);
	}

	async $acceptChangeDocument(change: { uri: IWireTextDocument['uri']; document: IWireTextDocument }): Promise<void> {
		const data = this._documents.get(`${change.uri.scheme}://${change.uri.path}`);
		if (!data) {
			return;
		}
		data.$acceptChange(change.document);
		this._onDidChangeTextDocument.fire({ document: data, contentChanges: [] });
	}

	async $acceptCloseDocument(uri: IWireTextDocument['uri']): Promise<void> {
		const key = `${uri.scheme}://${uri.path}`;
		const data = this._documents.get(key);
		if (data) {
			this._documents.delete(key);
			this._onDidCloseTextDocument.fire(data);
		}
	}

	async $acceptActiveEditorChange(editor: IWireActiveEditor | null): Promise<void> {
		this._acceptActiveEditor(editor);
	}

	private _acceptActiveEditor(editor: IWireActiveEditor | null): void {
		if (!editor) {
			this._activeEditor = undefined;
			this._onDidChangeActiveTextEditor.fire(undefined);
			return;
		}
		const document = this._documents.get(`${editor.document.uri.scheme}://${editor.document.uri.path}`) ?? new ExtHostDocumentData(editor.document);
		this._documents.set(`${editor.document.uri.scheme}://${editor.document.uri.path}`, document);
		this._activeEditor = {
			document,
			selection: new Selection(
				new Position(editor.selection.anchor.line, editor.selection.anchor.character),
				new Position(editor.selection.active.line, editor.selection.active.character)
			)
		};
		this._onDidChangeActiveTextEditor.fire(this._activeEditor);
	}
}
