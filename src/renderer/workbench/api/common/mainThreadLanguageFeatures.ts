// src/renderer/workbench/api/common/mainThreadLanguageFeatures.ts — the workbench side of the
// language provider SPI, ported in shape from the reference's mainThreadLanguageFeatures.ts +
// languageFeatureRegistry.ts:
//
//   - the renderer knows ONLY providers (the LSP-ness lives in the extension);
//   - registration is per language with a score (the exact-language case is all we can hit —
//     glob selectors are the documented delta);
//   - the editor consults `getCompletionProviders(languageId)` / `getHoverProviders(...)` on
//     demand; providers call BACK into the host ($provideCompletionItems/$provideHover) with a
//     request id so superseded fetches can be cancelled at the LSP layer.

import { Disposable, IDisposable, toDisposable } from '../../../../common/base/common/lifecycle.js';
import { URI } from '../../../../common/base/common/uri.js';
import type { ILogService } from '../../../../common/platform/log/common/log.js';
import type { TextModel } from '../../../../common/editor/common/model/textModel.js';
import type {
	IWireCodeAction,
	IWireCodeActionContext,
	IWireCompletionContext,
	IWireCompletionList,
	IWireDocumentSymbol,
	IWireFormattingOptions,
	IWireHover,
	IWireLocation,
	IWireRange,
	IWireRenameLocation,
	IWireTextEdit,
	IWireWorkspaceEdit
} from '../../../../common/platform/extensions/common/extensionHostProtocol.js';
import { LspDiagnosticSeverity } from '../../../../common/platform/extensions/common/extensionHostProtocol.js';
import { MarkerSeverity } from '../../services/markers/browser/markerService.js';
import type { MarkerService } from '../../services/markers/browser/markerService.js';

// ---- the internal provider interfaces the editor consults

export interface IInternalCompletionContext {
	readonly triggerKind: number;
	readonly triggerCharacter?: string;
}

export interface ICompletionProviderAdapter {
	provideCompletionItems(resource: URI, model: TextModel, position: { lineNumber: number; column: number }, context: IInternalCompletionContext, requestId: number): Promise<IWireCompletionList | null>;
	readonly handle: number;
}

export interface IHoverProviderAdapter {
	provideHover(resource: URI, model: TextModel, position: { lineNumber: number; column: number }, requestId: number): Promise<IWireHover | null>;
	readonly handle: number;
}

/** the editor's 1-based position/range pair, as the rest of the renderer spells it */
export interface IEditorPosition {
	readonly lineNumber: number;
	readonly column: number;
}

export interface IEditorRange {
	readonly startLineNumber: number;
	readonly startColumn: number;
	readonly endLineNumber: number;
	readonly endColumn: number;
}

// The ONE boundary: everything on the wire is a 0-based LSP position, everything in the renderer
// is 1-based. The reference converts in extHostTypeConverters; here these three functions are the
// whole conversion, and every adapter below goes through them.

export function toWirePosition(position: IEditorPosition): { line: number; character: number } {
	return { line: position.lineNumber - 1, character: position.column - 1 };
}

export function toWireRange(range: IEditorRange): IWireRange {
	return {
		start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
		end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
	};
}

/** the way back: a wire range becomes an editor range the contribs can select/reveal with */
export function toEditorRange(range: IWireRange): IEditorRange {
	return {
		startLineNumber: range.start.line + 1,
		startColumn: range.start.character + 1,
		endLineNumber: range.end.line + 1,
		endColumn: range.end.character + 1
	};
}

export interface IDocumentSymbolProviderAdapter {
	provideDocumentSymbols(resource: URI, requestId: number): Promise<readonly IWireDocumentSymbol[] | null>;
	readonly handle: number;
}

export interface IDefinitionProviderAdapter {
	provideDefinition(resource: URI, position: IEditorPosition, requestId: number): Promise<readonly IWireLocation[] | null>;
	readonly handle: number;
}

