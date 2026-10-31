// scripts/make-icon.mjs — draws the app icon from scratch (no image libraries), then converts it
// into an .icns with the macOS tools (sips + iconutil). The design:
//
//   "the slashed zero" — a black squircle carrying a bold silver 0 cut by a diagonal slash: the
//   programmer's zero (never an O), monochrome by design (grays and black only), with a hairline
//   edge and a soft halo so it holds up on dark docks.
//
// Rendered at 2x and downsampled for anti-aliasing; encoded as PNG by hand (zlib + a CRC32).
// Regenerated on every `npm run dist` (deterministic), so it is not checked in.

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

// ---- the design (all values in 1024-space; Apple's icon grid: 824 tile, r ≈ 185)

const CENTER = 512;
const TILE_MARGIN = 100;                 // the rounded tile
const TILE_RADIUS = 185;
const TILE_MIN = TILE_MARGIN;
const TILE_MAX = SIZE - TILE_MARGIN;

const TILE_TOP = { r: 0x18, g: 0x18, b: 0x18 };   // near-black, a hint of a vertical gradient
const TILE_BOTTOM = { r: 0x06, g: 0x06, b: 0x06 };
const TILE_EDGE = { r: 0x2d, g: 0x2d, b: 0x2d };    // hairline border: definition on black docks
const EDGE_WIDTH = 3;
const HALO = { r: 0x2a, g: 0x2a, b: 0x2a };       // soft halo around the mark
const HALO_WIDTH = 36;

const RING_RADIUS = 216;                 // the 0's centreline radius
const STROKE = 100;                      // stroke width
const RING_TOP = { r: 0xe8, g: 0xe8, b: 0xe8 };   // silver, light from above
const RING_BOTTOM = { r: 0x84, g: 0x84, b: 0x84 };
const SLASH_WIDTH = 60;                  // the cut: the programmer's zero treatment
const SLASH_LENGTH = 320;                // reaches past the ring on both sides

const mix = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });

/** signed distance to the tile's rounded rect (negative inside) */
function tileDistance(x, y) {
	const half = (TILE_MAX - TILE_MIN) / 2;
	const dx = Math.abs(x - CENTER) - (half - TILE_RADIUS);
	const dy = Math.abs(y - CENTER) - (half - TILE_RADIUS);
	const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
	return outside + Math.min(Math.max(dx, dy), 0) - TILE_RADIUS;
}

/** distance to the slash segment (negative = inside the cut) */
function slashDistance(x, y) {
	const dx = SLASH_LENGTH * Math.SQRT1_2;      // 45°, from bottom-left to top-right
	const x1 = CENTER - dx;
	const y1 = CENTER + dx;
	const x2 = CENTER + dx;
	const y2 = CENTER - dx;
	const t = Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / ((x2 - x1) ** 2 + (y2 - y1) ** 2)));
	return Math.hypot(x - (x1 + t * (x2 - x1)), y - (y1 + t * (y2 - y1))) - SLASH_WIDTH / 2;
}

/** the icon's colour at a design-space point, or null for transparent */
function sample(x, y) {
	if (tileDistance(x, y) > 0) {
		return null; // outside the tile
	}
	const base = mix(TILE_TOP, TILE_BOTTOM, Math.min(1, Math.max(0, (y - TILE_MIN) / (TILE_MAX - TILE_MIN))));
	if (tileDistance(x, y) > -EDGE_WIDTH) {
		return mix(base, TILE_EDGE, 0.85); // the hairline edge
	}

	// the slash cuts through both the ring and its halo: a clean black gap
	if (slashDistance(x, y) < 0) {
		return base;
	}

	const distance = Math.hypot(x - CENTER, y - CENTER);
	const ringDistance = Math.abs(distance - RING_RADIUS) - STROKE / 2;
	if (ringDistance < 0) {
		return mix(RING_TOP, RING_BOTTOM, Math.min(1, Math.max(0, (y - (CENTER - RING_RADIUS)) / (2 * RING_RADIUS))));
	}
	if (ringDistance < HALO_WIDTH) {
		return mix(base, HALO, 0.5 * (1 - ringDistance / HALO_WIDTH));
	}
	return base;
}

// ---- rasterize (supersampled) + downsample

const big = new Uint8Array(W * W * 4);
for (let py = 0; py < W; py++) {
	for (let px = 0; px < W; px++) {
		const colour = sample((px + 0.5) / SCALE, (py + 0.5) / SCALE);
		if (colour) {
			const offset = (py * W + px) * 4;
			big[offset] = Math.round(colour.r);
			big[offset + 1] = Math.round(colour.g);
			big[offset + 2] = Math.round(colour.b);
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
console.log(`icon: wrote ${path.relative(root, pngPath)} (${SIZE}x${SIZE}) — the slashed zero`);

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
