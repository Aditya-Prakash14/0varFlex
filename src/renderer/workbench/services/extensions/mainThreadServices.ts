// src/renderer/workbench/services/extensions/mainThreadServices.ts — the workbench-side RPC
// targets (the reference's MainThreadX classes) plus the DOCUMENT MIRROR that feeds the host:
// model add/change/dispose and active-editor changes are pushed as plain DTOs over the port.
//
// The full-text sync is the ported delta (extHostDocuments.ts uses incremental deltas); the
// contentChange DTO already carries the range shape so 12 can switch without API churn.

import { Disposable, DisposableStore, IDisposable } from '../../../../common/base/common/lifecycle.js';
import type { ILogService } from '../../../../common/platform/log/common/log.js';
import type { IConfigurationService } from '../../../../common/platform/configuration/common/configuration.js';
import {
	EXT_HOST_CONFIGURATION,
	EXT_HOST_DOCUMENTS,
	EXT_HOST_LANGUAGE_FEATURES,
	MAIN_THREAD_LANGUAGE_FEATURES,
	IWireActiveEditor,
	IWireRange,
	IWireTextDocument,
	MAIN_THREAD_COMMANDS,
	MAIN_THREAD_CONFIGURATION,
	MAIN_THREAD_DOCUMENTS,
	MAIN_THREAD_LOG,
	MAIN_THREAD_MESSAGE,
	MAIN_THREAD_STATUS_BAR
} from '../../../../common/platform/extensions/common/extensionHostProtocol.js';
import { ChannelServer, ProxyChannel } from '../../../../common/base/parts/ipc/ipc.js';
import { StatusbarAlignment } from '../../browser/parts/statusbar/statusbarPart.js';
import type { StatusbarPart } from '../../browser/parts/statusbar/statusbarPart.js';
import type { NotificationService } from '../notifications/browser/notificationService.js';
import type { LanguageService } from '../languages/common/languageService.js';
import type { CodeEditorService } from '../editor/browser/codeEditorService.js';
import type { EditorService } from '../editor/browser/editorService.js';
import type { EditorPart } from '../../browser/parts/editor/editorPart.js';
import type { TextEditorPane } from '../../browser/parts/editor/editorPanes.js';
import type { ICommandService } from '../../../platform/commands/common/commands.js';
import type { TextModel } from '../../../../common/editor/common/model/textModel.js';
import { URI } from '../../../../common/base/common/uri.js';
import type { ExtensionService } from './extensionService.js';
import { ExtensionHostManager } from './extensionHostManager.js';
import { createMainThreadLanguageFeatures } from '../../api/common/mainThreadLanguageFeatures.js';
import type { LanguageFeaturesService } from '../../api/common/mainThreadLanguageFeatures.js';
import type { MarkerService } from '../markers/browser/markerService.js';
import { ConfigurationRegistry } from '../../../../common/platform/configuration/common/configurationRegistry.js';

export interface IMainThreadServices {
	readonly logService: ILogService;
	readonly commandService: ICommandService;
	readonly configurationService: IConfigurationService;
	readonly notifications: NotificationService;
	readonly statusbar: StatusbarPart;
	readonly languageService: LanguageService;
	readonly codeEditorService: CodeEditorService;
	readonly editorService: EditorService;
	readonly editorPart: EditorPart;
	readonly languageFeatures: LanguageFeaturesService;
	readonly markers: MarkerService;
	/** late-bound to break the construction cycle with the extension service */
	readonly getExtensionService: () => ExtensionService;
}

interface IDocumentSinks {
	open: (document: IWireTextDocument) => void;
	change: (change: unknown) => void;
	close: (uri: { scheme: string; path: string }) => void;
	active: (editor: IWireActiveEditor | null) => void;
	config: (all: { [key: string]: unknown }, changedKeys: readonly string[]) => void;
}

/** the document mirror: workbench models/editors → wire DTOs → the host's ExtHostDocuments */
export class WorkbenchDocuments extends Disposable {

	private readonly _documentListeners = new Map<string, IDisposable>();
	private _sinks: IDocumentSinks | undefined;

