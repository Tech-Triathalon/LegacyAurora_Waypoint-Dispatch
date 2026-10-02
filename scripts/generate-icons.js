#!/usr/bin/env node
// Generates the PWA icon set (PNG) with zero dependencies — the RGBA pixel
// payload is zlib-deflated by hand (spec: DEFLATE stored blocks + adler32),
// so no image library or build step is required.
//
//   node scripts/generate-icons.js
//
// Writes client/icons/icon-{192,512}.png and the maskable variants.
const fs = require('fs');
const path = require('path');

// ---------- minimal PNG encoder (color type 6: RGBA, 8-bit) ----------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function adler32(buf) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Real DEFLATE (fixed Huffman + LZ77 hash-chain) — flat-color art compresses
// ~100:1, keeping the icon set a few KB total instead of megabytes.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function bitWriter() {
  const bytes = [];
  let cur = 0;
  let n = 0;
  return {
    bits(value, count) { // LSB-first (headers + extra bits)
      for (let i = 0; i < count; i++) {
        cur |= ((value >> i) & 1) << n;
        if (++n === 8) { bytes.push(cur); cur = 0; n = 0; }
      }
    },
    code(value, count) { // MSB-first (huffman codes)
      for (let i = count - 1; i >= 0; i--) {
        cur |= ((value >> i) & 1) << n;
        if (++n === 8) { bytes.push(cur); cur = 0; n = 0; }
      }
    },
    finish() {
      if (n > 0) bytes.push(cur);
      return Buffer.from(bytes);
    },
  };
}

function litCode(sym, w) {
  if (sym <= 143) w.code(0x30 + sym, 8);
  else if (sym <= 255) w.code(0x190 + sym - 144, 9);
  else if (sym <= 279) w.code(sym - 256, 7);
  else w.code(0xc0 + sym - 280, 8);
}

function lenCodeFor(len) {
  let idx = LEN_BASE.length - 1;
  while (LEN_BASE[idx] > len) idx--;
  return { sym: 257 + idx, extra: len - LEN_BASE[idx], extraBits: LEN_EXTRA[idx] };
}

function distCodeFor(dist) {
  let idx = DIST_BASE.length - 1;
  while (DIST_BASE[idx] > dist) idx--;
  return { sym: idx, extra: dist - DIST_BASE[idx], extraBits: DIST_EXTRA[idx] };
}

function deflateFixed(raw) {
  const w = bitWriter();
  w.bits(1, 1); // BFINAL
  w.bits(1, 2); // BTYPE=01 fixed huffman
  // LZ77: hash chains on 3-byte prefixes.
  const head = new Map(); // key -> array of positions
  const key = (i) => (raw[i] << 16) | (raw[i + 1] << 8) | raw[i + 2];
  let i = 0;
  while (i < raw.length) {
    let bestLen = 0;
    let bestDist = 0;
    if (i + 3 <= raw.length) {
      const k = key(i);
      const chain = head.get(k);
      if (chain) {
        for (let c = chain.length - 1, tries = 0; c >= 0 && tries < 24; c--, tries++) {
          const j = chain[c];
          const dist = i - j;
          if (dist > 32768) break;
          let len = 0;
          const maxLen = Math.min(258, raw.length - i);
          while (len < maxLen && raw[j + len] === raw[i + len]) len++;
          if (len > bestLen) { bestLen = len; bestDist = dist; if (len === maxLen) break; }
        }
      }
      (head.get(k) || head.set(k, []).get(k)).push(i);
      if (head.get(k).length > 64) head.get(k).shift();
    }
    if (bestLen >= 3) {
      const lc = lenCodeFor(bestLen);
      litCode(lc.sym, w);
      if (lc.extraBits) w.bits(lc.extra, lc.extraBits);
      const dc = distCodeFor(bestDist);
      w.code(dc.sym, 5);
      if (dc.extraBits) w.bits(dc.extra, dc.extraBits);
      i += bestLen;
    } else {
      litCode(raw[i], w);
      i += 1;
    }
  }
  litCode(256, w); // end of block
  return w.finish();
}

function adler32(buf) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function zlibDeflate(raw) {
  const zlibHeader = Buffer.from([0x78, 0x9c]);
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(adler32(raw));
  return Buffer.concat([zlibHeader, deflateFixed(raw), adler]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // stride: filter byte + RGBA row
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibDeflate(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- icon artwork ----------
function drawIcon(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const bg = [13, 14, 16]; // #0d0e10 canvas
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) set(x, y, bg[0], bg[1], bg[2]);
  }
  const cx = size / 2;
  const cy = size / 2;
  // maskable safe zone: art inside the inner 80%
  const R = (v) => v * (maskable ? 0.62 : 0.78) * size; // radius helper scaled per variant

  // amber dish ring (F59E0B) — the satellite dish of the brand
  const ring = [245, 158, 11];
  const ringR = R(0.30);
  const stroke = Math.max(2, size * 0.022); // dish ring thickness (px)
  // globe (34D399 emerald) with orbit ellipse
  const globe = [52, 211, 153];
  const globeR = R(0.155);
  const orbitStroke = Math.max(2, size * 0.014);
  // signal dot
  const dot = [251, 191, 36];

  const inCircle = (x, y, ccx, ccy, r) => (x - ccx) ** 2 + (y - ccy) ** 2 <= r * r;

  // orbit ellipse: semi-axes a (horizontal), b (vertical)
  const a = ringR * 1.02;
  const b = ringR * 0.38;
  // pixel distance to the ellipse boundary ≈ |f| / |∇f| where f = ex²+ey²-1
  const ellipseDist = (x, y) => {
    const ex = (x - cx) / a;
    const ey = (y - cy) / b;
    const f = ex * ex + ey * ey - 1;
    const grad = 2 * Math.sqrt((ex / a) ** 2 + (ey / b) ** 2);
    return grad > 1e-9 ? Math.abs(f) / grad : Infinity;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dCenter = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      // dish ring
      if (Math.abs(dCenter - ringR) <= stroke / 2) set(x, y, ring[0], ring[1], ring[2]);
      // globe
      if (inCircle(x, y, cx, cy, globeR)) set(x, y, globe[0], globe[1], globe[2]);
      // orbit: thin ellipse crossing the globe (waypoint path)
      if (ellipseDist(x, y) <= orbitStroke / 2) set(x, y, ring[0], ring[1], ring[2]);
      // satellite dot on the upper-right orbit
      const ang = -Math.PI / 4;
      const dx = cx + Math.cos(ang) * a;
      const dy = cy + Math.sin(ang) * b;
      if (inCircle(x, y, dx, dy, R(0.05))) set(x, y, dot[0], dot[1], dot[2]);
    }
  }
  return encodePng(size, size, px);
}

const outDir = path.join(__dirname, '..', 'client', 'icons');
fs.mkdirSync(outDir, { recursive: true });
const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-192.png', 192, true],
  ['icon-maskable-512.png', 512, true],
];
for (const [name, size, maskable] of targets) {
  const png = drawIcon(size, maskable);
  fs.writeFileSync(path.join(outDir, name), png);
  console.log(`wrote client/icons/${name} (${png.length} bytes)`);
}
console.log('done');
