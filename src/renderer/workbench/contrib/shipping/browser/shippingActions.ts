// src/renderer/workbench/contrib/shipping/browser/shippingActions.ts — the shipping surface
// (14): the About dialog command, the shell-command install action (the real
// `workbench.action.installCommandLine`) and the update loop's UI.
//
// The real update UI badges the gear icon in the activity bar and shows a notification; ours is
// a status-bar entry (`⇧ restart to update`) plus the same notification flow — delta noted in
// the README. The state names come from the main-process service (the reference's state
// machine at 1%).

import { IDisposable, toDisposable } from '../../../../../common/base/common/lifecycle.js';
import { CommandsRegistry, CommandMetadata } from '../../../../platform/commands/common/commands.js';
import { StatusbarAlignment, StatusbarPart } from '../../../browser/parts/statusbar/statusbarPart.js';
import type { NotificationService } from '../../../services/notifications/browser/notificationService.js';
import type { IUpdateStateDto, IWindowChannel } from '../../../../../common/platform/window/common/window.js';
import { showAboutDialog } from './aboutDialog.js';

const UPDATE_ENTRY_ID = 'status.update';

export function registerShippingActions(
	windowChannel: IWindowChannel,
	notifications: NotificationService,
	statusbar: StatusbarPart
): IDisposable {
	const disposables: IDisposable[] = [];

	const register = (id: string, title: string, run: () => void | Promise<void>): void => {
		disposables.push(CommandsRegistry.registerCommand(id, () => run()));
		disposables.push(CommandMetadata.register({ id, title, category: 'Help' }));
	};

	// ---- About (the real id) -------------------------------------------------------------

	register('workbench.action.showAboutDialog', 'About', async () => {
		await showAboutDialog(await windowChannel.getVersionInfo(), text => windowChannel.writeClipboardText(text));
	});

	// ---- Shell Command: Install 'mini' command in PATH (the real id) -----------------------

	register('workbench.action.installCommandLine', `Install 'mini' command in PATH`, async () => {
		const result = await windowChannel.installShellCommand();
		if (result.ok) {
			// the real success text: "Shell command '<name>' successfully installed in PATH."
			void notifications.show({ severity: 'info', message: `Shell command 'mini' successfully installed in PATH (${result.target}).` });
		} else {
			void notifications.show({ severity: 'error', message: `Failed to install the 'mini' command: ${result.error}` });
		}
	});

	// ---- the update loop -------------------------------------------------------------------

	let currentState: IUpdateStateDto = { type: 'uninitialized' };

	const renderStatusEntry = (state: IUpdateStateDto): void => {
		statusbar.removeEntry(UPDATE_ENTRY_ID);
		if (state.type === 'ready' && state.version) {
			statusbar.addEntry(UPDATE_ENTRY_ID, {
				text: `⇧ restart to update (v${state.version})`,
				title: 'Restart to apply the downloaded update',
				alignment: StatusbarAlignment.RIGHT,
				priority: 70,
				onClick: () => void windowChannel.restartToUpdate()
			});
		} else if (state.type === 'downloading' || state.type === 'available') {
			statusbar.addEntry(UPDATE_ENTRY_ID, {
				text: `⇧ update v${state.version ?? ''}…`,
				title: 'An update is being downloaded',
				alignment: StatusbarAlignment.RIGHT,
				priority: 70
			});
		} else if (state.type === 'updating') {
			statusbar.addEntry(UPDATE_ENTRY_ID, {
				text: '⇧ restarting…',
				alignment: StatusbarAlignment.RIGHT,
				priority: 70
			});
		}
	};

	windowChannel.onDidChangeUpdateState(state => {
		const previous = currentState;
		currentState = state;
		renderStatusEntry(state);
		// the notification flow: available → a toast; downloaded → "Restart to Update"
		if (state.type === 'available' && previous.type !== 'available') {
			void notifications.show({ severity: 'info', message: `Update available: v${state.version}` });
		}
		if (state.type === 'ready' && previous.type !== 'ready') {
			void notifications.show({
				severity: 'info',
				message: `Update downloaded: v${state.version}`,
				items: ['Restart to Update']
			}).then(answer => {
				if (answer === 'Restart to Update') {
					void windowChannel.restartToUpdate();
				}
			});
		}
	});

	register('workbench.action.checkForUpdates', 'Check for Updates', async () => {
		const state = await windowChannel.checkForUpdates(true);
		if (state.type === 'ready') {
			void notifications.show({
				severity: 'info',
				message: `Update ready: v${state.version}`,
				items: ['Restart to Update']
			}).then(answer => {
				if (answer === 'Restart to Update') {
					void windowChannel.restartToUpdate();
				}
			});
			return;
		}
		if (state.type === 'checking' || state.type === 'available' || state.type === 'downloading') {
			return; // the state events drive the UI from here
		}
		if (state.error) {
			void notifications.show({ severity: 'warning', message: `Update check failed: ${state.error}` });
		} else {
			void notifications.show({ severity: 'info', message: 'No updates available.' });
		}
	});

	register('workbench.action.restartToUpdate', 'Restart to Update', () => windowChannel.restartToUpdate());

	// the initial state (a renderer reload re-reads what main already knows)
	void windowChannel.getUpdateState().then(state => {
		currentState = state;
		renderStatusEntry(state);
	});

	return toDisposable(() => {
		for (const disposable of disposables) {
			disposable.dispose();
		}
		statusbar.removeEntry(UPDATE_ENTRY_ID);
	});
}
