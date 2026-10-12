import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SIZE = 1024;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "icon-source.png");

const TOP = [255, 196, 107];
const BOTTOM = [255, 154, 61];
const INK = [10, 13, 18];

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r || (x >= x0 + r && x <= x1 - r && y >= y0 && y <= y1) ||
    (y >= y0 + r && y <= y1 - r && x >= x0 && x <= x1);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));

for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0;
  for (let x = 0; x < SIZE; x++) {
    const t = y / (SIZE - 1);
    let r = Math.round(lerp(TOP[0], BOTTOM[0], t));
    let g = Math.round(lerp(TOP[1], BOTTOM[1], t));
    let b = Math.round(lerp(TOP[2], BOTTOM[2], t));
    let a = 255;

    if (inRoundedRect(x, y, 0, 0, SIZE - 1, SIZE - 1, 216)) {
      const bubble = inRoundedRect(x, y, 226, 250, 798, 648, 118);
      const tail = y >= 648 && y <= 800 && x >= 320 && x <= 470 && x - 320 >= (y - 648) * 0.35;
      if (bubble || tail) {
        r = INK[0];
        g = INK[1];
        b = INK[2];
      }
      for (const dx of [-126, 0, 126]) {
        const ddx = x - (512 + dx);
        const ddy = y - 449;
        if (ddx * ddx + ddy * ddy <= 46 * 46) {
          r = Math.round(lerp(TOP[0], BOTTOM[0], t));
          g = Math.round(lerp(TOP[1], BOTTOM[1], t));
          b = Math.round(lerp(TOP[2], BOTTOM[2], t));
        }
      }
    } else {
      a = 0;
      const cx = Math.max(216, Math.min(x, SIZE - 1 - 216));
      const cy = Math.max(216, Math.min(y, SIZE - 1 - 216));
      const dist = Math.hypot(x - cx, y - cy);
      if (dist < 216 + 3) a = Math.round(255 * Math.max(0, 1 - (dist - 216) / 3));
    }

    const o = rowStart + 1 + x * 4;
    raw[o] = r;
    raw[o + 1] = g;
    raw[o + 2] = b;
    raw[o + 3] = a;
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(OUT, png);
console.log(`written: ${OUT} (${png.length} bytes)`);
