// extensions/toy-debug/src/extension.ts — the debug adapter contribution.
//
// All this extension does is tell the workbench HOW to launch an adapter for type 'toy'. The
// workbench ships a DAP client and knows nothing about this debugger; remove the folder and
// debugging disappears while the workbench still compiles. That is the A2-2 claim.

import * as path from 'path';
import * as vscode from 'vscode';

export function activate(context: {
	extensionPath: string;
	subscriptions: { dispose(): void }[];
}): void {
	const adapterPath = path.join(context.extensionPath, 'out', 'adapter.js');

	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('toy', {
		createDebugAdapterDescriptor() {
			// a separate process, like every real adapter
			return { command: process.execPath, args: [adapterPath] };
		}
	}));

	console.log(`toy-debug: adapter factory registered (${adapterPath})`);
}

export function deactivate(): void {
	// the factory registration is disposed by the host
}