export interface IRenameProviderAdapter {
	provideRenameEdits(resource: URI, position: IEditorPosition, newName: string, requestId: number): Promise<IWireWorkspaceEdit | null>;
	/** null when the provider has no prepareRename — the editor then prompts without a pre-flight */
	resolveRenameLocation(resource: URI, position: IEditorPosition, requestId: number): Promise<IWireRenameLocation | null>;
	readonly supportsResolveInitialValues: boolean;
	readonly handle: number;
}

export interface ICodeActionProviderAdapter {
	provideCodeActions(resource: URI, range: IEditorRange, context: IWireCodeActionContext, requestId: number): Promise<readonly IWireCodeAction[] | null>;
	/** the kinds the provider declared, so the editor can skip it for an `only` it cannot serve */
	readonly providedCodeActionKinds: readonly string[];
	readonly handle: number;
}

export interface IDocumentFormattingEditProviderAdapter {
	provideDocumentFormattingEdits(resource: URI, options: IWireFormattingOptions, requestId: number): Promise<readonly IWireTextEdit[] | null>;
	readonly handle: number;
}

interface IRegistration<T> {
	readonly language: string;
	readonly order: number;
	readonly provider: T;
}

/**
 * The LanguageFeatureRegistry port: registration per language with a score. The reference scores
 * concrete languageIds above globs; only exact matches exist here (delta: no `*`/glob
 * selectors, no scheme/pattern selectors).
 */
export class LanguageFeatureRegistry<T extends { handle: number }> {

	private _order = 0;
	private readonly _registrations = new Map<number, IRegistration<T>>();

	register(language: string, provider: T): IDisposable {
		this._registrations.set(provider.handle, { language, order: this._order++, provider });
		return toDisposable(() => this._registrations.delete(provider.handle));
	}

	unregister(handle: number): void {
		this._registrations.delete(handle);
	}

	/** the ported `ordered(model)`: exact language matches, later registrations win ties */
	ordered(languageId: string): readonly T[] {
		return [...this._registrations.values()]
			.filter(registration => registration.language === languageId)
			.sort((a, b) => b.order - a.order)
			.map(registration => registration.provider);
	}
}

// ---- the workbench-facing service (what the editor widget receives)

function toMarkerSeverity(severity: number): MarkerSeverity {
	switch (severity) {
		case LspDiagnosticSeverity.Error: return MarkerSeverity.Error;
		case LspDiagnosticSeverity.Warning: return MarkerSeverity.Warning;
		case LspDiagnosticSeverity.Information: return MarkerSeverity.Info;
		case LspDiagnosticSeverity.Hint: return MarkerSeverity.Hint;
		default: return MarkerSeverity.Warning;
	}
}

export interface ILanguageFeaturesService {
	getCompletionProviders(languageId: string): readonly ICompletionProviderAdapter[];
	getHoverProviders(languageId: string): readonly IHoverProviderAdapter[];
	getDocumentSymbolProviders(languageId: string): readonly IDocumentSymbolProviderAdapter[];
	getDefinitionProviders(languageId: string): readonly IDefinitionProviderAdapter[];
	getRenameProviders(languageId: string): readonly IRenameProviderAdapter[];
	getCodeActionProviders(languageId: string): readonly ICodeActionProviderAdapter[];
	getDocumentFormattingEditProviders(languageId: string): readonly IDocumentFormattingEditProviderAdapter[];
	/** the union of every provider's trigger characters for the language */
	getCompletionTriggerCharacters(languageId: string): readonly string[];
	/** resource → languageId (wired to 11's LanguageService at bootstrap) */
	languageIdForResource(resource: URI): string;
	/** superseded fetches: fire the provider's token (→ LSP $/cancelRequest) */
	cancelRequest(handle: number, requestId: number): void;
}

export class LanguageFeaturesService extends Disposable implements ILanguageFeaturesService {

