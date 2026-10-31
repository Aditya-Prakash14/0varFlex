// scripts/build.mjs — compiles our TypeScript into the out/ folder using esbuild.
import * as esbuild from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'out');
const watch = process.argv.includes('--watch');

// 1. make sure out/ exists, and copy the static files into it
await mkdir(out, { recursive: true });
await cp(path.join(root, 'src/renderer/index.html'), path.join(out, 'index.html'));
await cp(path.join(root, 'src/renderer/workbench/media/workbench.css'), path.join(out, 'workbench.css'));

// 2. three bundles: main process, preload, renderer, plus the extension host and the samples
const bundles = [
	{ in: 'src/main/main.ts', out: 'main.js', platform: 'node', format: 'esm' },
	{ in: 'src/preload/preload.ts', out: 'preload.cjs', platform: 'node', format: 'cjs' },
	{ in: 'src/renderer/bootstrap.ts', out: 'renderer.js', platform: 'browser', format: 'esm' },
	// 11: the extension host runs as a utility process (CJS, like the reference's node host)
	{ in: 'src/extHost/main.ts', out: 'extHost.cjs', platform: 'node', format: 'cjs' },
	// 11: the sample extensions (the reference builds these with gulpfile.extensions.ts; 1% scale)
	{ in: 'extensions/hello/src/extension.ts', out: '../extensions/hello/out/extension.js', platform: 'node', format: 'cjs' },
	{ in: 'extensions/wordcount/src/extension.ts', out: '../extensions/wordcount/out/extension.js', platform: 'node', format: 'cjs' },
	// 12: the toy language — an extension with a client AND a separate server process
	{ in: 'extensions/toy-lang/client/src/extension.ts', out: '../extensions/toy-lang/out/extension.js', platform: 'node', format: 'cjs' },
	{ in: 'extensions/toy-lang/server/src/server.ts', out: '../extensions/toy-lang/out/server.js', platform: 'node', format: 'cjs' },
];

const configs = bundles.map(b => ({
	entryPoints: [path.join(root, b.in)],
	outfile: path.join(out, b.out),
	platform: b.platform,
	format: b.format,
	bundle: true,
	sourcemap: true,
	external: ['electron', 'vscode'],
	// jsonc-parser's UMD entry uses dynamic require; point at its ESM build
	alias: { 'jsonc-parser': path.join(root, 'node_modules/jsonc-parser/lib/esm/main.js') },
}));

if (watch) {
	const contexts = await Promise.all(configs.map(c => esbuild.context(c)));
	await Promise.all(contexts.map(c => c.watch()));
	console.log('watching for changes — press Ctrl+C to stop');
} else {
	await Promise.all(configs.map(c => esbuild.build(c)));
	console.log('build done — output in out/');
}
