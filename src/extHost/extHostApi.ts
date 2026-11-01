// src/extHost/extHostApi.ts — the `vscode` module assembly, ported in shape from
// vs/workbench/api/common/extHost.api.impl.ts (createApiFactoryAndRegisterActors line 152):
// shared actors are created once, and the factory closes over the EXTENSION to build that
// extension's api object. Each namespace delegates to its actor — that is the whole pattern.

import type { IExtensionDescription } from '../common/platform/extensions/common/extensions.js';
import type { ExtHostCommands } from './extHostCommands.js';
import type { ExtHostLanguageFeatures } from './extHostLanguageFeatures.js';
import type { ExtHostWindow } from './extHostWindow.js';
import type { ExtHostWorkspace } from './extHostWorkspace.js';
import type { ExtHostSCM } from './extHostSCM.js';
import type { IMainThreadCommands } from './mainThreadTypes.js';
import {
	ConfigurationTarget,
	Disposable,
	EventEmitter,
	ExtensionMode,
	MarkdownString,
	Position,
	Range,
	Selection,
	StatusBarAlignment,
	Uri,
	ViewColumn
} from './extHostTypes.js';

export interface IExtHostApiServices {
	readonly commands: ExtHostCommands;
	readonly scm: ExtHostSCM;
	readonly languages: ExtHostLanguageFeatures;
	readonly window: ExtHostWindow;
	readonly workspace: ExtHostWorkspace;
	readonly commandsProxy: IMainThreadCommands;
	readonly env: { readonly appName: string; readonly appVersion: string };
}

export type ICreateApiFactory = (extension: IExtensionDescription) => unknown;

export function createApiFactory(services: IExtHostApiServices): ICreateApiFactory {
	return (extension: IExtensionDescription): unknown => {
		const extensionId = extension.identifier;

		const api = {
			version: '1.0.0',

			commands: {
				registerCommand(id: string, callback: (...args: unknown[]) => unknown, thisArg?: unknown): Disposable {
					return services.commands.registerCommand(extensionId, id, (...args) => callback.apply(thisArg, args));
				},
				executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T | undefined> {
					return services.commandsProxy.$executeCommand(id, args) as Promise<T | undefined>;
				},
				getCommands(_filterInternal?: boolean): Promise<string[]> {
					return services.commandsProxy.$executeCommand('mini.probe.listCommands', []).then(
						result => result as string[],
						() => services.commands.registeredIds
					);
				}
			},

			window: {
				showInformationMessage(message: string, ...items: unknown[]): Promise<string | undefined> {
					return services.window.showMessage('info', message, itemLabels(items));
				},
				showWarningMessage(message: string, ...items: unknown[]): Promise<string | undefined> {
					return services.window.showMessage('warning', message, itemLabels(items));
				},
				showErrorMessage(message: string, ...items: unknown[]): Promise<string | undefined> {
					return services.window.showMessage('error', message, itemLabels(items));
				},
				createStatusBarItem(alignmentOrOptions?: StatusBarAlignment | { alignment?: StatusBarAlignment; priority?: number }, priorityOrOptions?: number | { priority?: number }): unknown {
					let alignment = StatusBarAlignment.Left;
					let priority = 0;
					if (typeof alignmentOrOptions === 'number') {
						alignment = alignmentOrOptions;
						priority = typeof priorityOrOptions === 'number' ? priorityOrOptions : 0;
					} else if (alignmentOrOptions && typeof alignmentOrOptions === 'object') {
						alignment = alignmentOrOptions.alignment ?? StatusBarAlignment.Left;
						priority = alignmentOrOptions.priority ?? 0;
					}
					return services.window.createStatusBarItem(extensionId, alignment, priority);
				},
				get activeTextEditor() {
					return services.workspace.activeTextEditor;
				},
				get onDidChangeActiveTextEditor() {
					return services.workspace.onDidChangeActiveTextEditor;
				}
			},

			workspace: {
				get textDocuments() {
					return services.workspace.textDocuments;
				},
				get activeTextEditor() {
					return services.workspace.activeTextEditor;
				},
				getConfiguration(section?: string) {
					return services.workspace.getConfiguration(section);
				},
				onDidOpenTextDocument: services.workspace.onDidOpenTextDocument,
				onDidChangeTextDocument: services.workspace.onDidChangeTextDocument,
				onDidCloseTextDocument: services.workspace.onDidCloseTextDocument,
				onDidChangeConfiguration: (callback: (event: { affectsConfiguration(section: string): boolean }) => void) => services.workspace.onDidChangeConfiguration(callback),
				// A2: a real folder mirror now (git-lite needs the repository root)
				get workspaceFolders() {
					return services.workspace.workspaceFolders;
				},
				onDidChangeWorkspaceFolders: services.workspace.onDidChangeWorkspaceFolders
			},

			languages: {
				registerCompletionItemProvider(selector: { language?: string } | string, provider: unknown, ...triggerCharacters: unknown[]): Disposable {
					const normalized = typeof selector === 'string' ? { language: selector } : selector;
					return services.languages.registerCompletionItemProvider(extension, normalized, provider as never, triggerCharacters.map(character => String(character)));
				},
				registerHoverProvider(selector: { language?: string } | string, provider: unknown): Disposable {
					const normalized = typeof selector === 'string' ? { language: selector } : selector;
					return services.languages.registerHoverProvider(extension, normalized, provider as never);
				},
				createDiagnosticCollection(name?: string): unknown {
					return services.languages.createDiagnosticCollection(extension, name ?? extension.name);
				}
			},

			// A2-1: source control. The workbench renders whatever registers here and runs the
			// commands the resources carry — it has no git concept of its own.
			scm: {
				createSourceControl(id: string, label: string, rootUri?: Uri) {
					return services.scm.createSourceControl(id, label, rootUri);
				}
			},

			env: {
				appName: services.env.appName,
				appVersion: services.env.appVersion,
				language: 'en'
			},

			// the classes/the enums extensions construct or compare against
			Uri,
			Position,
			Range,
			Selection,
			Disposable,
			EventEmitter,
			MarkdownString,
			StatusBarAlignment,
			ConfigurationTarget,
			ViewColumn,
			ExtensionMode,
			ExtensionKind: { UI: 1, Workspace: 2 }
		};

		return Object.freeze(api);
	};
}

function itemLabels(items: unknown[]): string[] {
	return items.map(item => typeof item === 'string' ? item : String((item as { title?: unknown })?.title ?? item));
}
