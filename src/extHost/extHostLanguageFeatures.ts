// src/extHost/extHostLanguageFeatures.ts — the host side of the provider SPI, ported in shape
// from vs/workbench/api/common/extHostLanguageFeatures.ts:
//
//   - `languages.registerXProvider(selector, provider, triggerCharacters)` → a handle + an RPC
//     registration down to MainThreadLanguageFeatures;
//   - provider CALLS come back up as `$provideCompletionItems/$provideHover(handle, requestId…)`;
//     the requestId keeps a CancellationToken alive so a superseded fetch can be cancelled (the
//     LSP client then sends `$/cancelRequest` — cancellation exists where the protocol wants it);
//   - `languages.createDiagnosticCollection(name)` owns markers under that name (the marker
//     service's owner isolation depends on this being per-collection).

import type { IMainThreadLanguageFeatures } from './mainThreadTypes.js';
import type { IWireCompletionList, IWireHover } from '../common/platform/extensions/common/extensionHostProtocol.js';
import type { IExtensionDescription } from '../common/platform/extensions/common/extensions.js';
import { Disposable, EventEmitter } from './extHostTypes.js';

export interface IExtHostCompletionProvider {
	provideCompletionItems(document: unknown, position: unknown, token: unknown, context: unknown): unknown;
}

export interface IExtHostHoverProvider {
	provideHover(document: unknown, position: unknown, token: unknown): unknown;
}

/** the token handed to providers; `onCancellationRequested` is how the toy client reaches LSP */
export class CancellationTokenSource {

	private readonly _onCancellationRequested = new EventEmitter<void>();
	readonly token = {
		isCancellationRequested: false,
		onCancellationRequested: (listener: () => void) => {
			const subscription = this._onCancellationRequested.event(listener);
			return subscription;
		}
	};

	cancel(): void {
		if (this.token.isCancellationRequested) {
			return;
		}
		this.token.isCancellationRequested = true;
		this._onCancellationRequested.fire();
	}
}

interface IFeatureRegistration {
	readonly kind: 'completion' | 'hover';
	readonly provider: unknown;
	readonly extensionId: string;
}

export class ExtHostLanguageFeatures {

	private _handle = 0;
	private readonly _registrations = new Map<number, IFeatureRegistration>();
	private readonly _requestTokens = new Map<string, CancellationTokenSource>();
	private readonly _documents: { getDocument(uri: { scheme: string; path: string }): unknown } | undefined;

	/** every diagnostic collection by name (owner) — the marker owners */
	private readonly _collections = new Map<string, ExtHostDiagnosticCollection>();

	constructor(
		private readonly _proxy: IMainThreadLanguageFeatures,
		private readonly _log: (message: string) => void,
		documents?: { getDocument(uri: { scheme: string; path: string }): unknown }
	) {
		this._documents = documents;
	}

	// ---- registration (the `languages` API)

	registerCompletionItemProvider(extension: IExtensionDescription, selector: { language?: string }, provider: IExtHostCompletionProvider, triggerCharacters?: readonly string[]): Disposable {
		const handle = ++this._handle;
		this._registrations.set(handle, { kind: 'completion', provider, extensionId: extension.identifier });
		void this._proxy.$registerCompletionProvider(handle, selector.language ?? '*', triggerCharacters).catch(error => {
			this._log(`[${extension.identifier}] completion provider registration failed: ${(error as Error).message}`);
		});
		return new Disposable(() => {
			this._registrations.delete(handle);
			void this._proxy.$unregisterProvider(handle).catch(() => { /* host gone */ });
		});
	}

	registerHoverProvider(extension: IExtensionDescription, selector: { language?: string }, provider: IExtHostHoverProvider): Disposable {
		const handle = ++this._handle;
		this._registrations.set(handle, { kind: 'hover', provider, extensionId: extension.identifier });
		void this._proxy.$registerHoverProvider(handle, selector.language ?? '*').catch(error => {
			this._log(`[${extension.identifier}] hover provider registration failed: ${(error as Error).message}`);
		});
		return new Disposable(() => {
			this._registrations.delete(handle);
			void this._proxy.$unregisterProvider(handle).catch(() => { /* host gone */ });
		});
	}

	// ---- provider calls (MainThreadLanguageFeatures → here)

