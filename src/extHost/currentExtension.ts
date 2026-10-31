// src/extHost/currentExtension.ts — the console forwarder's attribution under BUNDLING: the
// reference walks the call stack, which only works because its host files exist on disk; our
// host is one bundle, so the extension service and the command dispatcher mark the extension
// they are running and the console patch reads that marker.

let currentExtensionId: string | undefined;

export function setCurrentExtension(id: string | undefined): void {
	currentExtensionId = id;
}

export function getCurrentExtension(): string | undefined {
	return currentExtensionId;
}