	constructor(private readonly _services: IMainThreadServices) {
		super();
		const { codeEditorService } = _services;

		this._register(codeEditorService.onDidAddModel(({ model, resource }) => {
			this._documentListeners.set(resource.toString(), model.onDidChangeContent(event => {
				const change = event.changes[0];
				if (change) {
					this._sinks?.change({
						uri: { scheme: resource.scheme, path: resource.path },
						contentChange: {
							range: toWireRange(change.range),
							rangeOffset: change.rangeOffset,
							rangeLength: change.rangeLength,
							text: change.text
						},
						document: this._toWireDocument(resource, model)
					});
				}
			}));
			this._sinks?.open(this._toWireDocument(resource, model));
			// `onLanguage:<id>` activation fires when a document with that language opens
			void _services.getExtensionService().activateForLanguage(_services.languageService.languageIdForResource(resource));
		}));

		this._register(codeEditorService.onDidDisposeModel(({ resource }) => {
			this._documentListeners.get(resource.toString())?.dispose();
			this._documentListeners.delete(resource.toString());
			this._sinks?.close({ scheme: resource.scheme, path: resource.path });
		}));

		// active editor: the part's active group + every group's active tab (including new groups)
		const track = (): void => this._sinks?.active(this.activeEditor);
		this._register(_services.editorService.onDidOpenEditor(() => track()));
		this._register(_services.editorPart.onDidActiveGroupChange(() => track()));
		this._register(_services.editorPart.onDidAddGroup(group => this._register(group.onDidActiveEditorChange(() => track()))));
		for (const group of _services.editorPart.groups) {
			this._register(group.onDidActiveEditorChange(() => track()));
		}
	}

	setSinks(sinks: IDocumentSinks): void {
		this._sinks = sinks;
	}

	/** 11: after any configuration change, the host's mirror gets the fresh snapshot */
	pushConfiguration(all: { [key: string]: unknown }, changedKeys: readonly string[]): void {
		this._sinks?.config(all, changedKeys);
	}

	get allDocuments(): readonly IWireTextDocument[] {
		const documents: IWireTextDocument[] = [];
		for (const uriString of this._documentListeners.keys()) {
			const resource = URI.parse(uriString);
			const model = this._services.codeEditorService.findModel(resource);
			if (model) {
				documents.push(this._toWireDocument(resource, model));
			}
		}
		return documents;
	}

	get activeEditor(): IWireActiveEditor | null {
		const group = this._services.editorPart.activeGroup;
		const input = group.activeEditor;
		const pane = group.activePane;
		if (!input || !pane || !('getWidget' in pane)) {
			return null;
		}
		const resource = input.getResource();
		const model = resource ? this._services.codeEditorService.findModel(resource) : undefined;
		if (!resource || !model) {
			return null;
		}
		const widget = (pane as TextEditorPane).getWidget();
		const selection = widget.getSelection();
		return {
			document: this._toWireDocument(resource, model),
			selection: {
				anchor: { line: selection.anchorLineNumber - 1, character: selection.anchorColumn - 1 },
				active: { line: selection.activeLineNumber - 1, character: selection.activeColumn - 1 }
			}
		};
	}

	private _toWireDocument(resource: URI, model: TextModel): IWireTextDocument {
		return {
			uri: { scheme: resource.scheme, path: resource.path },
			languageId: this._services.languageService.languageIdForResource(resource),
			version: model.getVersionId(),
			isClosed: false,
			isDirty: model.isModified(),
			text: model.getValue(),
			eol: model.getEOL()
		};
	}
}

export function toWireRange(range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }): IWireRange {
	return {
		start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
		end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
	};
}

