import { ProxyChannel } from '../common/base/parts/ipc/ipc.js';
import { URI } from '../common/base/common/uri.js';
import { TextModel } from '../common/editor/common/model/textModel.js';
import { InstantiationService } from '../common/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../common/platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from '../common/platform/instantiation/common/descriptors.js';
import { ILogService } from '../common/platform/log/common/log.js';
import { LogService } from '../common/platform/log/common/logService.js';
import { ILogChannel } from '../common/platform/log/common/logIpc.js';
import { FileServiceClient, IFileServiceWire } from '../common/platform/files/common/fileIpc.js';
import type { IFileService } from '../common/platform/files/common/files.js';
import { IWindowChannel } from '../common/platform/window/common/window.js';
import { ConfigurationService } from '../common/platform/configuration/common/configurationService.js';
import { IStorageService, StorageScope, WillSaveStateReason } from '../common/platform/storage/common/storage.js';
import { BrowserStorageService } from '../common/platform/storage/common/storageService.js';
import { addDisposableListener } from './base/browser/dom.js';
import { EditorOptionsService } from './editor/browser/config.js';
import { Selection } from './editor/browser/core/selection.js';
import { registerEditorCommands } from './editor/browser/editorWidget.js';
import { TextEditorInput } from './workbench/common/editor/textEditorInput.js';
import { CommandMetadata, CommandsRegistry, ICommandService } from './platform/commands/common/commands.js';
import { ContextKeyExpr, RawContextKey } from './platform/contextkey/common/contextkey.js';
import { ContextKeyService } from './platform/contextkey/common/contextKeyService.js';
import { KeyChord, KeyCode, KeyMod } from './platform/keybinding/common/keyCodes.js';
import { getCurrentOS } from './platform/keybinding/common/keybindingLabels.js';
import { KeybindingsRegistry, KeybindingWeight } from './platform/keybinding/common/keybindingsRegistry.js';
import { parseUserKeybindings } from './platform/keybinding/common/userKeybindings.js';
import { KeybindingService } from './platform/keybinding/browser/keybindingService.js';
import { CommandsQuickAccessProvider } from './platform/quickinput/browser/commandsQuickAccess.js';
import { QuickInputController } from './platform/quickinput/browser/quickInput.js';
import { Workbench } from './workbench/browser/workbench.js';
import { StatusbarAlignment } from './workbench/browser/parts/statusbar/statusbarPart.js';
import { registerEditorActions } from './workbench/browser/parts/editor/editorActions.js';
import { TextEditorPane } from './workbench/browser/parts/editor/editorPanes.js';
import { registerConfigurationActions } from './workbench/contrib/configuration/browser/configurationActions.js';
import { registerDefaultConfigurations } from './workbench/contrib/configuration/browser/defaultSettings.js';
import { ExplorerService } from './workbench/contrib/files/browser/explorerService.js';
import { ExplorerView } from './workbench/contrib/files/browser/explorerView.js';
import { registerFileCommands, EXPLORER_ID } from './workbench/contrib/files/browser/fileCommands.js';
import { confirmDialog } from './workbench/browser/parts/editor/dialogs/confirmDialog.js';
import { WorkspaceContextService, createWorkspaceFolder, workspaceSettingsUri } from '../common/platform/workspace/common/workspace.js';
import type { IExtensionScanResult } from '../common/platform/extensions/common/extensionScanner.js';
import { ExtensionService } from './workbench/services/extensions/extensionService.js';
import { ExtensionHostManager } from './workbench/services/extensions/extensionHostManager.js';
import { registerAllMainThreadServices, snapshotConfiguration, WorkbenchDocuments } from './workbench/services/extensions/mainThreadServices.js';
import { registerExtensionContributions } from './workbench/services/extensions/extensionRegistries.js';
import { LanguageService } from './workbench/services/languages/common/languageService.js';
import { NotificationService } from './workbench/services/notifications/browser/notificationService.js';
import { registerLayoutCommands, SHOW_ALL_COMMANDS_ID } from './workbench/contrib/layout/browser/layoutActions.js';
import { CommandService } from './workbench/services/commands/common/commandService.js';
import { CodeEditorService } from './workbench/services/editor/browser/codeEditorService.js';
import { EditorService } from './workbench/services/editor/browser/editorService.js';
import { MainProcessChannelClient } from './parts/ipc/ipcRenderer.js';

