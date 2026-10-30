// src/common/platform/window/common/window.ts — the window channel: info and focus events.

import { Event } from '../../../base/common/event.js';

export interface IWindowInfo {
	readonly id: number;
	readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	readonly focused: boolean;
}

export interface IWindowChannel {
	getInfo(): Promise<IWindowInfo>;
	// the "onSomething" naming convention is what ProxyChannel recognizes as an event
	onDidChangeFocus: Event<boolean>;
}
