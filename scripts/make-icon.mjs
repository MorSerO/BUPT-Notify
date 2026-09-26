/**
 * make-icon.mjs — generate assets/bupt-notify.ico (no dependencies).
 *
 * Draws a small envelope badge in BUPT blue at 16/32/48/256 px and writes a
 * standard multi-image .ico, so the desktop shortcut gets a real application
 * icon instead of a generic script icon.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'assets');

const BLUE = [0x1a, 0x5f, 0xb4];
const BLUE_D = [0x14, 0x49, 0x8b];
const WHITE = [0xff, 0xff, 0xff];

/** Paint one size, returning BGRA pixels (top-down) plus an alpha mask. */
function paint(size) {
  const px = new Uint8Array(size * size * 4);
  const put = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = b;
    px[i + 1] = g;
    px[i + 2] = r;
    px[i + 3] = a;
  };

  const radius = Math.max(2, Math.round(size * 0.18));
  const inRounded = (x, y) => {
    const r = radius;
    const cx = x < r ? r : x >= size - r ? size - r - 1 : x;
    const cy = y < r ? r : y >= size - r ? size - r - 1 : y;
    if (cx === x && cy === y) return true;
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  };

  // Rounded blue tile with a subtle vertical gradient.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!inRounded(x, y)) continue;
      const t = y / Math.max(1, size - 1);
      const col = [
        Math.round(BLUE[0] + (BLUE_D[0] - BLUE[0]) * t),
        Math.round(BLUE[1] + (BLUE_D[1] - BLUE[1]) * t),
        Math.round(BLUE[2] + (BLUE_D[2] - BLUE[2]) * t),
      ];
      put(x, y, col);
    }
  }

  // Envelope: body rectangle + a V flap, drawn with thin strokes so it stays
  // legible at 16px.
  const m = Math.max(2, Math.round(size * 0.2)); // margin
  const left = m;
  const right = size - m - 1;
  const top = Math.round(size * 0.32);
  const bottom = size - m - 1;
  const stroke = Math.max(1, Math.round(size / 16));

  const drawH = (x0, x1, y) => {
    for (let x = x0; x <= x1; x += 1) for (let s = 0; s < stroke; s += 1) put(x, y + s, WHITE);
  };
  const drawV = (x, y0, y1) => {
    for (let y = y0; y <= y1; y += 1) for (let s = 0; s < stroke; s += 1) put(x + s, y, WHITE);
  };

  drawH(left, right, top);
  drawH(left, right, bottom - stroke + 1);
  drawV(left, top, bottom - stroke + 1);
  drawV(right - stroke + 1, top, bottom - stroke + 1);

  // Flap: two diagonals meeting at the middle.
  const midX = (left + right) / 2;
  const midY = top + (bottom - top) * 0.55;
  const steps = Math.max(4, size);
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x1 = left + (midX - left) * t;
    const y1 = top + (midY - top) * t;
    const x2 = right - (right - midX) * t;
    const y2 = top + (midY - top) * t;
    for (let s = 0; s < stroke; s += 1) {
      put(Math.round(x1) + s, Math.round(y1), WHITE);
      put(Math.round(x2) - s, Math.round(y2), WHITE);
    }
  }

  return px;
}

/** Wrap painted pixels in a BMP-in-ICO image record. */
function toBmpRecord(size, px) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(size * size * 4, 20);

  // XOR: bottom-up BGRA
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const src = (size - 1 - y) * size * 4;
    px.subarray(src, src + size * 4).forEach((v, i) => {
      xor[y * size * 4 + i] = v;
    });
  }

  // AND mask: 1 bit per pixel, rows padded to 4 bytes. All zero = use alpha.
  const rowBytes = Math.ceil(size / 8 / 4) * 4;
  const and = Buffer.alloc(rowBytes * size, 0);

  return Buffer.concat([header, xor, and]);
}

fs.mkdirSync(outDir, { recursive: true });

// 16–64px covers the desktop, taskbar and Explorer at normal scaling. Larger
// sizes are stored uncompressed in an ICO, so a 256px entry alone would add
// ~260 KB to the file for no visible benefit here.
const sizes = [16, 24, 32, 48, 64];
const images = sizes.map((s) => ({ size: s, data: toBmpRecord(s, paint(s)) }));

const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2); // ICO
dir.writeUInt16LE(images.length, 4);

let offset = 6 + images.length * 16;
const entries = [];
for (const img of images) {
  const e = Buffer.alloc(16);
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 0);
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
  e.writeUInt8(0, 2);
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(img.data.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += img.data.length;
}

const ico = Buffer.concat([dir, ...entries, ...images.map((i) => i.data)]);
const outFile = path.join(outDir, 'bupt-notify.ico');
fs.writeFileSync(outFile, ico);
console.log(`已生成图标: ${outFile} (${sizes.join('/')}px, ${ico.length} 字节)`);
