'use strict';
/*
 * Generates the PWA icons procedurally (no image libraries needed).
 * Usage: node tools/make-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'games', 'fake-artist');

/* ------------------------------- PNG encoder ------------------------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* --------------------------------- artwork -------------------------------- */
const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const BG_A = [0x1b, 0x1f, 0x31];
const BG_B = [0x0f, 0x11, 0x17];
const MASK_A = [0x6c, 0x8c, 0xff];
const MASK_B = [0xb0, 0x6c, 0xff];
const HOLE = [0x12, 0x14, 0x1c];

function sample(u, v) {
  // rounded-square background
  const R = 0.225;
  const dx = Math.max(0, Math.abs(u - 0.5) - (0.5 - R));
  const dy = Math.max(0, Math.abs(v - 0.5) - (0.5 - R));
  if (Math.hypot(dx, dy) > R) return [0, 0, 0, 0];

  let col = mix(BG_A, BG_B, (u + v) / 2);

  // the mask
  const inMask = ((u - 0.5) / 0.275) ** 2 + ((v - 0.53) / 0.335) ** 2 <= 1;
  if (inMask) {
    col = mix(MASK_A, MASK_B, clamp01((u + v) / 2 * 0.95 + 0.05));
    const eyeL = ((u - 0.405) / 0.063) ** 2 + ((v - 0.445) / 0.083) ** 2 <= 1;
    const eyeR = ((u - 0.595) / 0.063) ** 2 + ((v - 0.445) / 0.083) ** 2 <= 1;
    const smile = ((u - 0.5) / 0.108) ** 2 + ((v - 0.62) / 0.062) ** 2 <= 1 && v > 0.62;
    if (eyeL || eyeR || smile) col = HOLE;
  }
  return [col[0], col[1], col[2], 255];
}

function render(size) {
  const out = Buffer.alloc(size * size * 4);
  const SS = 3; // supersampling for smooth edges
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const [pr, pg, pb, pa] = sample(u, v);
          const al = pa / 255;
          r += pr * al; g += pg * al; b += pb * al; a += pa;
        }
      }
      const n = SS * SS;
      const aAvg = a / n;
      const al = aAvg / 255 || 1;
      const i = (y * size + x) * 4;
      out[i] = Math.round(r / n / al);
      out[i + 1] = Math.round(g / n / al);
      out[i + 2] = Math.round(b / n / al);
      out[i + 3] = Math.round(aAvg);
    }
  }
  return out;
}

/* ----------------------------------- run ---------------------------------- */
const targets = [
  ['icon-512.png', 512],
  ['icon-192.png', 192],
  ['apple-touch-icon.png', 180],
  ['favicon-32.png', 32],
];

for (const [name, size] of targets) {
  const png = encodePNG(size, size, render(size));
  fs.writeFileSync(path.join(OUT, name), png);
  console.log(`wrote public/games/fake-artist/${name}  (${size}x${size}, ${png.length} bytes)`);
}
