import { InstantiationService } from './platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from './platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from './platform/instantiation/common/descriptors.js';
import { ILogService } from './platform/log/common/log.js';
import { LogService } from './platform/log/common/logService.js';

async function main(): Promise<void> {
	const appElement = document.getElementById('app')!;

	// the app's first container: one service, created lazily on first use
	const services = new ServiceCollection([ILogService, new SyncDescriptor(LogService)]);
	const instantiationService = new InstantiationService(services);

	const start = performance.now();
	const result = await window.host.ping('hello from the renderer');
	const ms = (performance.now() - start).toFixed(1);

	instantiationService.invokeFunction(accessor => {
		accessor.get(ILogService).info(`ping result: ${JSON.stringify(result)} in ${ms}ms`);
	});

	appElement.textContent = `renderer ready — main replied in ${ms}ms`;
}

void main();
