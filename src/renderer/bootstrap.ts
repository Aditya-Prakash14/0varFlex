import { ProxyChannel } from '../common/base/parts/ipc/ipc.js';
import { InstantiationService } from '../common/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../common/platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from '../common/platform/instantiation/common/descriptors.js';
import { ILogService } from '../common/platform/log/common/log.js';
import { LogService } from '../common/platform/log/common/logService.js';
import { ILogChannel } from '../common/platform/log/common/logIpc.js';
import { FileIOChannelClient } from '../common/platform/fileIO/common/fileIO.js';
import { IWindowChannel } from '../common/platform/window/common/window.js';
import { Workbench } from './workbench/browser/workbench.js';
import { MainProcessChannelClient } from './parts/ipc/ipcRenderer.js';

async function main(): Promise<void> {
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

	// the exercise-00 boot line, now just a log line
	const start = performance.now();
	const result = await window.host.ping('hello from the renderer');
	const ms = (performance.now() - start).toFixed(1);
	logService.info(`ping result: ${JSON.stringify(result)} in ${ms}ms`);

	// main → renderer events: focus changes (exercise 02's evidence, still useful)
	windowChannel.onDidChangeFocus(focused => logService.info(`window focus: ${focused}`));

	// ---- the workbench
	const workbench = new Workbench(document.body, { logService, fileIO, windowChannel });
	await workbench.start();
	logService.info('workbench created');
}

void main();
