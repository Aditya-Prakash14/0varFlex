// scripts/dist.mjs — the release pipeline: stamp product.json → production build → icon →
// electron-builder (dmg + zip + latest-mac.yml) → ad-hoc codesign → verify.
//
// Run: npm run dist
//
// The electron mirror env keeps the Electron zip download aligned with the cache the manual
// install already populated (GitHub's CDN throttles on some networks; the mirror URL hashes to
// the same cache directory, so this is a cache HIT instead of a download).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args, options = {}) => {
	console.log(`\n$ ${command} ${args.join(' ')}`);
	execFileSync(command, args, { stdio: 'inherit', cwd: root, ...options });
};

// ---- 1. stamp the product metadata (the About dialog and Info.plist read these)

const productPath = path.join(root, 'product.json');
const product = JSON.parse(readFileSync(productPath, 'utf8'));
let commit = '';
try {
	commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
} catch {
	// not a git checkout: leave the commit empty
}
product.commit = commit;
product.date = new Date().toISOString().slice(0, 10);
writeFileSync(productPath, `${JSON.stringify(product, null, '\t')}\n`);
console.log(`product.json: version ${product.version}, commit ${commit || '(none)'}, date ${product.date}`);

// electron-builder names the artifacts from package.json's version: keep them equal so the
// Info.plist, the About dialog and the update feed can never skew (the version-skew pitfall)
const packagePath = path.join(root, 'package.json');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
if (packageJson.version !== product.version) {
	packageJson.version = product.version;
	writeFileSync(packagePath, `${JSON.stringify(packageJson, null, '\t')}\n`);
	console.log(`package.json: version synced to ${product.version}`);
}

// ---- 2. the production build (minified, bundle checks) + the icon

run(process.execPath, ['scripts/build.mjs', '--production']);
// the icon is generated, not checked in: redraw it on every dist (it is deterministic)
run(process.execPath, ['scripts/make-icon.mjs']);

// ---- 3. electron-builder (dmg for humans, zip for the updater)

const env = {
	...process.env,
	// the mirror prefix hashed into the populated cache; unset this and the download may throttle
	ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://gh-proxy.com/https://github.com/electron/electron/releases/download/'
};
// --config is explicit: electron-builder does not auto-detect the .cjs name
run(path.join(root, 'node_modules', '.bin', 'electron-builder'), ['--config', 'electron-builder.config.cjs', '--mac', '--arm64', '--publish', 'never'], { env });

// ---- 4. the ad-hoc signature is applied by electron-builder's afterPack hook (so the zip the
// updater downloads is signed too) — nothing to do here. See build/README.md for the real path.

// ---- 5. verify the bundle against product.json + the allowlist

run(process.execPath, ['scripts/check-dist.mjs']);

// ---- 6. instructions

const appPath = path.join(root, 'dist', 'mac-arm64', 'mini-vscode.app');
console.log(`
dist complete: version ${product.version}
  install:   ditto "${path.relative(root, appPath)}" /Applications/mini-vscode.app
  launch it: open -a /Applications/mini-vscode.app
  CLI:       Shell Command: Install 'mini' command in PATH (from the palette), then: mini .
  updates:   1) npm version patch --no-git-tag-version   (package.json only)
             2) edit product.json's "version" to the same value
             3) node scripts/updates-server.mjs          (serves dist/ on :8123)
             4) npm run dist                             (the NEW version must be re-distributed)
             5) launch the ALREADY-INSTALLED older app — electron-updater refuses to update a dev run
`);
