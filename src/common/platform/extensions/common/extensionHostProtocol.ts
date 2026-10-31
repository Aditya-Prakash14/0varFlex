// src/common/platform/extensions/common/extensionHostProtocol.ts — the host handshake and the
// wire DTOs, ported in shape from vs/workbench/services/extensions/common/extensionHostProtocol.ts.
//
// The renderer sends `initialize(initData)` over the MessagePort BEFORE the host may activate
// anything; the reply is the `ready` signal. Everything crossing the port is a plain DTO —
// `Uri`-like classes do not survive structured clone (that is what extHostTypeConverters is for
// in the reference; the DTOs live here).

import type { IExtensionDescription } from './extensions.js';

// ---- handshake

export interface IExtensionHostInitData {
	readonly extensions: readonly IExtensionDescription[];
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

// ---- conversion helpers (the boundary, in one place)

export function uriToWire(uri: { scheme: string; path: string }): IWireUri {
	return { scheme: uri.scheme, path: uri.path };
}

export function wireToUri(wire: IWireUri): { scheme: string; path: string } {
	return { scheme: wire.scheme, path: wire.path };
}