	readonly completions = new LanguageFeatureRegistry<ICompletionProviderAdapter>();
	readonly hovers = new LanguageFeatureRegistry<IHoverProviderAdapter>();
	readonly documentSymbols = new LanguageFeatureRegistry<IDocumentSymbolProviderAdapter>();
	readonly definitions = new LanguageFeatureRegistry<IDefinitionProviderAdapter>();
	readonly renames = new LanguageFeatureRegistry<IRenameProviderAdapter>();
	readonly codeActions = new LanguageFeatureRegistry<ICodeActionProviderAdapter>();
	readonly documentFormattingEdits = new LanguageFeatureRegistry<IDocumentFormattingEditProviderAdapter>();
	private readonly _triggerCharacters = new Map<string, Set<string>>();
	private _languageIdResolver: ((resource: URI) => string) | null = null;
	/** bubbles superseded requests up to the host (set by createMainThreadLanguageFeatures) */
	private _cancelRequest: ((handle: number, requestId: number) => void) | null = null;

	setLanguageIdResolver(resolver: (resource: URI) => string): void {
		this._languageIdResolver = resolver;
	}

	setCancelRequest(cancel: (handle: number, requestId: number) => void): void {
		this._cancelRequest = cancel;
	}

	languageIdForResource(resource: URI): string {
		return this._languageIdResolver?.(resource) ?? 'plaintext';
	}

	cancelRequest(handle: number, requestId: number): void {
		this._cancelRequest?.(handle, requestId);
	}

	setTriggerCharacters(handle: number, language: string, characters: readonly string[]): void {
		void handle;
		let set = this._triggerCharacters.get(language);
		if (!set) {
			set = new Set();
			this._triggerCharacters.set(language, set);
		}
		for (const character of characters) {
			set.add(character);
		}
	}

	getCompletionProviders(languageId: string): readonly ICompletionProviderAdapter[] {
		return this.completions.ordered(languageId);
	}

	getHoverProviders(languageId: string): readonly IHoverProviderAdapter[] {
		return this.hovers.ordered(languageId);
	}

	getDocumentSymbolProviders(languageId: string): readonly IDocumentSymbolProviderAdapter[] {
		return this.documentSymbols.ordered(languageId);
	}

	getDefinitionProviders(languageId: string): readonly IDefinitionProviderAdapter[] {
		return this.definitions.ordered(languageId);
	}

	getRenameProviders(languageId: string): readonly IRenameProviderAdapter[] {
		return this.renames.ordered(languageId);
	}

	getCodeActionProviders(languageId: string): readonly ICodeActionProviderAdapter[] {
		return this.codeActions.ordered(languageId);
	}

	getDocumentFormattingEditProviders(languageId: string): readonly IDocumentFormattingEditProviderAdapter[] {
		return this.documentFormattingEdits.ordered(languageId);
	}

	/** every registry, so a new kind cannot be forgotten by $unregisterProvider (that is a leak) */
	unregisterEverywhere(handle: number): void {
		for (const registry of [this.completions, this.hovers, this.documentSymbols, this.definitions, this.renames, this.codeActions, this.documentFormattingEdits] as { unregister(handle: number): void }[]) {
			registry.unregister(handle);
		}
	}

	getCompletionTriggerCharacters(languageId: string): readonly string[] {
		const characters = this._triggerCharacters.get(languageId);
		// the reference also carries the provider's own triggerCharacters; ours are registered here
		return characters ? [...characters] : [];
	}
}

// ---- the MainThreadLanguageFeatures wire service (the host calls these)

