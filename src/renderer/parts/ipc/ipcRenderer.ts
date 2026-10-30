// src/renderer/parts/ipc/ipcRenderer.ts — the renderer transport: window.host ↔ ChannelClient.

import { Emitter } from '../../../common/base/common/event.js';
import { ChannelClient, IMessagePassingProtocol } from '../../../common/base/parts/ipc/ipc.js';

// window.host is the frozen surface the preload exposes (see src/preload/preload.ts)
class RendererProtocol implements IMessagePassingProtocol {

	private readonly _onMessage = new Emitter<unknown>();
	readonly onMessage = this._onMessage.event;

	constructor() {
		window.host.ipc.onMessage(message => this._onMessage.fire(message));
	}

	send(message: unknown): void {
		try {
			window.host.ipc.send(message);
		} catch {
			// window is going down — nothing to do
		}
	}
}

export class MainProcessChannelClient extends ChannelClient {
	constructor() {
		super(new RendererProtocol());
	}
}
