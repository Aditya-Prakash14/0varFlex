// src/extHost/main.ts — the extension host entry, ported in shape from
// vs/workbench/api/node/extensionHostProcess.ts:
//
//   - receives its MessagePort from main, then waits for the renderer's `initialize` handshake
//     before anything activates;
//   - patches `require('vscode')` per extension (the reference patches the module loader the
//     same way in extHost.api.impl.ts);
//   - `uncaughtException`/`unhandledRejection` are REPORTED over RPC (the renderer shows the
//     crash toast) and the host keeps running; exit code 0 on clean shutdown.

import { Emitter, Event } from '../common/base/common/event.js';
import { DisposableStore } from '../common/base/common/lifecycle.js';

// the host bundle runs as CJS (utilityProcess forks out/extHost.cjs): node's require exists
declare const require: NodeRequire;
import {
	ChannelClient,
	ChannelServer,
	IMessagePassingProtocol,
	ProxyChannel
} from '../common/base/parts/ipc/ipc.js';
import {
	EXT_HOST_COMMANDS,
	EXT_HOST_CONFIGURATION,
	EXT_HOST_DOCUMENTS,
	EXT_HOST_EXTENSION_SERVICE,
	EXT_HOST_LANGUAGE_FEATURES,
	IExtensionHostInitData,
	MAIN_THREAD_COMMANDS,
	MAIN_THREAD_CONFIGURATION,
	MAIN_THREAD_DOCUMENTS,
	EXT_HOST_SCM,
	EXT_HOST_WORKSPACE,
	MAIN_THREAD_LANGUAGE_FEATURES,
	MAIN_THREAD_SCM,
	MAIN_THREAD_LOG,
	MAIN_THREAD_MESSAGE,
	MAIN_THREAD_STATUS_BAR
} from '../common/platform/extensions/common/extensionHostProtocol.js';
import type { IExtensionDescription } from '../common/platform/extensions/common/extensions.js';
import { ExtHostCommands } from './extHostCommands.js';
import { ExtHostLanguageFeatures } from './extHostLanguageFeatures.js';
import { installConsoleForwarder } from './extHostConsole.js';
import { createApiFactory, ICreateApiFactory } from './extHostApi.js';
import { ExtHostExtensionService } from './extHostExtensionService.js';
import { ExtHostWindow } from './extHostWindow.js';
import { ExtHostWorkspace } from './extHostWorkspace.js';
import { ExtHostSCM } from './extHostSCM.js';
import type {
	IExtHostConfiguration,
	IExtHostDocuments,
	IMainThreadCommands,
	IMainThreadConfiguration,
	IMainThreadDocuments,
	IMainThreadLanguageFeatures,
	IMainThreadSCM,
	IMainThreadLog,
	IMainThreadMessage,
	IMainThreadStatusBar
} from './mainThreadTypes.js';

// ---- the `vscode` module injection (patched before any extension is loaded)

const apiByExtensionLocation = new Map<string, unknown>();
let requireShimInstalled = false;

function installRequireShim(): void {
	if (requireShimInstalled) {
		return;
	}
	requireShimInstalled = true;
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const nodeModule = require('node:module') as typeof import('node:module') & { _load: (request: string, parent: NodeModule, isMain: boolean) => unknown };
	const originalLoad = nodeModule._load;
	nodeModule._load = function (request: string, parent: NodeModule, isMain: boolean) {
		if (request === 'vscode') {
			const parentFile = parent?.filename ?? '';
			for (const [location, api] of apiByExtensionLocation) {
				if (parentFile.startsWith(location)) {
					return api;
				}
			}
			throw new Error(`Cannot find module 'vscode' from ${parentFile} (no extension api registered)`);
		}
		return originalLoad.apply(this, [request, parent, isMain]);
	};
}

