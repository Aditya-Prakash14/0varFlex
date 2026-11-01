// src/common/platform/extensions/common/extensionHostProtocol.ts — the host handshake and the
// wire DTOs, ported in shape from vs/workbench/services/extensions/common/extensionHostProtocol.ts.
//
// The renderer sends `initialize(initData)` over the MessagePort BEFORE the host may activate
// anything; the reply is the `ready` signal. Everything crossing the port is a plain DTO —
// `Uri`-like classes do not survive structured clone (that is what extHostTypeConverters is for
// in the reference; the DTOs live here).

import type { IExtensionDescription } from './extensions.js';

// ---- handshake

export interface IWireWorkspaceFolder {
	readonly path: string;
	readonly name: string;
	readonly index: number;
}

export interface IExtensionHostInitData {
	readonly extensions: readonly IExtensionDescription[];
	/**
	 * A2: the host needs the workspace root — `workspace.workspaceFolders` used to return
	 * undefined, so an extension could not find the folder it operates on (git-lite needs the
	 * repository root). Pushed again on change via $acceptWorkspaceFoldersChange.
	 */
	readonly workspaceFolders: readonly IWireWorkspaceFolder[];
	readonly userDataPath: string;
	readonly logLevel: string;
	readonly env: {
		readonly appName: string;
		readonly appVersion: string;
	};
}

/** the message main sends the utility process to hand over its end of the port dance */
export interface IExtHostPortMessage {
	readonly type: 'port';
}

/** main → renderer lifecycle note (the port itself carries the RPC) */
export interface IExtHostLifecycleMessage {
	readonly type: 'exit';
	readonly code: number | undefined;
}

// ---- channel names (mirroring the reference's MainThreadX / ExtHostX classes)

export const MAIN_THREAD_COMMANDS = 'MainThreadCommands';
export const MAIN_THREAD_MESSAGE = 'MainThreadMessage';
export const MAIN_THREAD_STATUS_BAR = 'MainThreadStatusBar';
export const MAIN_THREAD_CONFIGURATION = 'MainThreadConfiguration';
export const MAIN_THREAD_DOCUMENTS = 'MainThreadDocuments';
export const MAIN_THREAD_LOG = 'MainThreadLog';

export const EXT_HOST_EXTENSION_SERVICE = 'ExtHostExtensionService';
export const EXT_HOST_COMMANDS = 'ExtHostCommands';
export const EXT_HOST_DOCUMENTS = 'ExtHostDocuments';
export const EXT_HOST_CONFIGURATION = 'ExtHostConfiguration';
export const EXT_HOST_LANGUAGE_FEATURES = 'ExtHostLanguageFeatures';
/** A2-1: the host-served SCM channel (input box echoes) */
export const EXT_HOST_SCM = 'ExtHostSCM';
/** A2: folder changes pushed to the host */
export const EXT_HOST_WORKSPACE = 'ExtHostWorkspace';

export const MAIN_THREAD_LANGUAGE_FEATURES = 'MainThreadLanguageFeatures';
/** A2-1: the source control API surface the workbench serves */
export const MAIN_THREAD_SCM = 'MainThreadSCM';

// ---- wire DTOs

export interface IWireUri {
	readonly scheme: string;
	readonly path: string;
}

/** 0-based, like the host-side API (the reference converts at exactly this boundary) */
export interface IWirePosition {
	readonly line: number;
	readonly character: number;
}

export interface IWireRange {
	readonly start: IWirePosition;
	readonly end: IWirePosition;
}

export interface IWireTextDocument {
	readonly uri: IWireUri;
	readonly languageId: string;
	readonly version: number;
	readonly isClosed: boolean;
	readonly isDirty: boolean;
	/** delta note: the reference sends incremental deltas; we sync full text */
	readonly text: string;
	readonly eol: string;
}

export interface IWireTextDocumentChange {
	readonly uri: IWireUri;
	/** the ported DTO shape so 12 can switch to deltas without API churn */
	readonly contentChange: {
		readonly range: IWireRange;
		readonly rangeOffset: number;
		readonly rangeLength: number;
		readonly text: string;
	};
	/** the full document after the change (delta note above) */
	readonly document: IWireTextDocument;
}