/**
 * 10: file watching through the real watcher. The PARENT directory is watched (non-recursively):
 * atomic saves replace the file via rename, and a watcher bound to the old inode would go
 * silent — the directory keeps reporting.
 */
function watchSettingsFile(fileService: IFileService, resource: URI, callback: () => void, logService: ILogService): void {
	const parent = URI.file(resource.fsPath.substring(0, resource.fsPath.lastIndexOf('/')) || '/');
	void fileService.watch(parent, { recursive: false }).catch(error => logService.warn(`cannot watch ${parent.fsPath}: ${(error as Error).message}`));
	fileService.onDidFilesChange(event => {
		if (event.contains(resource)) {
			callback();
		}
	});
}

// the demo document the editor opens with (exercise 08)
const WELCOME_TEXT = [
	'// mini-vscode — exercise 08: the editor view',
	'const greeting = "hello, world";',
	'',
	'function main() {',
	'\treturn greeting.length; // try typing, arrows, Cmd+Z',
	'}',
	'',
	'/* a block comment',
	'   spanning lines: states carry across lines */',
	'class Editor { /* cursor 500ms blink */ }'
].join('\n');

function generateLargeText(lineCount: number): string {
	const lines: string[] = [];
	for (let i = 1; i <= lineCount; i++) {
		lines.push(`line ${i} — const value${i} = ${i % 97}; // generated for the perf gate`);
	}
	return lines.join('\n');
}

/** one-time import of exercise 03's ad-hoc state.json into storage, then delete it */
async function migrateLegacyState(fileService: IFileService, storage: IStorageService, userDataPath: string, logService: ILogService): Promise<void> {
	const legacyResource = URI.joinPath(URI.file(userDataPath), 'state.json');
	const raw = await fileService.readFile(legacyResource).catch(() => null);
	if (raw === null) {
		return;
	}
	try {
		const parsed = JSON.parse(raw) as { layout?: { sidebar?: { width?: number; visible?: boolean }; panel?: { height?: number; visible?: boolean } }; 'commands.recentlyUsed'?: string[] };
		if (storage.get('workbench.layout.sidebar.width', StorageScope.APPLICATION) === undefined && parsed.layout?.sidebar) {
			if (typeof parsed.layout.sidebar.width === 'number') {
				storage.store('workbench.layout.sidebar.width', parsed.layout.sidebar.width, StorageScope.APPLICATION);
			}
			if (typeof parsed.layout.sidebar.visible === 'boolean') {
				storage.store('workbench.layout.sidebar.visible', parsed.layout.sidebar.visible, StorageScope.APPLICATION);
			}
			if (typeof parsed.layout.panel?.height === 'number') {
				storage.store('workbench.layout.panel.height', parsed.layout.panel.height, StorageScope.APPLICATION);
			}
			if (typeof parsed.layout.panel?.visible === 'boolean') {
				storage.store('workbench.layout.panel.visible', parsed.layout.panel.visible, StorageScope.APPLICATION);
			}
		}
		if (Array.isArray(parsed['commands.recentlyUsed']) && storage.get('workbench.commandPalette.mru', StorageScope.APPLICATION) === undefined) {
			storage.store('workbench.commandPalette.mru', parsed['commands.recentlyUsed'], StorageScope.APPLICATION);
		}
		await storage.flush();
		await fileService.del(legacyResource, { useTrash: false });
		logService.info('migrated legacy state.json into storage');
	} catch (error) {
		logService.warn(`legacy state migration failed: ${(error as Error).message}`);
	}
}

