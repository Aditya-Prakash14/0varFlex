// extHost — the `vscode` module the host patches in (see src/extHost/main.ts). This file is
// type-checked against the api factory's shape; a real .d.ts arrives if the samples grow.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vscode = require('vscode');

export function activate(context: { subscriptions: { dispose(): void }[] }): void {
	console.log('hello: activate() ran');

	context.subscriptions.push(vscode.commands.registerCommand('hello.sayHello', async () => {
		const answer = await vscode.window.showInformationMessage('Hello from hello!', 'Nice', 'Meh');
		// the acceptance greps this line: the user's answer travelled host → renderer → host
		console.log(`hello: the user chose: ${answer}`);
	}));
}

export function deactivate(): void {
	console.log('hello: deactivate() ran');
}
