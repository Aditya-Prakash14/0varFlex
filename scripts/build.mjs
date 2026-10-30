// scripts/build.mjs — compiles our TypeScript into the out/ folder using esbuild.
import * as esbuild from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'out');
const watch = process.argv.includes('--watch');

// 1. make sure out/ exists, and copy the static html file into it
await mkdir(out, { recursive: true });
await cp(path.join(root, 'src/renderer/index.html'), path.join(out, 'index.html'));

// 2. three bundles: main process, preload, renderer
const bundles = [
	{ in: 'src/main/main.ts', out: 'main.js', platform: 'node', format: 'esm' },
	{ in: 'src/preload/preload.ts', out: 'preload.cjs', platform: 'node', format: 'cjs' },
	{ in: 'src/renderer/bootstrap.ts', out: 'renderer.js', platform: 'browser', format: 'esm' },
];

const configs = bundles.map(b => ({
	entryPoints: [path.join(root, b.in)],
	outfile: path.join(out, b.out),
	platform: b.platform,
	format: b.format,
	bundle: true,
	sourcemap: true,
	external: ['electron'],
}));

if (watch) {
	const contexts = await Promise.all(configs.map(c => esbuild.context(c)));
	await Promise.all(contexts.map(c => c.watch()));
	console.log('watching for changes — press Ctrl+C to stop');
} else {
	await Promise.all(configs.map(c => esbuild.build(c)));
	console.log('build done — output in out/');
}
