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
import { registerEditorCommands } from './editor/browser/editorWidget.js';
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
import { registerLayoutCommands, SHOW_ALL_COMMANDS_ID } from './workbench/contrib/layout/browser/layoutActions.js';
import { CommandService } from './workbench/services/commands/common/commandService.js';
import { CodeEditorService } from './workbench/services/editor/browser/codeEditorService.js';
import { EditorService } from './workbench/services/editor/browser/editorService.js';
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
		fileIO,
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

	// ---- the editor service (exercise 09): groups, tabs, dirty lifecycle and the model
	// registry. The widget (08) now lives inside panes, one per group showing an input.
	const editorService = new EditorService(workbench.layout.editor, codeEditorService, fileIO, logService, {
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
	registerEditorActions(editorService, workbench.layout.editor, fileIO, userDataPath);
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
		editors: devEditors
	};

	logService.info('workbench created');
}

void main();
