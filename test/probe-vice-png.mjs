// Decode a PNG and report yellow pixel positions to compare with our impl.
import fs from 'fs';
import zlib from 'zlib';

function readPNG(path) {
  const buf = fs.readFileSync(path);
  // Parse IHDR
  let p = 8; // skip signature
  let w, h, bitDepth, colorType;
  let idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); p += 4;
    const type = buf.toString('ascii', p, p + 4); p += 4;
    const data = buf.slice(p, p + len);
    p += len + 4; // +4 for CRC
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  // Decode filtered scanlines (assume color type 2 = RGB, 8-bit).
  const stride = w * 3;
  const pixels = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    if (filter === 0) {
      pixels.set(row, y * stride);
    } else {
      // Other filters not implemented — VICE's PNG likely uses filter 0 or 4 (Paeth).
      throw new Error(`unsupported filter ${filter}`);
    }
  }
  return { w, h, pixels };
}

const png = readPNG(process.argv[2]);
console.log(`PNG ${process.argv[2]}: ${png.w}×${png.h}`);

// Find yellow pixels (R≈$ED, G≈$F1, B≈$71 ish — VICE's palette).
const yellows = [];
const byRow = new Map();
for (let y = 0; y < png.h; y++) {
  for (let x = 0; x < png.w; x++) {
    const o = (y * png.w + x) * 3;
    const r = png.pixels[o], g = png.pixels[o+1], b = png.pixels[o+2];
    // Yellow-ish: r > 200, g > 200, b < 150
    if (r > 200 && g > 200 && b < 150) {
      yellows.push([x, y]);
      byRow.set(y, (byRow.get(y) || 0) + 1);
    }
  }
}
console.log(`yellow pixels: ${yellows.length}`);
console.log(`yellow rows (y → count):`);
const rows = [...byRow.entries()].sort((a, b) => a[0] - b[0]);
for (const [y, n] of rows) console.log(`  y=${y}: ${n}`);
