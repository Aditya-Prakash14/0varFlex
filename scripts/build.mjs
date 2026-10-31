// scripts/build.mjs — compiles our TypeScript into the out/ folder using esbuild.
//
//   node scripts/build.mjs               dev build (sourcemaps, no minify)
//   node scripts/build.mjs --production  dist build: minified, no sourcemaps, NODE_ENV, plus
//                                        the bundle-hygiene checks below (sizes + no
//                                        cross-entry imports) and a metafile for eyeballing
//
// One bundle PER ENTRY POINT (main, preload, renderer, ext host, pty host, samples): the sizes
// stay inspectable and nothing accidentally pulls the editor into the main process.
import * as esbuild from 'esbuild';
import { cp, mkdir, chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'out');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

// 1. make sure out/ exists, and copy the static files into it
await mkdir(out, { recursive: true });
await cp(path.join(root, 'src/renderer/index.html'), path.join(out, 'index.html'));
await cp(path.join(root, 'src/renderer/workbench/media/workbench.css'), path.join(out, 'workbench.css'));
await cp(path.join(root, 'node_modules/@xterm/xterm/css/xterm.css'), path.join(out, 'xterm.css'));

// 1b. node-pty ships a spawn-helper executable that some npm installs leave without +x
// (npm's install-scripts approval skips its postinstall) — a chmod heals it. The pty host owns
// the dependency; without this every spawn fails with "posix_spawnp failed".
for (const platform of ['darwin-arm64', 'darwin-x64']) {
	await chmod(path.join(root, 'node_modules', 'node-pty', 'prebuilds', platform, 'spawn-helper'), 0o755).catch(() => { /* only the host platform exists */ });
}

// 2. the bundles: main process, preload, renderer, the extension host, the pty host, the samples
const bundles = [
	{ in: 'src/main/main.ts', out: 'main.js', platform: 'node', format: 'esm' },
	{ in: 'src/preload/preload.ts', out: 'preload.cjs', platform: 'node', format: 'cjs' },
	{ in: 'src/renderer/bootstrap.ts', out: 'renderer.js', platform: 'browser', format: 'esm' },
	// 11: the extension host runs as a utility process (CJS, like the reference's node host)
	{ in: 'src/extHost/main.ts', out: 'extHost.cjs', platform: 'node', format: 'cjs' },
	// 13: the pty host — the same utility-process pattern (node-pty is a native dep it owns)
	{ in: 'src/ptyHost/main.ts', out: 'ptyHost.cjs', platform: 'node', format: 'cjs' },
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
	sourcemap: !production,
	minify: production,
	define: production ? { 'process.env.NODE_ENV': '"production"' } : undefined,
	metafile: production,
	// 14: the main bundle is ESM but electron-updater is CJS with dynamic `require('fs')`:
	// without a real require in scope esbuild's stub throws "Dynamic require ... is not
	// supported". The banner gives the main bundle a createRequire-backed require (the
	// renderer is a browser bundle — no node:module there).
	banner: b.out === 'main.js' ? { js: "import { createRequire as __miniCreateRequire } from 'node:module'; const require = __miniCreateRequire(import.meta.url);" } : undefined,
	external: ['electron', 'vscode',
		// 13: node-pty is native — its dynamic `require(dir + '/pty.node')` must resolve next to
		// node_modules/node-pty at runtime, not inside the bundle
		'node-pty'],
	// jsonc-parser's UMD entry uses dynamic require; point at its ESM build
	alias: { 'jsonc-parser': path.join(root, 'node_modules/jsonc-parser/lib/esm/main.js') },
}));

if (watch) {
	const contexts = await Promise.all(configs.map(c => esbuild.context(c)));
	await Promise.all(contexts.map(c => c.watch()));
	console.log('watching for changes — press Ctrl+C to stop');
} else {
	const results = await Promise.all(configs.map(c => esbuild.build(c)));
	console.log(`build done — output in out/${production ? ' (production)' : ''}`);

	if (production) {
		await reportAndCheck(results);
	}
}

/**
 * The bundle-hygiene gate the dist build runs: each entry point must stay in its lane, big
 * bundles are flagged so a regression is visible, and the metafile lands in out/ for eyeballing.
 */
async function reportAndCheck(results) {
	const meta = { bundles: {} };
	let failed = false;

	// entry → forbidden marker → why
	// 'xterm-rows' is a class name from the xterm LIBRARY (the pty host legitimately carries
	// 'xterm-256color' as the TERM name — markers must tell the two apart)
	const rules = [
		{ bundle: 'main.js', forbidden: ['xterm-rows', 'vscode-languageserver', 'node-pty'], why: 'the UI/host work belongs to the renderer and utility processes' },
		{ bundle: 'renderer.js', forbidden: ['node-pty', 'vscode-languageserver', 'child_process'], why: 'the renderer must not own native or host-only work' },
		{ bundle: 'extHost.cjs', forbidden: ['xterm-rows', 'node-pty'], why: 'the ext host does not own the terminal' },
		{ bundle: 'ptyHost.cjs', forbidden: ['xterm-rows', 'vscode-languageserver'], why: 'the pty host owns only the terminal' },
		{ bundle: 'ptyHost.cjs', required: ['require("node-pty")'], why: 'node-pty must stay external (a native module cannot be bundled)' },
	];
	// sizes in KB: generous caps, tight enough to catch an accidental cross-import
	const sizeCaps = { 'main.js': 2000, 'extHost.cjs': 1500, 'ptyHost.cjs': 500, 'renderer.js': 5000, 'preload.cjs': 100 };

	console.log('\nbundle report:');
	for (const result of results) {
		for (const [file, output] of Object.entries(result.metafile.outputs)) {
			const relative = path.relative(out, path.join(root, file));
			const sizeKb = output.bytes / 1024;
			meta.bundles[relative] = { bytes: output.bytes };
			const text = await readFile(file, 'utf8');
			const notes = [];

			for (const rule of rules) {
				if (rule.bundle !== path.basename(file)) {
					continue;
				}
				for (const marker of rule.forbidden ?? []) {
					if (text.includes(marker)) {
						notes.push(`FAIL: contains '${marker}' (${rule.why})`);
						failed = true;
					}
				}
				for (const marker of rule.required ?? []) {
					if (!text.includes(marker)) {
						notes.push(`FAIL: missing '${marker}' (${rule.why})`);
						failed = true;
					}
				}
			}
			// asar-safety: entry bundles should resolve paths through app.getAppPath(), not __dirname
			if (relative.endsWith('.js') || relative.endsWith('.cjs')) {
				const dirnameUses = (text.match(/__dirname/g) ?? []).length;
				if (dirnameUses > 0 && relative.startsWith('out/')) {
					notes.push(`note: ${dirnameUses} __dirname reference(s) — check asar safety`);
				}
			}
			const cap = sizeCaps[path.basename(file)];
			if (cap && sizeKb > cap) {
				notes.push(`FAIL: ${sizeKb.toFixed(0)} KB > cap ${cap} KB`);
				failed = true;
			}
			console.log(`  ${relative.padEnd(42)} ${sizeKb.toFixed(1).padStart(8)} KB  ${notes.join('; ')}`);
		}
	}

	await writeFile(path.join(out, 'build-meta.json'), JSON.stringify(meta, null, '\t'), 'utf8');
	if (failed) {
		console.error('\nbundle checks FAILED');
		process.exit(1);
	}
	console.log('bundle checks passed\n');
}
