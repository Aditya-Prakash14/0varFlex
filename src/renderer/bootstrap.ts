import { ProxyChannel } from '../common/base/parts/ipc/ipc.js';
import { InstantiationService } from '../common/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../common/platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from '../common/platform/instantiation/common/descriptors.js';
import { ILogService } from '../common/platform/log/common/log.js';
import { LogService } from '../common/platform/log/common/logService.js';
import { ILogChannel } from '../common/platform/log/common/logIpc.js';
import { FileIOChannelClient } from '../common/platform/fileIO/common/fileIO.js';
import { IWindowChannel } from '../common/platform/window/common/window.js';
import { URI } from '../common/base/common/uri.js';
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
import { StateStore } from './workbench/browser/stateStore.js';
import { Workbench } from './workbench/browser/workbench.js';
import { StatusbarAlignment } from './workbench/browser/parts/statusbar/statusbarPart.js';
import { registerLayoutCommands, SHOW_ALL_COMMANDS_ID } from './workbench/contrib/layout/browser/layoutActions.js';
import { CommandService } from './workbench/services/commands/common/commandService.js';
import { MainProcessChannelClient } from './parts/ipc/ipcRenderer.js';

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

	// isFullscreen tracks the real window (menu, green button, toggle command)
	const isFullscreenContext = new RawContextKey<boolean>('isFullscreen', false).bindTo(contextKeyService);
	windowChannel.onDidChangeFullScreen(fullscreen => isFullscreenContext.set(fullscreen));
	void windowChannel.isFullScreen().then(fullscreen => isFullscreenContext.set(fullscreen)).catch(() => { /* window gone */ });

	// ---- the exercise-00 boot line, now just a log line
	const start = performance.now();
	const result = await window.host.ping('hello from the renderer');
	const ms = (performance.now() - start).toFixed(1);
	logService.info(`ping result: ${JSON.stringify(result)} in ${ms}ms`);

	// main → renderer events: focus changes (exercise 02's evidence, still useful)
	windowChannel.onDidChangeFocus(focused => logService.info(`window focus: ${focused}`));

	// ---- the workbench (exercise 03), state from the provisional store
	const stateStore = new StateStore(fileIO, logService);
	await stateStore.load();
	const workbench = new Workbench(document.body, { logService, stateStore, contextKeyService, commandService, windowChannel });
	await workbench.start();

	// ---- layout commands (exercise 04) + the command palette
	registerLayoutCommands(workbench.layout, windowChannel);

	const quickInput = new QuickInputController();
	const palette = new CommandsQuickAccessProvider(quickInput, commandService, contextKeyService, stateStore, logService);
	CommandsRegistry.registerCommand(SHOW_ALL_COMMANDS_ID, () => palette.pick());
	CommandMetadata.register({
		id: SHOW_ALL_COMMANDS_ID,
		title: 'Show All Commands',
		category: 'View'
	});
	// real binding from vs/workbench/browser/actions/quickAccessActions.ts: cmd+shift+p, F1 secondary
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

	// ---- keybindings (exercise 05)
	const os = getCurrentOS();
	const keybindingService = new KeybindingService(commandService, contextKeyService, logService, os);

	// chord test fixtures: cmd+k cmd+a / cmd+k cmd+b (no metadata → they stay out of the palette)
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

	// user overrides: keybindings.json in userData; watch-lite + reload (debounced), keep last
	// good state on parse errors
	const userDataPath = await fileIO.getUserDataPath();
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
	{
		let timer: number | undefined;
		fileIO.onDidChangeFile(keybindingsPath)(() => {
			if (timer !== undefined) {
				window.clearTimeout(timer);
			}
			timer = window.setTimeout(() => {
				timer = undefined;
				void loadUserKeybindings();
			}, 200);
		});
	}

	// chord-pending indicator on the status bar (stretch: real status bar entry styling)
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

	// dev probes for the context-gating acceptance (rules are registered at runtime); their
	// handlers log so the test can see which side of the gate matched
	CommandsRegistry.registerCommand('mini.probe.whenVisible', () => logService.info('gated probe fired: sidebarVisible'));
	CommandsRegistry.registerCommand('mini.probe.whenHidden', () => logService.info('gated probe fired: !sidebarVisible'));

	// ---- dev hook for the acceptance checks: drive commands and keybindings from the console
	(window as any).__miniDev = {
		executeCommand: (id: string, ...args: unknown[]) => commandService.executeCommand(id, ...args),
		contextKeyService,
		deserializeWhen: (when: string) => ContextKeyExpr.deserialize(when),
		keybindings: {
			register: (rule: unknown) => {
				const disposable = KeybindingsRegistry.registerKeybindingRule(rule as never);
				keybindingService.rebuild();
				return disposable;
			},
			reloadUserBindings: loadUserKeybindings
		}
	};

	logService.info('workbench created');
}

void main();