	async $provideCompletionItems(handle: number, requestId: number, uri: { scheme: string; path: string }, position: { line: number; character: number }, context: { triggerKind: number; triggerCharacter?: string }): Promise<IWireCompletionList | null> {
		const registration = this._registrations.get(handle);
		if (!registration || registration.kind !== 'completion') {
			return null;
		}
		const tokenSource = new CancellationTokenSource();
		const tokenKey = `${handle}:${requestId}`;
		this._requestTokens.set(tokenKey, tokenSource);
		try {
			const provider = registration.provider as IExtHostCompletionProvider;
			const document = this._documents?.getDocument(uri);
			if (!document) {
				return null;
			}
			const result = await (provider.provideCompletionItems(document, position, tokenSource.token, { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter }) as Promise<unknown> | unknown);
			return normalizeCompletionResult(result);
		} catch (error) {
			this._log(`[${registration.extensionId}] provideCompletionItems failed: ${(error as Error).message}`);
			return null;
		} finally {
			this._requestTokens.delete(tokenKey);
		}
	}

	async $provideHover(handle: number, requestId: number, uri: { scheme: string; path: string }, position: { line: number; character: number }): Promise<IWireHover | null> {
		const registration = this._registrations.get(handle);
		if (!registration || registration.kind !== 'hover') {
			return null;
		}
		const tokenSource = new CancellationTokenSource();
		const tokenKey = `${handle}:${requestId}`;
		this._requestTokens.set(tokenKey, tokenSource);
		try {
			const provider = registration.provider as IExtHostHoverProvider;
			const document = this._documents?.getDocument(uri);
			if (!document) {
				return null;
			}
			const result = await (provider.provideHover(document, position, tokenSource.token) as Promise<unknown> | unknown);
			return normalizeHover(result);
		} catch (error) {
			this._log(`[${registration.extensionId}] provideHover failed: ${(error as Error).message}`);
			return null;
		} finally {
			this._requestTokens.delete(tokenKey);
		}
	}

	/** the renderer superseded a fetch: fire the provider's token (→ LSP $/cancelRequest) */
	async $cancelProviderRequest(handle: number, requestId: number): Promise<void> {
		this._requestTokens.get(`${handle}:${requestId}`)?.cancel();
	}

	// ---- diagnostics collections (owner = the collection name)

	createDiagnosticCollection(extension: IExtensionDescription, name: string): ExtHostDiagnosticCollection {
		const owner = name || extension.identifier;
		let collection = this._collections.get(owner);
		if (!collection) {
			collection = new ExtHostDiagnosticCollection(owner, this._proxy, this._log);
			this._collections.set(owner, collection);
		}
		return collection;
	}

	disposeAll(): void {
		for (const collection of this._collections.values()) {
			collection.dispose();
		}
		this._collections.clear();
	}
}

export class ExtHostDiagnosticCollection extends Disposable {

	private readonly _byResource = new Map<string, unknown[]>();

	constructor(
		readonly name: string,
		private readonly _proxy: IMainThreadLanguageFeatures,
		private readonly _log: (message: string) => void
	) {
		super(() => {
			this._byResource.clear();
			void this._proxy.$changeDiagnostics(this.name, []).catch(() => { /* host gone */ });
		});
	}

	set(uri: unknown, diagnostics: readonly unknown[]): void {
		const parsed = uriToWire(uri);
		if (!parsed) {
			return;
		}
		const key = `${parsed.scheme}://${parsed.path}`;
		const converted = diagnostics.map(diagnostic => normalizeDiagnostic(diagnostic)).filter((diagnostic): diagnostic is NonNullable<ReturnType<typeof normalizeDiagnostic>> => !!diagnostic);
		this._byResource.set(key, converted);
		void this._proxy.$changeDiagnostics(this.name, [{ uri: parsed, markers: converted }]).catch(error => {
			this._log(`[${this.name}] diagnostics update failed: ${(error as Error).message}`);
		});
	}

	delete(uri: unknown): void {
		const parsed = uriToWire(uri);
		if (!parsed) {
			return;
		}
		this._byResource.delete(`${parsed.scheme}://${parsed.path}`);
		void this._proxy.$changeDiagnostics(this.name, [{ uri: parsed, markers: [] }]).catch(() => { /* host gone */ });
	}

	clear(): void {
		this._byResource.clear();
		void this._proxy.$changeDiagnostics(this.name, []).catch(() => { /* host gone */ });
	}

	forEach(callback: (uri: unknown, diagnostics: readonly unknown[]) => void): void {
		for (const [key, diagnostics] of this._byResource) {
			const [scheme, path] = key.split('://');
			callback({ scheme, path }, diagnostics);
		}
	}
}

// ---- normalization at the API boundary (extHostTypeConverters, 1% scale)

function uriToWire(uri: unknown): { scheme: string; path: string } | null {
	if (!uri || typeof uri !== 'object') {
		return null;
	}
	const candidate = uri as { scheme?: unknown; path?: unknown };
	if (typeof candidate.scheme !== 'string' || typeof candidate.path !== 'string') {
		return null;
	}
	return { scheme: candidate.scheme, path: candidate.path };
}