function runHost(port: Electron.MessagePortMain): void {
	const onMessage = new Emitter<unknown>();
	port.on('message', message => onMessage.fire(message.data));
	port.start();
	const protocol: IMessagePassingProtocol = {
		send: message => port.postMessage(message),
		onMessage: onMessage.event
	};

	// the host is BOTH a client (calling MainThreadX on the renderer) and a server (serving
	// ExtHostX to the renderer) over the same port
	const client = new ChannelClient(protocol);
	const server = new ChannelServer(protocol, 'extHost');

	const commandsProxy = ProxyChannel.toService<IMainThreadCommands>(client.getChannel(MAIN_THREAD_COMMANDS));
	const messageProxy = ProxyChannel.toService<IMainThreadMessage>(client.getChannel(MAIN_THREAD_MESSAGE));
	const statusBarProxy = ProxyChannel.toService<IMainThreadStatusBar>(client.getChannel(MAIN_THREAD_STATUS_BAR));
	const configurationProxy = ProxyChannel.toService<IMainThreadConfiguration>(client.getChannel(MAIN_THREAD_CONFIGURATION));
	const documentsProxy = ProxyChannel.toService<IMainThreadDocuments>(client.getChannel(MAIN_THREAD_DOCUMENTS));
	const logProxy = ProxyChannel.toService<IMainThreadLog>(client.getChannel(MAIN_THREAD_LOG));

	const languageFeaturesProxy = ProxyChannel.toService<IMainThreadLanguageFeatures>(client.getChannel(MAIN_THREAD_LANGUAGE_FEATURES));
	const extHostCommands = new ExtHostCommands(commandsProxy);
	const extHostWindow = new ExtHostWindow(messageProxy, statusBarProxy);
	const extHostWorkspace = new ExtHostWorkspace(configurationProxy, documentsProxy);
	const extHostLanguageFeatures = new ExtHostLanguageFeatures(
		languageFeaturesProxy,
		message => void logProxy.$log('warn', message).catch(() => { /* renderer gone */ }),
		{ getDocument: uri => extHostWorkspace.getDocument(uri) }
	);
	// A2-1: the SCM actor — registrations and state updates travel to MainThreadSCM
	const scmProxy = ProxyChannel.toService<IMainThreadSCM>(client.getChannel(MAIN_THREAD_SCM));
	const extHostSCM = new ExtHostSCM(scmProxy, message => void logProxy.$log('warn', message).catch(() => { /* renderer gone */ }));
	let apiFactory: ICreateApiFactory | undefined;
	const extensionsById = new Map<string, IExtensionDescription>();
	const extensionService = new ExtHostExtensionService(logProxy, (extension) => apiFactory ? apiFactory(extension) : Object.freeze({}));
	void extHostWindow;

	installRequireShim();
	installConsoleForwarder(logProxy);

	// ---- the channels the renderer calls

	server.registerChannel(EXT_HOST_EXTENSION_SERVICE, ProxyChannel.fromService({
		/** the handshake: initialize → ready (nothing activates before this resolves) */
		initialize: async (initData: IExtensionHostInitData): Promise<void> => {
			extensionsById.clear();
			for (const description of initData.extensions) {
				extensionsById.set(description.identifier, description);
			}
			apiFactory = createApiFactory({
				commands: extHostCommands,
				window: extHostWindow,
				workspace: extHostWorkspace,
				languages: extHostLanguageFeatures,
				scm: extHostSCM,
				commandsProxy,
				env: initData.env
			});
			// A2: seed the folder mirror BEFORE any extension activates, so an extension's
			// activate() can read workspace.workspaceFolders straight away
			extHostWorkspace.$acceptWorkspaceFoldersChange(initData.workspaceFolders ?? []);
			// register each extension's api under its folder BEFORE any require() can see it
			for (const description of initData.extensions) {
				apiByExtensionLocation.set(description.extensionLocation, apiFactory(description));
			}
			extensionService.$initialize(initData.extensions);
			await extHostWorkspace.initialize();
		},
		$activateExtension: (identifier: string, reason: string) => extensionService.$activateExtension(identifier, reason),
		terminate: async (): Promise<void> => {
			extHostLanguageFeatures.disposeAll();
			extHostSCM.disposeAll();
			await extensionService.deactivateAll();
			setTimeout(() => process.exit(0), 0);
		}
	}, new DisposableStore()));

	server.registerChannel(EXT_HOST_COMMANDS, ProxyChannel.fromService({
		$executeContributedCommand: (id: string, args: unknown[]) => extHostCommands.$executeContributedCommand(id, args)
	}, new DisposableStore()));

	server.registerChannel(EXT_HOST_DOCUMENTS, ProxyChannel.fromService({
		$acceptOpenDocument: (document: Parameters<IExtHostDocuments['$acceptOpenDocument']>[0]) => extHostWorkspace.$acceptOpenDocument(document),
		$acceptChangeDocument: (change: Parameters<IExtHostDocuments['$acceptChangeDocument']>[0]) => extHostWorkspace.$acceptChangeDocument(change as never),
		$acceptCloseDocument: (uri: Parameters<IExtHostDocuments['$acceptCloseDocument']>[0]) => extHostWorkspace.$acceptCloseDocument(uri),
		$acceptActiveEditorChange: (editor: Parameters<IExtHostDocuments['$acceptActiveEditorChange']>[0]) => extHostWorkspace.$acceptActiveEditorChange(editor as never)
	}, new DisposableStore()));

	server.registerChannel(EXT_HOST_LANGUAGE_FEATURES, ProxyChannel.fromService({
		$provideCompletionItems: (handle: number, requestId: number, uri: { scheme: string; path: string }, position: { line: number; character: number }, context: { triggerKind: number; triggerCharacter?: string }) =>
			extHostLanguageFeatures.$provideCompletionItems(handle, requestId, uri, position, context),
		$provideHover: (handle: number, requestId: number, uri: { scheme: string; path: string }, position: { line: number; character: number }) =>
			extHostLanguageFeatures.$provideHover(handle, requestId, uri, position),
		$cancelProviderRequest: (handle: number, requestId: number) => extHostLanguageFeatures.$cancelProviderRequest(handle, requestId)
	}, new DisposableStore()));

	server.registerChannel(EXT_HOST_SCM, ProxyChannel.fromService({
		$acceptInputBoxValue: async (handle: number, value: string) => extHostSCM.$acceptInputBoxValue(handle, value)
	}, new DisposableStore()));

	server.registerChannel(EXT_HOST_WORKSPACE, ProxyChannel.fromService({
		$acceptWorkspaceFoldersChange: async (folders: readonly { path: string; name: string; index: number }[]) =>
			extHostWorkspace.$acceptWorkspaceFoldersChange(folders)
	}, new DisposableStore()));

	server.registerChannel(EXT_HOST_CONFIGURATION, ProxyChannel.fromService({
		$acceptConfigurationChanged: (all: { [key: string]: unknown }, changedKeys: readonly string[]) => extHostWorkspace.$acceptConfigurationChanged(all, changedKeys)
	}, new DisposableStore()));

	// ---- error traps: report, keep going (a single extension must never take the host down)

	process.on('uncaughtException', error => {
		void logProxy.$log('error', `Uncaught exception in the extension host: ${error?.stack ?? error?.message ?? error}`).catch(() => { /* renderer gone */ });
	});
	process.on('unhandledRejection', reason => {
		void logProxy.$log('error', `Unhandled rejection in the extension host: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`).catch(() => { /* ignore */ });
	});
}

// the port arrives from main (the transfer direction is documented: main keeps neither end)
if (typeof process.parentPort !== 'undefined') {
	process.parentPort.once('message', message => {
		const port = message.ports[0];
		if (port) {
			runHost(port);
		}
	});
}

export { runHost };
