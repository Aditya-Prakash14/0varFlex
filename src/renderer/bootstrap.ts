import { ProxyChannel } from '../common/base/parts/ipc/ipc.js';
import { URI } from '../common/base/common/uri.js';
import { TextModel } from '../common/editor/common/model/textModel.js';
import { InstantiationService } from '../common/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../common/platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from '../common/platform/instantiation/common/descriptors.js';
import { ILogService } from '../common/platform/log/common/log.js';
import { LogService } from '../common/platform/log/common/logService.js';
import { ILogChannel } from '../common/platform/log/common/logIpc.js';
import { FileIOChannelClient } from '../common/platform/fileIO/common/fileIO.js';
import { IWindowChannel } from '../common/platform/window/common/window.js';
import { ConfigurationService } from '../common/platform/configuration/common/configurationService.js';
import { IStorageService, StorageScope, WillSaveStateReason } from '../common/platform/storage/common/storage.js';
import { BrowserStorageService } from '../common/platform/storage/common/storageService.js';
import { addDisposableListener } from './base/browser/dom.js';
import { EditorOptionsService } from './editor/browser/config.js';
import { Selection } from './editor/browser/core/selection.js';
import { EditorWidget, registerEditorCommands } from './editor/browser/editorWidget.js';
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
import { registerConfigurationActions } from './workbench/contrib/configuration/browser/configurationActions.js';
import { registerDefaultConfigurations } from './workbench/contrib/configuration/browser/defaultSettings.js';
import { registerLayoutCommands, SHOW_ALL_COMMANDS_ID } from './workbench/contrib/layout/browser/layoutActions.js';
import { CommandService } from './workbench/services/commands/common/commandService.js';
import { MainProcessChannelClient } from './parts/ipc/ipcRenderer.js';

// shortcut: watch-lite (fs.watchFile polling from 02) — a real FileWatcher interface arrives in 10
function watchFile(fileIO: FileIOChannelClient, path: string, callback: () => void): void {
	let timer: number | undefined;
	fileIO.onDidChangeFile(path)(() => {
		if (timer !== undefined) {
			window.clearTimeout(timer);
		}
		timer = window.setTimeout(() => {
			timer = undefined;
			callback();
		}, 200);
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
async function migrateLegacyState(fileIO: FileIOChannelClient, storage: IStorageService, userDataPath: string, logService: ILogService): Promise<void> {
	const legacyPath = URI.joinPath(URI.file(userDataPath), 'state.json').fsPath;
	const raw = await fileIO.readTextFile(legacyPath);
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
		await fileIO.deleteFile(legacyPath);
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
	const fileIO = new FileIOChannelClient(channelClient.getChannel('fileIO'));

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

	const userDataPath = await fileIO.getUserDataPath();
	const settingsPath = URI.joinPath(URI.file(userDataPath), 'User', 'settings.json').fsPath;
	const configurationService = new ConfigurationService(settingsPath, fileIO, logService);
	await configurationService.load();
	watchFile(fileIO, settingsPath, () => void configurationService.reload());

	// ---- storage (exercise 06): main-backed files, sync renderer cache
	const storage = new BrowserStorageService(channelClient.getChannel('storage'), logService);
	await storage.initialize(StorageScope.APPLICATION);
	await storage.initialize(StorageScope.WORKSPACE);
	await migrateLegacyState(fileIO, storage, userDataPath, logService);

	// writes are debounced; on quit and on focus loss the state gets its final flush
	addDisposableListener(window, 'beforeunload', () => { void storage.flush(WillSaveStateReason.Shutdown); });
	windowChannel.onDidChangeFocus(focused => { if (!focused) { void storage.flush(); } });

	// ---- the workbench (exercise 03)
	const workbench = new Workbench(document.body, {
		logService,
		storage,
		configuration: configurationService,
		contextKeyService,
		commandService,
		windowChannel
	});
	await workbench.start();

	// ---- layout + configuration commands (04/06)
	registerLayoutCommands(workbench.layout, windowChannel);
	registerConfigurationActions(configurationService.getSettingsPath(), windowChannel);

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
			const text = await fileIO.readTextFile(keybindingsPath);
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
	watchFile(fileIO, keybindingsPath, () => void loadUserKeybindings());

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

	// ---- the editor widget (exercise 08): one widget in the editor part, demo document open
	const editorOptions = new EditorOptionsService(configurationService);
	const editorContainer = workbench.layout.editor.getContentContainer();
	let editor: EditorWidget | null = null;
	if (editorContainer) {
		editor = new EditorWidget(editorContainer, {
			options: editorOptions,
			configuration: configurationService,
			contextKeyService
		});
		editor.setModel(new TextModel(WELCOME_TEXT));
		registerEditorCommands(editor);
		keybindingService.rebuild();
		editor.focus();

		// render stats in the status bar (the 100k-line gate reads this)
		let lastPerfText = '';
		window.setInterval(() => {
			const stats = editor!.getPerfStats();
			const text = `render avg ${stats.averageRenderMs.toFixed(2)}ms · last ${stats.lastRenderMs.toFixed(2)}ms · ${stats.lastRenderedLines}/${stats.totalLines} lines`;
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
	}

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
		editor: editor ? {
			widget: editor,
			type: (text: string) => editor!.type(text),
			insertText: (text: string) => editor!.type(text),
			undo: () => editor!.undo(),
			redo: () => editor!.redo(),
			getValue: () => editor!.getModel()?.getValue() ?? '',
			getSelection: () => {
				const selection = editor!.getSelection();
				return {
					anchor: { lineNumber: selection.anchorLineNumber, column: selection.anchorColumn },
					active: { lineNumber: selection.activeLineNumber, column: selection.activeColumn },
					isEmpty: selection.isEmpty()
				};
			},
			setSelectionByPositions: (anchorLineNumber: number, anchorColumn: number, activeLineNumber: number, activeColumn: number) =>
				editor!.setSelection(new Selection(anchorLineNumber, anchorColumn, activeLineNumber, activeColumn)),
			getPerfStats: () => editor!.getPerfStats(),
			renderNow: () => editor!.view.render(),
			openPerformanceFile: (lineCount: number = 100000) => {
				const started = performance.now();
				editor!.setModel(new TextModel(generateLargeText(lineCount)));
				editor!.view.render();
				return {
					openMs: performance.now() - started,
					stats: editor!.getPerfStats()
				};
			},
			openDemoFile: () => {
				editor!.setModel(new TextModel(WELCOME_TEXT));
				editor!.view.render();
			}
		} : null
	};

	logService.info('workbench created');
}

void main();