function normalizeCompletionResult(result: unknown): IWireCompletionList | null {
	if (!result) {
		return null;
	}
	if (Array.isArray(result)) {
		return { items: result.map(normalizeCompletionItem).filter((item): item is NonNullable<ReturnType<typeof normalizeCompletionItem>> => !!item), isIncomplete: false };
	}
	const list = result as { items?: unknown[]; isIncomplete?: boolean };
	if (!Array.isArray(list.items)) {
		return null;
	}
	return {
		items: list.items.map(normalizeCompletionItem).filter((item): item is NonNullable<ReturnType<typeof normalizeCompletionItem>> => !!item),
		isIncomplete: !!list.isIncomplete
	};
}

function normalizeCompletionItem(item: unknown): {
	label: string;
	kind?: number;
	detail?: string;
	documentation?: string;
	insertText?: string;
	filterText?: string;
	sortText?: string;
	textEdit?: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string };
} | null {
	if (!item || typeof item !== 'object') {
		return null;
	}
	const candidate = item as Record<string, unknown>;
	const label = typeof candidate.label === 'string'
		? candidate.label
		: typeof (candidate.label as { label?: unknown })?.label === 'string' ? (candidate.label as { label: string }).label : undefined;
	if (label === undefined) {
		return null;
	}
	const documentation = typeof candidate.documentation === 'string'
		? candidate.documentation
		: (candidate.documentation as { value?: unknown })?.value !== undefined ? String((candidate.documentation as { value: unknown }).value) : undefined;
	const textEdit = normalizeTextEdit(candidate.textEdit);
	return {
		label,
		kind: typeof candidate.kind === 'number' ? candidate.kind : undefined,
		detail: typeof candidate.detail === 'string' ? candidate.detail : undefined,
		documentation,
		insertText: typeof candidate.insertText === 'string' ? candidate.insertText : undefined,
		filterText: typeof candidate.filterText === 'string' ? candidate.filterText : undefined,
		sortText: typeof candidate.sortText === 'string' ? candidate.sortText : undefined,
		textEdit
	};
}

function normalizeTextEdit(value: unknown): { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string } | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const candidate = value as { range?: unknown; newText?: unknown };
	if (!candidate.range || typeof candidate.newText !== 'string') {
		return undefined;
	}
	const range = normalizeRange(candidate.range);
	return range ? { range, newText: candidate.newText } : undefined;
}

function normalizeRange(value: unknown): { start: { line: number; character: number }; end: { line: number; character: number } } | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const candidate = value as { start?: { line?: number; character?: number }; end?: { line?: number; character?: number }; startLine?: number; startCharacter?: number; endLine?: number; endCharacter?: number };
	if (candidate.start && candidate.end) {
		return {
			start: { line: candidate.start.line ?? 0, character: candidate.start.character ?? 0 },
			end: { line: candidate.end.line ?? 0, character: candidate.end.character ?? 0 }
		};
	}
	if (typeof candidate.startLine === 'number' && typeof candidate.startCharacter === 'number') {
		return {
			start: { line: candidate.startLine, character: candidate.startCharacter },
			end: { line: candidate.endLine ?? candidate.startLine, character: candidate.endCharacter ?? candidate.startCharacter }
		};
	}
	return undefined;
}

function normalizeHover(result: unknown): IWireHover | null {
	if (!result || typeof result !== 'object') {
		return null;
	}
	const candidate = result as { contents?: unknown; range?: unknown };
	const contents = Array.isArray(candidate.contents) ? candidate.contents : [candidate.contents];
	const normalized = contents.flatMap<{ kind: 'plaintext' | 'markdown'; value: string }>(entry => {
		if (typeof entry === 'string') {
			return [{ kind: 'markdown' as const, value: entry }];
		}
		if (entry && typeof entry === 'object') {
			const markup = entry as { value?: unknown };
			if (typeof markup.value === 'string') {
				return [{ kind: 'markdown' as const, value: markup.value }];
			}
		}
		return [];
	});
	if (normalized.length === 0) {
		return null;
	}
	const range = normalizeRange(candidate.range);
	return { contents: normalized, range };
}

function normalizeDiagnostic(diagnostic: unknown): { range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity: number; message: string; code?: string } | null {
	if (!diagnostic || typeof diagnostic !== 'object') {
		return null;
	}
	const candidate = diagnostic as { range?: unknown; severity?: unknown; message?: unknown; code?: unknown };
	const range = normalizeRange(candidate.range);
	if (!range) {
		return null;
	}
	return {
		range,
		severity: typeof candidate.severity === 'number' ? candidate.severity : 1,
		message: typeof candidate.message === 'string' ? candidate.message : String(candidate.message ?? ''),
		code: typeof candidate.code === 'string' ? candidate.code : undefined
	};
}