export interface IExtHostLanguageFeaturesProxy {
	$provideCompletionItems(handle: number, requestId: number, uri: { scheme: string; path: string }, position: { line: number; character: number }, context: IWireCompletionContext, version: number): Promise<IWireCompletionList | null>;
	$provideHover(handle: number, requestId: number, uri: { scheme: string; path: string }, position: { line: number; character: number }): Promise<IWireHover | null>;
	$provideDocumentSymbols(handle: number, requestId: number, uri: { scheme: string; path: string }): Promise<readonly IWireDocumentSymbol[] | null>;
	$provideDefinition(handle: number, requestId: number, uri: { scheme: string; path: string }, position: { line: number; character: number }): Promise<readonly IWireLocation[] | null>;
	$provideRenameEdits(handle: number, requestId: number, uri: { scheme: string; path: string }, position: { line: number; character: number }, newName: string): Promise<IWireWorkspaceEdit | null>;
	$resolveRenameLocation(handle: number, requestId: number, uri: { scheme: string; path: string }, position: { line: number; character: number }): Promise<IWireRenameLocation | null>;
	$provideCodeActions(handle: number, requestId: number, uri: { scheme: string; path: string }, range: IWireRange, context: IWireCodeActionContext): Promise<readonly IWireCodeAction[] | null>;
	$provideDocumentFormattingEdits(handle: number, requestId: number, uri: { scheme: string; path: string }, options: IWireFormattingOptions): Promise<readonly IWireTextEdit[] | null>;
}

