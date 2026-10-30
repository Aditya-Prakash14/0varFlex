import { ProxyChannel } from '../common/base/parts/ipc/ipc.js';
import type { IDisposable } from '../common/base/common/lifecycle.js';
import { InstantiationService } from '../common/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../common/platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from '../common/platform/instantiation/common/descriptors.js';
import { ILogService } from '../common/platform/log/common/log.js';
import { LogService } from '../common/platform/log/common/logService.js';
import { ILogChannel } from '../common/platform/log/common/logIpc.js';
import { FileIOChannelClient } from '../common/platform/fileIO/common/fileIO.js';
import { IWindowChannel } from '../common/platform/window/common/window.js';
import { MainProcessChannelClient } from './parts/ipc/ipcRenderer.js';

async function main(): Promise<void> {
	const statusElement = document.getElementById('status')!;

	// ---- transport → channels → services (the exercise-02 shape)
	const channelClient = new MainProcessChannelClient();
	const logChannel = ProxyChannel.toService<ILogChannel>(channelClient.getChannel('log'));
	const windowChannel = ProxyChannel.toService<IWindowChannel>(channelClient.getChannel('window'));
	const fileIO = new FileIOChannelClient(channelClient.getChannel('fileIO'));

	const services = new ServiceCollection(
		[ILogService, new SyncDescriptor(LogService, [logChannel])],
	);
	const instantiationService = new InstantiationService(services);
	const logService = instantiationService.invokeFunction(accessor => accessor.get(ILogService));

	// ---- the exercise-00 boot line, unchanged
	const start = performance.now();
	const result = await window.host.ping('hello from the renderer');
	const ms = (performance.now() - start).toFixed(1);
	statusElement.textContent = `renderer ready — main replied in ${ms}ms`;
	logService.info(`ping result: ${JSON.stringify(result)} in ${ms}ms`);

	// ---- main → renderer events: focus changes
	windowChannel.onDidChangeFocus(focused => logService.info(`window focus: ${focused}`));

	// ---- dev hook (auto-runs once at boot, and on the button): the fileIO acceptance test
	const home = await fileIO.getHomePath();
	const testPath = `${home}/mini-vscode-ipc-test.txt`;
	let watchSubscription: IDisposable | undefined;

	async function runIpcDevChecks(): Promise<void> {
		try {
			const content = `written at ${new Date().toISOString()}`;
			await fileIO.writeTextFile(testPath, content);
			const readBack = await fileIO.readTextFile(testPath);
			logService.info(`fileIO round trip ${readBack === content ? 'ok' : 'MISMATCH'} (${testPath})`);

			// re-subscribing must not pile up watchers on the main side
			watchSubscription?.dispose();
			watchSubscription = fileIO.onDidChangeFile(testPath)(() => {
				logService.info(`fileIO change event for ${testPath}`);
			});

			// acceptance: an unknown command must reject with a clear message, not hang
			try {
				await channelClient.getChannel('log').call('doesNotExist');
				logService.warn('unknown command did NOT reject');
			} catch (error) {
				logService.info(`unknown command rejected with: ${(error as Error).message}`);
			}
		} catch (error) {
			logService.error(`ipc dev hook failed: ${(error as Error).message}`);
		}
	}

	document.getElementById('ipc-test')?.addEventListener('click', () => { void runIpcDevChecks(); });
	await runIpcDevChecks();

	logService.info('bootstrap complete');
}

void main();