/** installs every MainThreadX service on the renderer's server (the host calls these) */
export function registerAllMainThreadServices(server: ChannelServer<string>, services: IMainThreadServices, documents: WorkbenchDocuments, host: ExtensionHostManager): void {
	const extensionService = services.getExtensionService();

	server.registerChannel(MAIN_THREAD_COMMANDS, ProxyChannel.fromService({
		$registerCommand: async (id: string) => extensionService.ensureExtensionCommand(id),
		$unregisterCommand: async (id: string) => {
			// the workbench keeps the stub registered (its handler re-activates); nothing to do here
			void id;
		},
		$executeCommand: async (id: string, args: readonly unknown[]) => services.commandService.executeCommand(id, ...args)
	}, new DisposableStore()));

	server.registerChannel(MAIN_THREAD_MESSAGE, ProxyChannel.fromService({
		$showMessage: (severity: 'info' | 'warning' | 'error', message: string, items: readonly string[]) =>
			services.notifications.show({ severity, message, items: [...items] })
	}, new DisposableStore()));

	const statusbarEntries = new Map<string, { extensionId: string; text: string }>();
	server.registerChannel(MAIN_THREAD_STATUS_BAR, ProxyChannel.fromService({
		$setEntry: async (id: string, entry: { text: string; tooltip?: string; command?: string; alignment: number; priority: number; extensionId: string }) => {
			const existing = statusbarEntries.get(id);
			if (existing && existing.extensionId !== entry.extensionId) {
				services.logService.warn(`status bar id conflict: ${id} is owned by ${existing.extensionId}`);
				return;
			}
			statusbarEntries.set(id, { extensionId: entry.extensionId, text: entry.text });
			services.statusbar.addEntry(id, {
				text: entry.text,
				alignment: entry.alignment === 2 ? StatusbarAlignment.RIGHT : StatusbarAlignment.LEFT,
				priority: entry.priority,
				title: entry.tooltip,
				onClick: entry.command ? () => void services.commandService.executeCommand(entry.command!) : undefined
			});
		},
		$disposeEntry: async (id: string) => {
			statusbarEntries.delete(id);
			services.statusbar.removeEntry(id);
		}
	}, new DisposableStore()));

	server.registerChannel(MAIN_THREAD_CONFIGURATION, ProxyChannel.fromService({
		$getAllConfiguration: async () => snapshotConfiguration(services.configurationService),
		$updateValue: async (section: string | undefined, key: string, value: unknown) => {
			const fullKey = section ? `${section}.${key}` : key;
			await services.configurationService.updateValue(fullKey, value);
		}
	}, new DisposableStore()));

	server.registerChannel(MAIN_THREAD_DOCUMENTS, ProxyChannel.fromService({
		$getAllDocuments: async () => documents.allDocuments,
		$getActiveEditor: async () => documents.activeEditor
	}, new DisposableStore()));

	// ---- MainThreadLanguageFeatures: provider registrations + the diagnostics push
	const languageFeatureHost = createMainThreadLanguageFeatures(
		services.languageFeatures,
		services.markers,
		(method, args) => host.callHostService(EXT_HOST_LANGUAGE_FEATURES, method, args),
		services.logService
	);
	server.registerChannel(MAIN_THREAD_LANGUAGE_FEATURES, ProxyChannel.fromService(languageFeatureHost.service, new DisposableStore()));

	server.registerChannel(MAIN_THREAD_LOG, ProxyChannel.fromService({
		$log: async (level: 'trace' | 'info' | 'warn' | 'error', message: string, extensionId?: string) => {
			const prefixed = extensionId ? `[${extensionId}] ${message}` : `[extension host] ${message}`;
			if (level === 'error') {
				services.logService.error(prefixed);
			} else if (level === 'warn') {
				services.logService.warn(prefixed);
			} else if (level === 'trace') {
				services.logService.trace(prefixed);
			} else {
				services.logService.info(prefixed);
			}
		}
	}, new DisposableStore()));

	// the push sources (host-served channels the renderer calls)
	const callHost = (channel: string, method: string, args: unknown[]): void => {
		void host.callHostService(channel, method, args).catch(error => {
			services.logService.warn(`[extension host] ${channel}:${method} failed: ${(error as Error).message}`);
		});
	};
	documents.setSinks({
		open: document => callHost(EXT_HOST_DOCUMENTS, '$acceptOpenDocument', [document]),
		change: change => callHost(EXT_HOST_DOCUMENTS, '$acceptChangeDocument', [change]),
		close: uri => callHost(EXT_HOST_DOCUMENTS, '$acceptCloseDocument', [uri]),
		active: editor => callHost(EXT_HOST_DOCUMENTS, '$acceptActiveEditorChange', [editor]),
		config: (all, changedKeys) => callHost(EXT_HOST_CONFIGURATION, '$acceptConfigurationChanged', [all, changedKeys])
	});
}

/** the flattened snapshot the host mirrors (NESTED like the reference's initializeConfiguration
 * — a flat dotted key would not be found by `workspace.getConfiguration('section').get('key')`).
 * The source is the configuration REGISTRY, not a hardcoded list: extension-contributed
 * settings (11 registers `contributes.configuration`) must reach the host too. */
export function snapshotConfiguration(configurationService: IConfigurationService): { [key: string]: unknown } {
	const result: { [key: string]: unknown } = {};
	for (const key of ConfigurationRegistry.getConfigurationProperties().keys()) {
		const value = configurationService.getValue(key);
		if (value === undefined) {
			continue;
		}
		const segments = key.split('.');
		let node = result;
		for (let i = 0; i < segments.length - 1; i++) {
			node[segments[i]] = (node[segments[i]] as { [key: string]: unknown } | undefined) ?? {};
			node = node[segments[i]] as { [key: string]: unknown };
		}
		node[segments[segments.length - 1]] = value;
	}
	return result;
}