export function createMainThreadLanguageFeatures(
	service: LanguageFeaturesService,
	markers: MarkerService,
	callHost: (method: string, args: unknown[]) => Promise<unknown>,
	logService: ILogService
): { service: unknown; dispose(): void } {
	const disposables: IDisposable[] = [];

	// superseded fetches reach the host, which fires the provider's cancellation token
	service.setCancelRequest((handle, requestId) => {
		void callHost('$cancelProviderRequest', [handle, requestId]).catch(() => { /* host gone */ });
	});

	const completionAdapter = (handle: number): ICompletionProviderAdapter => ({
		handle,
		async provideCompletionItems(resource, model, position, context, requestId): Promise<IWireCompletionList | null> {
			try {
				// the model version goes along: the editor drops stale results (the ported guard)
				const result = await callHost('$provideCompletionItems', [handle, requestId, { scheme: resource.scheme, path: resource.path }, { line: position.lineNumber - 1, character: position.column - 1 }, context, model.getVersionId()]);
				return (result as IWireCompletionList | null) ?? null;
			} catch (error) {
				logService.warn(`completion provider failed: ${(error as Error).message}`);
				return null;
			}
		}
	});

	const hoverAdapter = (handle: number): IHoverProviderAdapter => ({
		handle,
		async provideHover(resource, model, position, requestId): Promise<IWireHover | null> {
			try {
				const result = await callHost('$provideHover', [handle, requestId, { scheme: resource.scheme, path: resource.path }, { line: position.lineNumber - 1, character: position.column - 1 }]);
				void model;
				return (result as IWireHover | null) ?? null;
			} catch (error) {
				logService.warn(`hover provider failed: ${(error as Error).message}`);
				return null;
			}
		}
	});

	/** one place for "ask the host, and never let a bad answer out of this file" */
	const ask = async <T>(method: string, label: string, args: unknown[]): Promise<T | null> => {
		try {
			return ((await callHost(method, args)) as T | null) ?? null;
		} catch (error) {
			logService.warn(`${label} provider failed: ${(error as Error).message}`);
			return null;
		}
	};

	const documentSymbolAdapter = (handle: number): IDocumentSymbolProviderAdapter => ({
		handle,
		provideDocumentSymbols(resource, requestId) {
			return ask<readonly IWireDocumentSymbol[]>('$provideDocumentSymbols', 'document symbol', [handle, requestId, { scheme: resource.scheme, path: resource.path }]);
		}
	});

	const definitionAdapter = (handle: number): IDefinitionProviderAdapter => ({
		handle,
		provideDefinition(resource, position, requestId) {
			return ask<readonly IWireLocation[]>('$provideDefinition', 'definition', [handle, requestId, { scheme: resource.scheme, path: resource.path }, toWirePosition(position)]);
		}
	});

	const renameAdapter = (handle: number, supportsResolveInitialValues: boolean): IRenameProviderAdapter => ({
		handle,
		supportsResolveInitialValues,
		provideRenameEdits(resource, position, newName, requestId) {
			return ask<IWireWorkspaceEdit>('$provideRenameEdits', 'rename', [handle, requestId, { scheme: resource.scheme, path: resource.path }, toWirePosition(position), newName]);
		},
		resolveRenameLocation(resource, position, requestId) {
			if (!supportsResolveInitialValues) {
				return Promise.resolve(null);
			}
			return ask<IWireRenameLocation>('$resolveRenameLocation', 'rename', [handle, requestId, { scheme: resource.scheme, path: resource.path }, toWirePosition(position)]);
		}
	});

	const codeActionAdapter = (handle: number, providedCodeActionKinds: readonly string[]): ICodeActionProviderAdapter => ({
		handle,
		providedCodeActionKinds,
		provideCodeActions(resource, range, context, requestId) {
			return ask<readonly IWireCodeAction[]>('$provideCodeActions', 'code action', [handle, requestId, { scheme: resource.scheme, path: resource.path }, toWireRange(range), context]);
		}
	});

	const documentFormattingAdapter = (handle: number): IDocumentFormattingEditProviderAdapter => ({
		handle,
		provideDocumentFormattingEdits(resource, options, requestId) {
			return ask<readonly IWireTextEdit[]>('$provideDocumentFormattingEdits', 'document formatting', [handle, requestId, { scheme: resource.scheme, path: resource.path }, options]);
		}
	});

	// the host registers providers here (MainThreadLanguageFeatures.$registerCompletionProvider …)
	const wire = {
		$registerCompletionProvider: async (handle: number, language: string, triggerCharacters?: readonly string[]): Promise<void> => {
			disposables.push(service.completions.register(language, completionAdapter(handle)));
			if (triggerCharacters && triggerCharacters.length > 0) {
				service.setTriggerCharacters(handle, language, triggerCharacters);
			}
		},
		$registerHoverProvider: async (handle: number, language: string): Promise<void> => {
			disposables.push(service.hovers.register(language, hoverAdapter(handle)));
		},
		$registerDocumentSymbolProvider: async (handle: number, language: string, label: string): Promise<void> => {
			void label;
			disposables.push(service.documentSymbols.register(language, documentSymbolAdapter(handle)));
		},
		$registerDefinitionSupport: async (handle: number, language: string): Promise<void> => {
			disposables.push(service.definitions.register(language, definitionAdapter(handle)));
		},
		$registerRenameSupport: async (handle: number, language: string, supportsResolveInitialValues: boolean): Promise<void> => {
			disposables.push(service.renames.register(language, renameAdapter(handle, supportsResolveInitialValues)));
		},
		$registerCodeActionSupport: async (handle: number, language: string, metadata: { providedCodeActionKinds?: readonly string[] }, displayName: string): Promise<void> => {
			void displayName;
			disposables.push(service.codeActions.register(language, codeActionAdapter(handle, metadata?.providedCodeActionKinds ?? [])));
		},
		$registerDocumentFormattingSupport: async (handle: number, language: string, displayName: string): Promise<void> => {
			void displayName;
			disposables.push(service.documentFormattingEdits.register(language, documentFormattingAdapter(handle)));
		},
		$unregisterProvider: async (handle: number): Promise<void> => {
			service.unregisterEverywhere(handle);
		},
		/** the diagnostics push: LSP severities (Error=1..Hint=4) → the ported marker flags */
		$changeDiagnostics: async (owner: string, entries: readonly { uri: { scheme: string; path: string }; markers: readonly { range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity: number; message: string; code?: string }[] }[]): Promise<void> => {
			if (entries.length === 0 && owner) {
				markers.removeOwner(owner);
				return;
			}
			markers.changeAll(owner, entries.map(entry => ({
				resource: URI.file(entry.uri.path),
				markers: entry.markers.map(marker => ({
					severity: toMarkerSeverity(marker.severity),
					message: marker.message,
					code: marker.code,
					range: {
						startLineNumber: marker.range.start.line + 1,
						startColumn: marker.range.start.character + 1,
						endLineNumber: marker.range.end.line + 1,
						endColumn: marker.range.end.character + 1
					}
				}))
			})));
		}
	};

	return {
		service: wire,
		dispose() {
			for (const disposable of disposables) {
				disposable.dispose();
			}
		}
	};
}