async function main(): Promise<void> {
	// ---- transport → channels → services (exercise 02)
	const channelClient = new MainProcessChannelClient();
	const logChannel = ProxyChannel.toService<ILogChannel>(channelClient.getChannel('log'));
	const windowChannel = ProxyChannel.toService<IWindowChannel>(channelClient.getChannel('window'));
	const fileService = new FileServiceClient(ProxyChannel.toService<IFileServiceWire>(channelClient.getChannel('file')));

	const services = new ServiceCollection(
		[ILogService, new SyncDescriptor(LogService, [logChannel])],
	);
	const instantiationService = new InstantiationService(services);
	const logService = instantiationService.invokeFunction(accessor => accessor.get(ILogService));

	// ---- commands + context keys (exercise 04)
	const contextKeyService = new ContextKeyService();
	const commandService = new CommandService(instantiationService, logService);
	services.set(ICommandService, commandService);

	const isFullscreenContext = new RawContextKey<boolean>('isFullscreen', false).bindTo(contextKeyService);
	windowChannel.onDidChangeFullScreen(fullscreen => isFullscreenContext.set(fullscreen));
	void windowChannel.isFullScreen().then(fullscreen => isFullscreenContext.set(fullscreen)).catch(() => { /* window gone */ });

	// ---- the exercise-00 boot line, now just a log line
	const start = performance.now();
	const result = await window.host.ping('hello from the renderer');
	const ms = (performance.now() - start).toFixed(1);
	logService.info(`ping result: ${JSON.stringify(result)} in ${ms}ms`);

	windowChannel.onDidChangeFocus(focused => logService.info(`window focus: ${focused}`));

	// ---- configuration (exercise 06): defaults first, then the user layer from User/settings.json
	registerDefaultConfigurations();

	const userDataPath = await windowChannel.getUserDataPath();
	const settingsPath = URI.joinPath(URI.file(userDataPath), 'User', 'settings.json').fsPath;
	const configurationService = new ConfigurationService(settingsPath, fileService, logService);
	await configurationService.load();
	watchSettingsFile(fileService, URI.file(settingsPath), () => void configurationService.reload(), logService);

	// ---- storage (exercise 06): main-backed files, sync renderer cache
	const storage = new BrowserStorageService(channelClient.getChannel('storage'), logService);
	await storage.initialize(StorageScope.APPLICATION);
	await storage.initialize(StorageScope.WORKSPACE);
	await migrateLegacyState(fileService, storage, userDataPath, logService);

	// writes are debounced; on quit and on focus loss the state gets its final flush
	addDisposableListener(window, 'beforeunload', () => { void storage.flush(WillSaveStateReason.Shutdown); });
	windowChannel.onDidChangeFocus(focused => { if (!focused) { void storage.flush(); } });

	// ---- the workbench (exercise 03); 09 adds the editor services it consumes
	const editorOptions = new EditorOptionsService(configurationService);
	const codeEditorService = new CodeEditorService();
	const workbench = new Workbench(document.body, {
		logService,
		storage,
		configuration: configurationService,
		contextKeyService,
		commandService,
		windowChannel,
		editorOptions,
		codeEditorService
	});
	await workbench.start();

	// ---- layout commands (04/06)
	registerLayoutCommands(workbench.layout, windowChannel);

	// the palette, with MRU persisted through storage (06 moved it off the ad-hoc file)
	const quickInput = new QuickInputController();
	const palette = new CommandsQuickAccessProvider(quickInput, commandService, contextKeyService, {
		get: <T,>(key: string) => storage.getObject<T>(key, StorageScope.APPLICATION),
		set: (key, value) => storage.store(key, value as object, StorageScope.APPLICATION)
	}, logService);
	CommandsRegistry.registerCommand(SHOW_ALL_COMMANDS_ID, () => palette.pick());
	CommandMetadata.register({
		id: SHOW_ALL_COMMANDS_ID,
		title: 'Show All Commands',
		category: 'View'
	});
	KeybindingsRegistry.registerKeybindingRule({
		id: SHOW_ALL_COMMANDS_ID,
		weight: KeybindingWeight.WorkbenchContrib,
		primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP,
		secondary: KeyCode.F1
	});

	// dev probe: proves preconditions gate surfacing (palette) but never execution
	CommandsRegistry.registerCommand('workbench.action.probeNoPanel', () => {
		logService.info('probe command executed (precondition is irrelevant for execution)');
	});
	CommandMetadata.register({
		id: 'workbench.action.probeNoPanel',
		title: 'Probe: Panel Hidden',
		category: 'Dev',
		precondition: ContextKeyExpr.not('panelVisible')
	});

	// dev probes for the context-gating acceptance (05): handlers log which side matched
	CommandsRegistry.registerCommand('mini.probe.whenVisible', () => logService.info('gated probe fired: sidebarVisible'));
	CommandsRegistry.registerCommand('mini.probe.whenHidden', () => logService.info('gated probe fired: !sidebarVisible'));

	// ---- keybindings (exercise 05)
	const os = getCurrentOS();
	const keybindingService = new KeybindingService(commandService, contextKeyService, logService, os);

	CommandsRegistry.registerCommand('mini.probe.chordA', () => logService.info('chord probe A fired'));
	CommandsRegistry.registerCommand('mini.probe.chordB', () => logService.info('chord probe B fired'));
	KeybindingsRegistry.registerKeybindingRule({
		id: 'mini.probe.chordA',
		weight: KeybindingWeight.BuiltinExtension,
		primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyA)
	});
	KeybindingsRegistry.registerKeybindingRule({
		id: 'mini.probe.chordB',
		weight: KeybindingWeight.BuiltinExtension,
		primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyB)
	});
	keybindingService.rebuild();

	const keybindingsPath = URI.joinPath(URI.file(userDataPath), 'keybindings.json').fsPath;
	const loadUserKeybindings = async (): Promise<void> => {
		try {
			const text = await fileService.readFile(URI.file(keybindingsPath)).catch(() => null);
			if (text === null) {
				return; // no file yet
			}
			const { items, errors } = parseUserKeybindings(text, os);
			for (const error of errors) {
				logService.error(`keybindings.json: ${error}`);
			}
			if (errors.length > 0 && items.length === 0) {
				return; // keep the last good state
			}
			keybindingService.setUserKeybindings(items);
			logService.info(`keybindings.json loaded (${items.length} entries)`);
		} catch (error) {
			logService.error(`keybindings.json could not be read: ${(error as Error).message}`);
		}
	};
	await loadUserKeybindings();
	watchSettingsFile(fileService, URI.file(keybindingsPath), () => void loadUserKeybindings(), logService);

	// chord-pending indicator on the status bar
	const updateChordIndicator = (): void => {
		workbench.layout.statusbar.removeEntry('chord');
		const label = keybindingService.pendingChordLabel;
		if (label) {
			workbench.layout.statusbar.addEntry('chord', {
				text: `(${label}) was pressed, waiting for second key…`,
				alignment: StatusbarAlignment.RIGHT,
				priority: 5
			});
		}
	};
	keybindingService.onDidChangeChordState(updateChordIndicator);

	// ---- the editor service (exercise 09): groups, tabs, dirty lifecycle and the model
	// registry. The widget (08) now lives inside panes, one per group showing an input.
	const editorService = new EditorService(workbench.layout.editor, codeEditorService, fileService, logService, {
		options: editorOptions,
		configuration: configurationService,
		contextKeyService,
		codeEditorService
	});
	workbench.layout.editor.onDidRequestCloseEditor(({ input, group }) => {
		void editorService.closeEditor(input, group);
	});

	const getActiveWidget = () => {
		const pane = workbench.layout.editor.activeGroup.activePane;
		return pane instanceof TextEditorPane ? pane.getWidget() : null;
	};

	registerEditorCommands(getActiveWidget);
	registerEditorActions(editorService, workbench.layout.editor, fileService, userDataPath);
	registerConfigurationActions(configurationService.getSettingsPath(), fsPath => {
		void editorService.openEditor({ resource: URI.file(fsPath) });
	});
	keybindingService.rebuild();

	// render stats in the status bar (the 100k-line gate reads this)
	let lastPerfText = '';
	window.setInterval(() => {
		const stats = getActiveWidget()?.getPerfStats();
		const text = stats
			? `render avg ${stats.averageRenderMs.toFixed(2)}ms · last ${stats.lastRenderMs.toFixed(2)}ms · ${stats.lastRenderedLines}/${stats.totalLines} lines`
			: 'editor: empty group';
		if (text !== lastPerfText) {
			lastPerfText = text;
			workbench.layout.statusbar.removeEntry('debug.editor');
			workbench.layout.statusbar.addEntry('debug.editor', {
				text,
				alignment: StatusbarAlignment.RIGHT,
				priority: 59
			});
		}
	}, 500);

	// ---- first real open paths (exercise 09): CLI argv seed, and the veto-able window close
	const openedFile = await windowChannel.getOpenedFile();
	if (openedFile) {
		await editorService.openEditor({ resource: URI.file(openedFile) });
		logService.info(`opened file from argv: ${openedFile}`);
	} else {
		logService.info('no file on argv — the editor part starts with its watermark');
	}

	windowChannel.onWillCloseWindow(() => {
		void (async () => {
			const proceed = await editorService.confirmCloseAllDirty();
			await windowChannel.resolveClose(proceed);
		})();
	});

	// ---- the file stack consumers (exercise 10): explorer, workspace, external changes
	const sidebarContainer = workbench.layout.sidebar.getContentContainer();
	if (!sidebarContainer) {
		throw new Error('the sidebar has no content container');
	}
	const explorerView = new ExplorerView(sidebarContainer, { commandService, contextKeyService });
	const explorerService = new ExplorerService(explorerView.treeContainer, {
		fileService,
		editorService,
		logService,
		commandService
	});
	explorerView.attach(explorerService);
	const workspaceContext = new WorkspaceContextService();

	const updateWorkspaceUi = (): void => {
		const folder = workspaceContext.folder;
		workbench.layout.sidebar.setTitle(folder ? `EXPLORER: ${folder.name.toUpperCase()}` : 'EXPLORER');
		workbench.layout.statusbar.removeEntry('workspace');
		if (folder) {
			workbench.layout.statusbar.addEntry('workspace', {
				text: folder.name,
				alignment: StatusbarAlignment.LEFT,
				priority: 1,
				title: folder.uri.fsPath
			});
		}
	};

	const setFolder = async (uri: URI | undefined): Promise<void> => {
		await explorerService.setFolder(uri);
		workspaceContext.setFolder(uri);
		// the workspace settings layer: DEFAULT < USER < WORKSPACE (task 9)
		configurationService.setWorkspaceSettingsPath(uri ? workspaceSettingsUri(createWorkspaceFolder(uri)).fsPath : null);
		await configurationService.load();
		storage.store('workbench.workspace.folder', uri?.fsPath ?? null, StorageScope.APPLICATION);
		updateWorkspaceUi();
	};

	const openFolder = async (): Promise<void> => {
		const picked = await windowChannel.showOpenFolderDialog({ title: 'Open Folder' });
		if (picked) {
			await setFolder(URI.file(picked));
		}
	};
	const closeFolder = async (): Promise<void> => {
		await setFolder(undefined);
	};

	registerFileCommands({
		explorerService,
		editorService,
		commandService,
		contextKeyService,
		configuration: configurationService,
		logService,
		openFolder,
		closeFolder
	});

	// the activity bar's Explorer icon: show the sidebar and FOCUS the tree (real behavior —
	// collapsing lives on the toggle command, 03)
	CommandsRegistry.registerCommand(EXPLORER_ID, () => {
		if (!workbench.layout.sidebar.visible) {
			workbench.layout.setSidebarVisible(true);
		}
		explorerService.tree.focus();
	});
	CommandMetadata.register({ id: EXPLORER_ID, title: 'Show Explorer', category: 'View' });
	keybindingService.rebuild();

	// the watcher fan-out: the explorer refreshes, editors reload/mark-deleted, and the
	// workspace settings file feeds the configuration layer live (10)
	fileService.onDidFilesChange(event => {
		explorerService.handleFileChanges(event);
		editorService.handleFileChanges(event);
		const folder = workspaceContext.folder;
		if (folder && event.contains(workspaceSettingsUri(folder))) {
			void configurationService.reload();
		}
	});

	// the file-changed warning (status bar; 11 turns it into a toast). Click = reload (discarding
	// the buffer after a confirmation — the real workbench keeps your version and offers compare)
	editorService.onDidInputNeedsAttention(({ input }) => {
		workbench.layout.statusbar.addEntry('file.warning', {
			text: `'${input.getName()}' was changed on disk`,
			alignment: StatusbarAlignment.RIGHT,
			priority: 40,
			title: 'Click to reload (discards unsaved changes)',
			onClick: () => {
				void (async () => {
					const result = await confirmDialog({
						message: `'${input.getName()}' has unsaved changes and was changed on disk. Reload and discard your changes?`,
						primaryLabel: 'Reload',
						secondaryLabel: null
					});
					if (result === 'primary' && input instanceof TextEditorInput) {
						workbench.layout.statusbar.removeEntry('file.warning');
						await editorService.forceReload(input);
					}
				})();
			}
		});
	});

	// restore the last workspace folder (storage; the real one is workspace storage keyed by hash)
	const storedFolder = storage.get('workbench.workspace.folder', StorageScope.APPLICATION);
	if (typeof storedFolder === 'string' && storedFolder.length > 0) {
		if (await fileService.exists(URI.file(storedFolder))) {
			await setFolder(URI.file(storedFolder));
		} else {
			// the kill-test path: the folder vanished while we were away — log, stay empty
			logService.warn(`the last workspace folder is gone: ${storedFolder}`);
		}
	}
	updateWorkspaceUi();

	// ---- the extension system (exercise 11): scan → contributions → the host process
	const languageService = new LanguageService(logService);
	const notifications = new NotificationService();
	const extensionService = new ExtensionService(logService);
	const mainThreadServiceHost = {
		logService,
		commandService,
		configurationService,
		notifications,
		statusbar: workbench.layout.statusbar,
		languageService,
		codeEditorService,
		editorService,
		editorPart: workbench.layout.editor,
		getExtensionService: () => extensionService
	};
	const documentMirror = new WorkbenchDocuments(mainThreadServiceHost);
	let hostManagerRef: ExtensionHostManager | undefined;
	const hostManager = new ExtensionHostManager(windowChannel, server => {
		// the host's calls land in these MainThreadX services once the port exists
		registerAllMainThreadServices(server, mainThreadServiceHost, documentMirror, hostManagerRef!);
	});
	hostManagerRef = hostManager;
	hostManager.onDidExit(code => {
		logService.error(`the extension host exited (code ${code ?? 'unknown'})`);
		extensionService.setHostUnavailable();
	});
	// the reference's "Extension activation failed" notification; the log line is already there
	extensionService.onDidFailActivation(({ identifier, error }) => {
		void notifications.show({ severity: 'error', message: `Extension '${identifier}' activation failed: ${error}` });
	});

	const scanResult = (await windowChannel.scanExtensions()) as IExtensionScanResult;
	logService.info(`extension scan: ${scanResult.extensions.length} found, ${scanResult.errors.length} skipped`);
	const windowInfo = await windowChannel.getInfo();
	await extensionService.initialize({
		scanned: scanResult.extensions,
		host: hostManager,
		registerContributions: scanned => registerExtensionContributions(scanned, { extensionService, languageService, logService }),
		initData: {
			extensions: scanResult.extensions.map(entry => entry.description),
			userDataPath,
			logLevel: 'info',
			env: { appName: 'mini-vscode', appVersion: windowInfo.appVersion }
		}
	});

	// 04's CommandService gets the activation seam (the TODO in its source is gone)
	commandService.setActivationHook(id => extensionService.activateByEvent(`onCommand:${id}`));

	// live configuration → the host's mirror (the reference pushes per-key; we re-snapshot)
	configurationService.onDidChangeConfiguration(event => {
		documentMirror.pushConfiguration(snapshotConfiguration(configurationService), event.change.keys);
	});

	// Developer: Reload Window — terminate the host cleanly FIRST, then reload (the acceptance
	// checks `ps` for leaks across five reloads)
	CommandsRegistry.registerCommand('workbench.action.reloadWindow', async () => {
		await extensionService.shutdown();
		await windowChannel.reloadWindow();
	});
	CommandMetadata.register({ id: 'workbench.action.reloadWindow', title: 'Developer: Reload Window', category: 'Developer' });
	keybindingService.rebuild();

	// `onStartupFinished`: after the first render pass (a rAF), like the reference's startup event
	await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
	void extensionService.activateStartupFinished();

	// ---- debug readout: proves settings live reload until 08/10 replace it with real consumers
	// shortcut: temporary; dies when editor/sidebar read these settings for real
	const updateConfigDebug = (): void => {
		const fontSize = configurationService.getValue<number>('editor.fontSize');
		const theme = configurationService.getValue<string>('workbench.colorTheme');
		workbench.layout.statusbar.removeEntry('debug.config');
		workbench.layout.statusbar.addEntry('debug.config', {
			text: `fontSize: ${fontSize} · theme: ${theme}`,
			alignment: StatusbarAlignment.RIGHT,
			priority: 60
		});
	};
	configurationService.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('editor.fontSize') || event.affectsConfiguration('workbench.colorTheme')) {
			updateConfigDebug();
		}
	});
	updateConfigDebug();

	// ---- dev hook for the acceptance checks: drive commands, keybindings and services
	const devEditor = {
		/** 09: the widget is whoever the active group shows (08's hook shape kept working) */
		get widget() {
			return getActiveWidget();
		},
		type: (text: string) => getActiveWidget()?.type(text),
		insertText: (text: string) => getActiveWidget()?.type(text),
		undo: () => getActiveWidget()?.undo(),
		redo: () => getActiveWidget()?.redo(),
		getValue: () => getActiveWidget()?.getModel()?.getValue() ?? '',
		getSelection: () => {
			const widget = getActiveWidget();
			if (!widget) {
				return null;
			}
			const selection = widget.getSelection();
			return {
				anchor: { lineNumber: selection.anchorLineNumber, column: selection.anchorColumn },
				active: { lineNumber: selection.activeLineNumber, column: selection.activeColumn },
				isEmpty: selection.isEmpty()
			};
		},
		setSelectionByPositions: (anchorLineNumber: number, anchorColumn: number, activeLineNumber: number, activeColumn: number) =>
			getActiveWidget()?.setSelection(new Selection(anchorLineNumber, anchorColumn, activeLineNumber, activeColumn)),
		getPerfStats: () => getActiveWidget()?.getPerfStats() ?? null,
		renderNow: () => getActiveWidget()?.view.render(),
		openDemoFile: () => {
			const resource = URI.joinPath(URI.file(userDataPath), 'demo-welcome.ts');
			codeEditorService.createModel(resource, WELCOME_TEXT);
			const opening = editorService.openEditor({ resource });
			return opening;
		},
		openPerformanceFile: (lineCount: number = 100000) => {
			return (async () => {
				const resource = URI.joinPath(URI.file(userDataPath), `perf-${lineCount}.ts`);
				const started = performance.now();
				codeEditorService.createModel(resource, generateLargeText(lineCount));
				await editorService.openEditor({ resource });
				getActiveWidget()?.view.render();
				return {
					openMs: performance.now() - started,
					stats: getActiveWidget()?.getPerfStats() ?? null
				};
			})();
		}
	};

	const devEditors = {
		openFile: (fsPath: string, selection?: { lineNumber: number; column: number }) =>
			editorService.openEditor({ resource: URI.file(fsPath), options: selection ? { selection } : undefined }),
		closeActive: () => {
			const input = editorService.activeInput;
			return input ? editorService.closeEditor(input, workbench.layout.editor.activeGroup) : Promise.resolve(false);
		},
		closeInput: (fsPath: string) => {
			const input = editorService.getInput(URI.file(fsPath));
			return input ? editorService.closeEditor(input) : Promise.resolve(false);
		},
		split: () => editorService.splitEditor(),
		saveActive: () => editorService.saveActive(),
		requestCloseWindow: () => windowChannel.requestCloseWindow(),
		getState: () => editorService.getState(),
		getActiveResource: () => editorService.activeInput?.getResource()?.fsPath ?? null,
		isActiveDirty: () => editorService.activeInput?.isDirty() ?? false,
		getDirtyNames: () => editorService.getDirtyInputs().map(input => input.getName()),
		getModelCount: () => codeEditorService.modelCount(),
		getRefCount: (fsPath: string) => codeEditorService.refCount(URI.file(fsPath)),
		/** per group: the active pane's widget state (scroll + selection) */
		getPaneState: () => workbench.layout.editor.groups.map(group => {
			const pane = group.activePane;
			if (pane instanceof TextEditorPane) {
				const widget = pane.getWidget();
				const selection = widget.getSelection();
				return {
					group: group.id,
					active: group === workbench.layout.editor.activeGroup,
					name: group.activeEditor?.getName() ?? null,
					scrollTop: widget.view.getScrollTop(),
					selection: { lineNumber: selection.activeLineNumber, column: selection.activeColumn },
					selectionEmpty: selection.isEmpty()
				};
			}
			return { group: group.id, active: group === workbench.layout.editor.activeGroup, name: group.activeEditor?.getName() ?? null, scrollTop: -1, selection: null, selectionEmpty: true };
		}),
		selectTab: (groupIndex: number, tabIndex: number) => {
			const group = workbench.layout.editor.groups[groupIndex];
			const input = group?.editors[tabIndex];
			if (group && input) {
				group.setActive(input, { focus: true });
			}
		},
		getDialogState: () => {
			const dialog = document.querySelector('.confirm-dialog');
			if (!dialog) {
				return null;
			}
			const focused = document.activeElement as HTMLElement | null;
			return {
				message: dialog.querySelector('.confirm-dialog-message')?.textContent ?? '',
				buttons: [...dialog.querySelectorAll('.confirm-dialog-button')].map(button => (button as HTMLElement).textContent),
				focused: focused?.textContent ?? null
			};
		},
		/** raw widget of a group's active pane (view-state assertions) */
		getWidget: (groupIndex: number) => {
			const pane = workbench.layout.editor.groups[groupIndex]?.activePane;
			return pane instanceof TextEditorPane ? pane.getWidget() : null;
		},
		clickDialogButton: (label: string) => {
			const buttons = [...document.querySelectorAll('.confirm-dialog-button')] as HTMLElement[];
			const button = buttons.find(candidate => candidate.textContent === label);
			button?.click();
			return !!button;
		},
		pressDialogEscape: () => {
			const dialog = document.querySelector('.confirm-dialog');
			dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		}
	};

	(window as any).__miniDev = {
		executeCommand: (id: string, ...args: unknown[]) => commandService.executeCommand(id, ...args),
		contextKeyService,
		configurationService,
		storage,
		deserializeWhen: (when: string) => ContextKeyExpr.deserialize(when),
		keybindings: {
			register: (rule: unknown) => {
				const disposable = KeybindingsRegistry.registerKeybindingRule(rule as never);
				keybindingService.rebuild();
				return disposable;
			},
			reloadUserBindings: loadUserKeybindings
		},
		editor: devEditor,
		editors: devEditors,
		extensions: {
			getScanSummary: () => ({
				found: scanResult.extensions.length,
				errors: scanResult.errors.length,
				ids: scanResult.extensions.map(entry => entry.description.identifier)
			}),
			getStates: () => extensionService.getActivationRecords(),
			isHostAlive: () => hostManager.isAlive,
			getToastCount: () => notifications.visibleCount,
			isCommandInPalette: (id: string) => !!CommandMetadata.get(id),
			reloadWindow: () => commandService.executeCommand('workbench.action.reloadWindow'),
			activateStartupFinished: () => extensionService.activateStartupFinished()
		},
		files: {
			openFolder: (fsPath: string) => setFolder(URI.file(fsPath)),
			closeFolder: () => closeFolder(),
			getFolder: () => workspaceContext.folder?.uri.fsPath ?? null,
			getRefreshCount: () => explorerService.refreshCount,
			/** rows with depth/selection/expansion, as the acceptance reads them */
			getTreeState: () => {
				const rows: { name: string; depth: number; isDirectory: boolean; expanded: boolean; selected: boolean }[] = [];
				const walk = (node: import('./workbench/contrib/files/browser/tree/explorerTree.js').IExplorerNode | null, depth: number): void => {
					if (!node) {
						return;
					}
					rows.push({
						name: node.name,
						depth,
						isDirectory: node.isDirectory,
						expanded: node.expanded,
						selected: explorerService.selection === node
					});
					if (node.isDirectory && node.expanded) {
						for (const child of node.children ?? []) {
							walk(child, depth + 1);
						}
					}
				};
				walk(explorerService.root, 0);
				return rows;
			},
			selectByName: (name: string) => {
				const find = (node: import('./workbench/contrib/files/browser/tree/explorerTree.js').IExplorerNode | null): import('./workbench/contrib/files/browser/tree/explorerTree.js').IExplorerNode | null => {
					if (!node) {
						return null;
					}
					if (node.name === name) {
						return node;
					}
					for (const child of node.children ?? []) {
						const found = find(child);
						if (found) {
							return found;
						}
					}
					return null;
				};
				const node = find(explorerService.root);
				if (node) {
					// the acceptance drives keyboard commands: focus follows the selection
					explorerService.tree.focus();
					explorerService.tree.setSelection(node);
				}
				return !!node;
			},
			getInlineInputValue: () => document.querySelector('input.inline-input-box') instanceof HTMLInputElement ? (document.querySelector('input.inline-input-box') as HTMLInputElement).value : null,
			isInlineInputOpen: () => !!document.querySelector('.inline-input-widget'),
			getInlineInputMessage: () => document.querySelector('.inline-input-message')?.textContent ?? null
		}
	};

	logService.info('workbench created');
}

void main();