export interface IWireSelection {
	readonly anchor: IWirePosition;
	readonly active: IWirePosition;
}

export interface IWireActiveEditor {
	readonly document: IWireTextDocument;
	readonly selection: IWireSelection;
}

export interface IWireStatusBarEntry {
	readonly text: string;
	readonly tooltip?: string;
	readonly command?: string;
	readonly alignment: number;
	readonly priority: number;
	readonly extensionId: string;
}

export interface IWireConfigChange {
	readonly keys: readonly string[];
}

export interface IWireConfigValue {
	readonly value: unknown;
}

export type IWireMessageSeverity = 'info' | 'warning' | 'error';

// ---- language features (12): completion/hover/diagnostics DTOs
// (LSP numeric values are used verbatim: CompletionItemKind 1..25, DiagnosticSeverity Error=1..Hint=4)

export interface IWireCompletionItem {
	readonly label: string;
	readonly kind?: number;
	readonly detail?: string;
	readonly documentation?: string;
	readonly insertText?: string;
	readonly filterText?: string;
	readonly sortText?: string;
	/** `textEdit`-lite: the range to replace + the new text (the LSP client feeds this directly) */
	readonly textEdit?: {
		readonly range: IWireRange;
		readonly newText: string;
	};
}

export interface IWireCompletionList {
	readonly items: readonly IWireCompletionItem[];
	readonly isIncomplete: boolean;
}

export interface IWireCompletionContext {
	/** CompletionTriggerKind: Invoke = 1, TriggerCharacter = 2, TriggerForIncompleteCompletions = 3 */
	readonly triggerKind: number;
	readonly triggerCharacter?: string;
}

export interface IWireMarkupContent {
	readonly kind: 'plaintext' | 'markdown';
	readonly value: string;
}

export interface IWireHover {
	readonly contents: readonly IWireMarkupContent[];
	readonly range?: IWireRange;
}

export interface IWireDiagnostic {
	readonly range: IWireRange;
	/** DiagnosticSeverity: Error = 1, Warning = 2, Information = 3, Hint = 4 */
	readonly severity: number;
	readonly message: string;
	readonly code?: string;
}

/** CompletionTriggerKind / DiagnosticSeverity live where the LSP draft puts them */
export const enum CompletionTriggerKind {
	Invoke = 1,
	TriggerCharacter = 2,
	TriggerForIncompleteCompletions = 3
}

export const enum LspDiagnosticSeverity {
	Error = 1,
	Warning = 2,
	Information = 3,
	Hint = 4
}

// ---- conversion helpers (the boundary, in one place)

export function uriToWire(uri: { scheme: string; path: string }): IWireUri {
	return { scheme: uri.scheme, path: uri.path };
}

export function wireToUri(wire: IWireUri): { scheme: string; path: string } {
	return { scheme: wire.scheme, path: wire.path };
}

// ---- A2-1: source control (SCM) wire shapes
//
// Ported in subset from vs/workbench/api/common/extHost.protocol.ts's MainThreadSCMShape. The
// workbench has NO git code: it renders whatever a provider registers, and a click runs a
// COMMAND the extension owns — which is why no git concept appears on this wire.

/** one changed file. `letter` is the status badge (M/A/D/R/U/?) the view renders and colors. */
export interface IWireScmResource {
	readonly path: string;
	readonly letter: string;
	readonly tooltip?: string;
	/** run when the row is clicked — the extension's own command (e.g. open the diff) */
	readonly command?: { readonly id: string; readonly args?: readonly unknown[] };
}

export interface IWireScmResourceGroup {
	readonly id: string;
	readonly label: string;
	readonly resources: readonly IWireScmResource[];
}

export interface IWireSourceControl {
	readonly id: string;
	readonly label: string;
	readonly rootPath?: string;
	readonly groups: readonly IWireScmResourceGroup[];
	readonly inputBoxPlaceholder: string;
	readonly inputBoxValue: string;
	/** the command the commit button / ctrl+enter runs */
	readonly acceptCommand?: { readonly id: string; readonly args?: readonly unknown[] };
	/** badge count for the activity bar / view header */
	readonly count: number;
}
