// scripts/test.mjs — bundles the TypeScript tests with esbuild, then runs them on node's built-in test runner.
import * as esbuild from 'esbuild';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.test-out');

await rm(out, { recursive: true, force: true });

const testFiles = (await readdir(path.join(root, 'tests'))).filter(f => f.endsWith('.test.ts'));
await esbuild.build({
	absWorkingDir: root,
	entryPoints: testFiles.map(f => path.join('tests', f)),
	outdir: out,
	platform: 'node',
	format: 'esm',
	bundle: true,
	sourcemap: true,
	// jsonc-parser's UMD entry uses dynamic require; point at its ESM build
	alias: { 'jsonc-parser': path.join(root, 'node_modules/jsonc-parser/lib/esm/main.js') },
	// tests run on plain node, so electron must not be bundled: its entry point uses a dynamic
	// require that an ESM bundle cannot express. Left external it resolves at runtime and only
	// fails if a test actually reaches into it, which is the behaviour we want — before this, a
	// module importing electron at all could not be tested, which is why the disk file provider
	// had no tests and a missing mkdir went unnoticed.
	external: ['electron'],
});

const outputs = testFiles.map(f => path.join(out, f.replace(/\.ts$/, '.js')));
const child = spawn(process.execPath, ['--enable-source-maps', '--test', ...outputs], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
