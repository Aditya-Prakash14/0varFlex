// src/extHost/mainThreadTypes.ts — the wire-facing service interfaces the HOST calls (the
// renderer serves these; names mirror the reference's MainThreadX classes). These are the DTO
// boundaries: nothing but plain data crosses.

import type {
	IWireActiveEditor,
	IWireConfigChange,
	IWireStatusBarEntry,
	IWireTextDocument,
	IWireMessageSeverity
} from '../common/platform/extensions/common/extensionHostProtocol.js';

export interface IMainThreadCommands {
	$registerCommand(id: string): Promise<void>;
	$unregisterCommand(id: string): Promise<void>;
	/** `vscode.commands.executeCommand` — runs ANY command (core or extension) in the workbench */
	$executeCommand(id: string, args: readonly unknown[]): Promise<unknown>;
}

export interface IMainThreadMessage {
	/** resolves with the clicked item (or undefined when dismissed) — the answer travels back */
	$showMessage(severity: IWireMessageSeverity, message: string, items: readonly string[]): Promise<string | undefined>;
}

export interface IMainThreadStatusBar {
	$setEntry(id: string, entry: IWireStatusBarEntry): Promise<void>;
	$disposeEntry(id: string): Promise<void>;
}

export interface IMainThreadConfiguration {
	$getAllConfiguration(): Promise<{ readonly [key: string]: unknown }>;
	$updateValue(section: string | undefined, key: string, value: unknown): Promise<void>;
}

export interface IMainThreadDocuments {
	$getAllDocuments(): Promise<readonly IWireTextDocument[]>;
	$getActiveEditor(): Promise<IWireActiveEditor | null>;
}

import type { IWireCompletionList, IWireHover, IWireRange } from '../common/platform/extensions/common/extensionHostProtocol.js';

export interface IMainThreadLanguageFeatures {
	$registerCompletionProvider(handle: number, language: string, triggerCharacters?: readonly string[]): Promise<void>;
	$registerHoverProvider(handle: number, language: string): Promise<void>;
	$unregisterProvider(handle: number): Promise<void>;
	/** the diagnostics push: owner = the collection name; empty entries clear everything */
	$changeDiagnostics(owner: string, entries: readonly { uri: { scheme: string; path: string }; markers: readonly { range: IWireRange; severity: number; message: string; code?: string }[] }[]): Promise<void>;
}

export interface IMainThreadLog {
	$log(level: 'trace' | 'info' | 'warn' | 'error', message: string, extensionId?: string): Promise<void>;
}

/** the host-served channels the renderer calls */
export interface IExtHostConfiguration {
	/** the renderer pushes the fresh configuration snapshot after a change */
	$acceptConfigurationChanged(all: { readonly [key: string]: unknown }, changedKeys: readonly string[]): Promise<void>;
}

export interface IExtHostDocuments {
	$acceptOpenDocument(document: IWireTextDocument): Promise<void>;
	$acceptChangeDocument(change: { uri: IWireTextDocument['uri']; contentChange: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; rangeOffset: number; rangeLength: number; text: string }; document: IWireTextDocument }): Promise<void>;
	$acceptCloseDocument(uri: IWireTextDocument['uri']): Promise<void>;
	$acceptActiveEditorChange(editor: IWireActiveEditor | null): Promise<void>;
}

export interface IExtHostExtensionService {
	/** the handshake: initialize → ready; nothing activates before this resolves */
	initialize(initData: unknown): Promise<void>;
	$activateExtension(identifier: string, reason: string): Promise<{ activationTimeMs: number }>;
	terminate(): Promise<void>;
}

export interface IExtHostCommandsProxy {
	$executeContributedCommand(id: string, args: unknown[]): Promise<unknown>;
}
