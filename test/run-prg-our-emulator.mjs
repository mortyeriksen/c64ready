// Run a PRG in OUR emulator and capture its frame as PNG. Mirror of
// VICE's `-autostart prg -limitcycles N -exitscreenshot out.png`. Lets
// us A/B compare our CPU+VIC integration against VICE on identical PRGs.
//
// Usage: node test/run-prg-our-emulator.mjs <input.prg> <output.png> [frames]

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { C64Machine } from '../src/machine.js';
import { CANVAS_W, CANVAS_H } from '../src/vic2.js';

const [, , prgPath, outPath, framesArg] = process.argv;
if (!prgPath || !outPath) {
  console.log('Usage: node run-prg-our-emulator.mjs <input.prg> <output.png> [frames=200]');
  process.exit(1);
}
const FRAMES = parseInt(framesArg) || 200;

// PNG encoder (matches the one in visual-tricks-spec-test.js).
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
function pngChunk(type, data) {
  const len = data.length;
  const out = Buffer.alloc(8 + len + 4);
  out.writeUInt32BE(len, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + len);
  return out;
}
function writePNG(name, fb32, w = CANVAS_W, h = CANVAS_H) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  let ri = 0;
  for (let y = 0; y < h; y++) {
    raw[ri++] = 0;
    for (let x = 0; x < w; x++) {
      const px = fb32[y * w + x] >>> 0;
      raw[ri++] = px & 0xFF;
      raw[ri++] = (px >> 8) & 0xFF;
      raw[ri++] = (px >> 16) & 0xFF;
    }
  }
  const idat = zlib.deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(name, png);
}

// Load ROMs + PRG.
const machine = new C64Machine();
machine.loadROMs({
  kernal:  fs.readFileSync('roms/kernal.bin'),
  basic:   fs.readFileSync('roms/basic.bin'),
  charRom: fs.readFileSync('roms/chargen.bin'),
});
const prg = fs.readFileSync(prgPath);
machine.loadPRG(prg);

// Boot KERNAL + BASIC (about 100 frames is plenty).
for (let i = 0; i < 100; i++) machine.runFrame();

// Parse the SYS target from the BASIC stub so arbitrary .prg files work,
// not just the SYS 2064 layout. Falls back to $080D (SYS 2061).
function parseSysTarget(buf) {
  for (let i = 2; i < Math.min(buf.length, 64); i++) {
    if (buf[i] === 0x9E) {
      let j = i + 1;
      while (j < buf.length && buf[j] === 0x20) j++;
      let n = 0, any = false;
      while (j < buf.length && buf[j] >= 0x30 && buf[j] <= 0x39) {
        n = n * 10 + (buf[j] - 0x30); j++; any = true;
      }
      if (any) return n;
    }
  }
  return null;
}
machine.cpu.pc = parseSysTarget(prg) ?? 0x080D;

// Run the requested number of frames so any cycle-56 trick / multiplexer
// has time to settle into a steady-state pattern.
for (let i = 0; i < FRAMES; i++) machine.runFrame();

writePNG(outPath, machine.vic2.fb32);
console.log(`wrote ${outPath} (${FRAMES} frames after PRG entry)`);
