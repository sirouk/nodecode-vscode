// test/render-icon.mjs
// Regenerates media/icon.png, the marketplace icon, at 256x256.
// A deterministic raster of the media/icon.svg mark: rounded-square badge in
// #1c1e26 with the Nodecode N in #7f6cf2. No dependencies — node only. The
// file must be committed; publish.yml and release.sh both fail if it drifts.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 256;
const INSET = 8; // svg rect x=4 at half scale
const RADIUS = 48; // svg rx=24 at half scale
const BG = [0x1c, 0x1e, 0x26];
const FG = [0x7f, 0x6c, 0xf2];

// Bars of the N glyph, scaled 2x from the svg path: left and right verticals
// as rects, the diagonal as a capsule. Capsule endpoints are the centerline of
// the svg diagonal, half-width 12 (svg stroke 12, doubled, halved).
const BARS = {
  rects: [
    [68, 64, 92, 192],
    [164, 64, 188, 192],
  ],
  capsule: [104, 64, 176, 192, 12],
};

// ---- png plumbing ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

function rectSDF(px, py, x0, y0, x1, y1) {
  const dx = Math.max(x0 - px, 0, px - x1);
  const dy = Math.max(y0 - py, 0, py - y1);
  return Math.hypot(dx, dy);
}

function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

// ---- raster ----
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4)); // one filter byte per row
const BOTTOM = SIZE - INSET;
const [capAx, capAy, capBx, capBy, capHW] = BARS.capsule;

for (let y = 0; y < SIZE; y++) {
  const row = y * (1 + SIZE * 4) + 1;
  for (let x = 0; x < SIZE; x++) {
    const px = x + 0.5;
    const py = y + 0.5;
    const badgeEdge = rectSDF(px, py, INSET + RADIUS, INSET + RADIUS, BOTTOM - RADIUS, BOTTOM - RADIUS) - RADIUS;
    const badgeA = Math.min(1, Math.max(0, 0.5 - badgeEdge));
    if (badgeA <= 0) continue;
    let mark = Infinity;
    for (const [x0, y0, x1, y1] of BARS.rects) mark = Math.min(mark, rectSDF(px, py, x0, y0, x1, y1));
    mark = Math.min(mark, segDist(px, py, capAx, capAy, capBx, capBy) - capHW);
    const mask = Math.min(1, Math.max(0, 0.5 - mark));
    const i = row + x * 4;
    raw[i] = Math.round(BG[0] + (FG[0] - BG[0]) * mask);
    raw[i + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * mask);
    raw[i + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * mask);
    raw[i + 3] = Math.round(255 * badgeA);
  }
}

// ---- png ----
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const dest = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'media', 'icon.png');
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, png);
console.log(`icon: ${dest} (${SIZE}x${SIZE}, ${png.length} bytes)`);
