// scripts/check-dist.mjs — the CI-style assertions over the built bundle:
//   - Info.plist's CFBundleIdentifier / CFBundleShortVersionString match product.json
//   - app.asar contains exactly the allowlist (and nothing from src/, tests/, dist/)
//   - the asarUnpacked files exist where the spawns expect them
//   - the updater artifacts exist: the zip + latest-mac.yml with the same version
//
// Run by scripts/dist.mjs; can be run alone after a dist.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const product = JSON.parse(readFileSync(path.join(root, 'product.json'), 'utf8'));
const appPath = path.join(root, 'dist', 'mac-arm64', 'mini-vscode.app');

let failures = 0;
const check = (name, condition, detail = '') => {
	console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  → ${detail}`}`);
	if (!condition) {
		failures++;
	}
};

if (!existsSync(appPath)) {
	console.error(`no app bundle at ${path.relative(root, appPath)} — run npm run dist first`);
	process.exit(1);
}

// ---- Info.plist

const plistValue = key => execFileSync('plutil', ['-extract', key, 'raw', path.join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
check('CFBundleIdentifier matches product.json', plistValue('CFBundleIdentifier') === product.darwinBundleIdentifier, plistValue('CFBundleIdentifier'));
check('CFBundleShortVersionString matches product.json', plistValue('CFBundleShortVersionString') === product.version, `${plistValue('CFBundleShortVersionString')} vs ${product.version}`);
check('CFBundleName is the product name', plistValue('CFBundleName') === 'mini-vscode', plistValue('CFBundleName'));
check('the icon is bundled', existsSync(path.join(appPath, 'Contents', 'Resources', 'icon.icns')) || existsSync(path.join(appPath, 'Contents', 'Resources', 'electron.icns')), 'no icns in Resources');
check('the CLI script is bundled outside the asar', existsSync(path.join(appPath, 'Contents', 'Resources', 'cli', 'mini')));
check('app-update.yml was generated (the generic feed)', existsSync(path.join(appPath, 'Contents', 'Resources', 'app-update.yml')));

// ---- the asar contents (via @electron/asar, a transitive electron-builder dependency)

let asar;
try {
	asar = require('@electron/asar');
} catch {
	console.warn('note: @electron/asar is not resolvable — skipping the asar listing checks');
}
if (asar) {
	const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
	const entries = asar.listPackage(asarPath).map(entry => entry.replace(/^\//, ''));
	const topLevel = new Set(entries.map(entry => entry.split('/')[0]));
	const allowed = new Set(['out', 'product.json', 'extensions', 'node_modules', 'package.json']);
	check('the asar contains only allowlisted top-level entries', [...topLevel].every(entry => allowed.has(entry)), [...topLevel].join(', '));
	// node-pty legitimately ships its own src/ under node_modules: only OUR top-level src counts
	check('no src/ leaked into the asar', !entries.some(entry => entry.startsWith('src/')), 'src/ found');
	check('no tests/ or scripts/ leaked', !entries.some(entry => entry.startsWith('tests/') || entry.startsWith('scripts/') || entry.startsWith('dist/')));
	for (const required of ['out/main.js', 'out/preload.cjs', 'out/renderer.js', 'out/extHost.cjs', 'out/ptyHost.cjs', 'out/index.html', 'out/workbench.css', 'out/xterm.css', 'product.json', 'extensions/hello/package.json', 'extensions/toy-lang/out/server.js']) {
		check(`asar contains ${required}`, entries.includes(required), 'missing');
	}
	const unpacked = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked');
	for (const required of ['out/extHost.cjs', 'out/ptyHost.cjs', 'extensions/toy-lang/out/server.js']) {
		check(`unpacked: ${required} (spawnable outside asar)`, existsSync(path.join(unpacked, required)), 'missing');
	}
	// node-pty ships as an extraResource OUTSIDE the asar (its own asar rewrite double-replaces
	// app.asar.unpacked — the spawn-helper path must not contain app.asar at all)
	check('no node-pty in the asar', !entries.some(entry => entry.startsWith('node_modules/node-pty/')), 'node-pty found in asar');
	const ptyRoot = path.join(appPath, 'Contents', 'Resources', 'node_modules', 'node-pty');
	check('node-pty ships outside the asar (extraResources)', existsSync(path.join(ptyRoot, 'prebuilds')) || existsSync(path.join(ptyRoot, 'build')), 'searching prebuilds/build');
	const helper = path.join(ptyRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper');
	if (existsSync(helper)) {
		check('the spawn-helper stays executable', (statSync(helper).mode & 0o111) !== 0, `mode ${(statSync(helper).mode & 0o777).toString(8)}`);
	}
}

// ---- the updater artifacts

const ymlPath = path.join(root, 'dist', 'latest-mac.yml');
check('latest-mac.yml exists (the updater feed file)', existsSync(ymlPath));
if (existsSync(ymlPath)) {
	const yml = readFileSync(ymlPath, 'utf8');
	check('latest-mac.yml carries the product version', yml.includes(`version: ${product.version}`), yml.split('\n')[0]);
	check('latest-mac.yml points at the zip', /\.zip/.test(yml) && yml.includes('sha512'), 'no zip/sha512 entry');
}
// electron-builder's default mac zip name: <productName>-<version>-<arch>-mac.zip
const zipCandidates = [`mini-vscode-${product.version}-arm64-mac.zip`, `mini-vscode-${product.version}-arm64.zip`, `mini-vscode-${product.version}.zip`];
check('the mac zip artifact exists', zipCandidates.some(name => existsSync(path.join(root, 'dist', name))), zipCandidates.join(' or '));
check('the dmg artifact exists', ['mini-vscode-' + product.version + '-arm64.dmg', `mini-vscode-${product.version}.dmg`].some(name => existsSync(path.join(root, 'dist', name))));

// ---- codesign (ad-hoc in this pipeline)

{
	// codesign -dv writes its report to STDERR
	const result = spawnSync('codesign', ['-dv', appPath], { encoding: 'utf8' });
	const report = `${result.stdout ?? ''}${result.stderr ?? ''}`;
	const signatureLine = report.split('\n').find(line => line.includes('Signature')) ?? report.slice(0, 120);
	check('the bundle carries an ad-hoc signature', /Signature=adhoc/i.test(report), signatureLine);
}

console.log(failures === 0 ? '\nall dist checks passed' : `\n${failures} dist check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
