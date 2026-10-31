// electron-builder.config.cjs — the bundle recipe, recreating the SHAPE of the real VS Code
// .app assembly (build/gulpfile.vscode.ts + resources/darwin/): an asar with an explicit
// allowlist, the bundled extensions, the product metadata and the zip artifact the mac updater
// consumes. Run through `npm run dist` (scripts/dist.mjs stamps product.json first).

const product = require('./product.json');

/** @type {import('electron-builder').Configuration} */
module.exports = {
	appId: product.darwinBundleIdentifier,
	productName: 'mini-vscode',
	copyright: `Copyright © 2026 ${product.nameShort}`,

	directories: {
		output: 'dist',
		buildResources: 'build'
	},

	// node-pty ships a prebuilt binary that already targets this Electron's ABI (verified in 13:
	// it loads under ELECTRON_RUN_AS_NODE). Rebuilding from source would need a working local
	// toolchain, which this machine lacks — so electron-builder must not try.
	npmRebuild: false,

	// `npm version` bumps package.json; product.json is the product's source of truth (the real
	// one ships product.json into the app the same way). extraMetadata keeps them equal so the
	// Info.plist version and the About dialog can never skew.
	extraMetadata: {
		version: product.version,
		main: 'out/main.js'
	},

	// the `mini` CLI script lives OUTSIDE the asar (a shell script needs a real path).
	// node-pty also lives outside the asar: its own asar rewrite breaks a path that already
	// contains app.asar.unpacked (see asarUnpack below).
	extraResources: [
		{ from: 'resources/cli/mini', to: 'cli/mini' },
		{ from: 'node_modules/node-pty', to: 'node_modules/node-pty' }
	],

	// the explicit allowlist: what ends up in app.asar, and nothing else. node_modules is
	// excluded wholesale: electron-updater is bundled into main.js, node-pty ships as an
	// extraResource (below) — the asar needs no node modules at runtime.
	files: [
		'out/**/*',
		'product.json',
		'extensions/*/package.json',
		'extensions/*/out/**/*',
		'extensions/toy-lang/sample.cfg',
		'extensions/toy-lang/README.md',
		'!node_modules/**/*'
	],

	asar: true,
	// The bundles that get SPAWNED (utilityProcess.fork / child_process.spawn) cannot run from
	// inside asar — Electron's fs patch covers reads, not exec. This is the pitfall every
	// packaging exercise hits.
	//
	// node-pty is NOT unpacked here (unlike the real VS Code, which ships it outside the app
	// archive too): its own asar workaround rewrites `app.asar` → `app.asar.unpacked` in the
	// spawn-helper path, and a path that already contains `app.asar.unpacked` becomes
	// `app.asar.unpacked.unpacked` → posix_spawnp fails. Shipping it as an extraResource puts
	// it at Contents/Resources/node_modules/node-pty, where the pty host's require finds it
	// (its script lives in app.asar.unpacked/out and resolves upward).
	asarUnpack: [
		'out/extHost.cjs',
		'out/ptyHost.cjs',
		'extensions/toy-lang/out/server.js'
	],

	mac: {
		category: 'public.app-category.developer-tools',
		target: [
			// dmg for humans, ZIP FOR THE UPDATER — electron-updater on macOS consumes the zip +
			// latest-mac.yml; dmg-only releases mysteriously never update
			{ target: 'dmg', arch: ['arm64'] },
			{ target: 'zip', arch: ['arm64'] }
		],
		icon: 'build/icon.icns',
		// Hardened runtime stays OFF for local, ad-hoc-signed builds: entitlements only matter
		// once a real Developer ID signs the app (see build/README.md). Flip both together.
		hardenedRuntime: false,
		entitlements: 'build/entitlements.mac.plist',
		entitlementsInherit: 'build/entitlements.mac.plist',
		// no signing identity on this machine: electron-builder skips codesign; the afterPack
		// hook below applies the ad-hoc signature BEFORE the dmg/zip are built (so the updater's
		// zip carries the same signature as the installed app)
		identity: null
	},

	// 14: ad-hoc sign after the .app is assembled but before artifacts are packed. The exercise
	// asks for `codesign --deep --force --sign -`; running it here (instead of after the build)
	// means the zip electron-updater downloads is signed too.
	afterPack: async context => {
		if (context.electronPlatformName !== 'darwin') {
			return;
		}
		const { execFileSync } = require('node:child_process');
		const path = require('node:path');
		const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
		execFileSync('codesign', ['--deep', '--force', '--sign', '-', '--timestamp=none', appPath], { stdio: 'inherit' });
	},

	// the generic provider: a static directory (scripts/updates-server.mjs serves dist/).
	// electron-builder writes Resources/app-update.yml from this; electron-updater reads it.
	publish: [
		{
			provider: 'generic',
			url: 'http://localhost:8123'
		}
	]
};
