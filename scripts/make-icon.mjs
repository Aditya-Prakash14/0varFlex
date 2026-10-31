// scripts/make-icon.mjs — draws the app icon from scratch (no image libraries): a rounded
// square in the workbench accent with the terminal-prompt glyph ">_", rendered at 2x and
// downsampled for anti-aliasing, encoded as PNG by hand (zlib + a CRC32), then converted into
// an .icns iconset with the macOS tools (sips + iconutil).
//
// The real VS Code ships icon sets per platform (resources/darwin/code.icns etc.); this is the
// same artifact, generated instead of checked in.

import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'build');

const SIZE = 1024;
const SCALE = 2;                 // supersample, then average down
const W = SIZE * SCALE;

// ---- the drawing (all in device pixels of the supersampled canvas)

const MARGIN = 96 * SCALE;       // ~9% padding, like macOS icons expect
const RADIUS = 180 * SCALE;
const TILE = { r: 0x00, g: 0x78, b: 0xd4 };   // the workbench accent (--mini-accent)
const GLYPH = { r: 0xff, g: 0xff, b: 0xff };

const TILE_MIN = MARGIN;
const TILE_MAX = W - MARGIN;

function inRoundedRect(x, y) {
	if (x < TILE_MIN || x >= TILE_MAX || y < TILE_MIN || y >= TILE_MAX) {
		return false;
	}
	// corner circles
	const cx = x < TILE_MIN + RADIUS ? TILE_MIN + RADIUS : x >= TILE_MAX - RADIUS ? TILE_MAX - RADIUS : x;
	const cy = y < TILE_MIN + RADIUS ? TILE_MIN + RADIUS : y >= TILE_MAX - RADIUS ? TILE_MAX - RADIUS : y;
	if ((cx === x && cy === y) || (cx === x && y >= TILE_MIN + RADIUS && y < TILE_MAX - RADIUS) || (cy === y && x >= TILE_MIN + RADIUS && x < TILE_MAX - RADIUS)) {
		return true;
	}
	const dx = x - cx;
	const dy = y - cy;
	return dx * dx + dy * dy <= RADIUS * RADIUS;
}

/** thick line segment (distance to segment < half width) */
function onSegment(x, y, x1, y1, x2, y2, width) {
	const half = width / 2;
	const dx = x2 - x1;
	const dy = y2 - y1;
	const lengthSq = dx * dx + dy * dy;
	const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSq));
	const px = x1 + t * dx;
	const py = y1 + t * dy;
	const ddx = x - px;
	const ddy = y - py;
	return ddx * ddx + ddy * ddy <= half * half;
}

// the glyph: ">" (two strokes) + "_" (a bar), centred in the tile
const s = SCALE;
const GLYPH_WIDTH = 84 * s;
const segments = [
	[250 * s, 316 * s, 520 * s, 512 * s],
	[520 * s, 512 * s, 250 * s, 708 * s],
	[590 * s, 708 * s, 790 * s, 708 * s]
];

function sample(x, y) {
	if (!inRoundedRect(x, y)) {
		return null; // transparent
	}
	for (const [x1, y1, x2, y2] of segments) {
		if (onSegment(x, y, x1, y1, x2, y2, GLYPH_WIDTH)) {
			return GLYPH;
		}
	}
	return TILE;
}

// ---- rasterize (supersampled) + downsample

const big = new Uint8Array(W * W * 4);
for (let y = 0; y < W; y++) {
	for (let x = 0; x < W; x++) {
		const colour = sample(x, y);
		const offset = (y * W + x) * 4;
		if (colour) {
			big[offset] = colour.r;
			big[offset + 1] = colour.g;
			big[offset + 2] = colour.b;
			big[offset + 3] = 255;
		}
	}
}

const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
	for (let x = 0; x < SIZE; x++) {
		let r = 0;
		let g = 0;
		let b = 0;
		let a = 0;
		for (let dy = 0; dy < SCALE; dy++) {
			for (let dx = 0; dx < SCALE; dx++) {
				const offset = ((y * SCALE + dy) * W + (x * SCALE + dx)) * 4;
				r += big[offset];
				g += big[offset + 1];
				b += big[offset + 2];
				a += big[offset + 3];
			}
		}
		const count = SCALE * SCALE;
		const offset = (y * SIZE + x) * 4;
		rgba[offset] = Math.round(r / count);
		rgba[offset + 1] = Math.round(g / count);
		rgba[offset + 2] = Math.round(b / count);
		rgba[offset + 3] = Math.round(a / count);
	}
}

// ---- PNG encoding (RGBA, 8-bit; one IDAT, filter 0 per scanline)

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typeAndData));
	return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, pixels) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;   // bit depth
	ihdr[9] = 6;   // colour type: RGBA
	// compression/filter/interlace stay 0
	const raw = Buffer.alloc(height * (1 + width * 4));
	for (let y = 0; y < height; y++) {
		raw[y * (1 + width * 4)] = 0; // filter: none
		pixels.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0))
	]);
}

mkdirSync(buildDir, { recursive: true });
const pngPath = path.join(buildDir, 'icon.png');
writeFileSync(pngPath, encodePng(SIZE, SIZE, rgba));
console.log(`icon: wrote ${path.relative(root, pngPath)} (${SIZE}x${SIZE})`);

// ---- iconset → icns (sips + iconutil; both ship with macOS)

const iconsetDir = path.join(buildDir, 'icon.iconset');
rmSync(iconsetDir, { recursive: true, force: true });
mkdirSync(iconsetDir, { recursive: true });

const variants = [
	[16, 'icon_16x16.png'],
	[32, 'icon_16x16@2x.png'],
	[32, 'icon_32x32.png'],
	[64, 'icon_32x32@2x.png'],
	[128, 'icon_128x128.png'],
	[256, 'icon_128x128@2x.png'],
	[256, 'icon_256x256.png'],
	[512, 'icon_256x256@2x.png'],
	[512, 'icon_512x512.png'],
	[1024, 'icon_512x512@2x.png']
];

try {
	for (const [size, name] of variants) {
		execFileSync('sips', ['-z', String(size), String(size), pngPath, '--out', path.join(iconsetDir, name)], { stdio: 'ignore' });
	}
	execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', path.join(buildDir, 'icon.icns')], { stdio: 'ignore' });
	console.log('icon: wrote build/icon.icns (16…1024)');
} catch (error) {
	// sips/iconutil are macOS tools; electron-builder can convert icon.png itself if the icns
	// is missing — do not fail the build over cosmetics
	console.warn(`icon: icns conversion skipped (${error.message}) — electron-builder will use icon.png`);
} finally {
	rmSync(iconsetDir, { recursive: true, force: true });
}
