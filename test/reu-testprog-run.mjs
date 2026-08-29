// Run a VICE REU testprog headlessly against our emulator and dump what the
// test put on screen. Most of these tests report by printing text, by turning
// the border green/red, or both, so a decoded text screen plus the border and
// background colours is far easier to triage than a PNG.
//
//   node test/reu-testprog-run.mjs <prg> [--size=512] [--frames=300]
//                                  [--image=<file.reu>] [--png=out.png] [--json]
//
// --size takes the same KiB values as VICE's -reusize (128…16384), or "none"
// to run with no expansion fitted.

import fs from 'fs';
import { C64Machine } from '../src/machine.js';
import { REU_MODELS } from '../src/reu.js';
import { CANVAS_W, CANVAS_H } from '../src/vic2.js';

const args = process.argv.slice(2);
const prgPath = args.find(a => !a.startsWith('--'));
const opt = (name, dflt) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const sizeArg = opt('size', '512');
const frames = +opt('frames', '300');
const bootFrames = +opt('boot', '200');
const pngOut = opt('png', null);
const asJson = args.includes('--json');

// Map a VICE -reusize value onto our model list.
function modelForSize(kb) {
  const m = REU_MODELS.find(x => x.kb === +kb);
  if (!m) throw new Error(`no REU model for ${kb} KiB (have ${REU_MODELS.map(x => x.kb).join(', ')})`);
  return m.id;
}

const m = new C64Machine();
m.loadROMs({
  kernal:  fs.readFileSync('roms/kernal.bin'),
  basic:   fs.readFileSync('roms/basic.bin'),
  charRom: fs.readFileSync('roms/chargen.bin'),
});
if (sizeArg !== 'none') m.attachReu(modelForSize(sizeArg));
m.reset();
// Preload expansion RAM after reset — powerUp() clears it. A few tests (the
// BluREU detection) check for a specific image rather than just the hardware.
const imageArg = opt('image', null);
if (imageArg && m.reu) m.reu.loadImage(new Uint8Array(fs.readFileSync(imageArg)));
for (let i = 0; i < bootFrames; i++) m.runFrame();

m.loadPRG(fs.readFileSync(prgPath));
m.injectRun();
for (let i = 0; i < frames; i++) m.runFrame();

// Where the VIC is actually fetching the video matrix from — some tests move
// the screen or the VIC bank, and dumping a hardcoded $0400 would show nothing.
const vicBank = (~m.cia2.read(0x00) & 0x03) << 14;
const screen = vicBank + (((m.vic2.regs[0x18] >> 4) & 0x0F) << 10);

// Screen codes 0-31 are @ A-Z [ £ ] ↑ ←, 32-63 are ASCII, the rest graphics.
function scr2asc(c) {
  const r = c & 0x7F;
  if (r < 32) return String.fromCharCode(r + 64);
  if (r < 64) return String.fromCharCode(r);
  return '·';
}

const rows = [];
for (let y = 0; y < 25; y++) {
  let line = '';
  for (let x = 0; x < 40; x++) line += scr2asc(m.mem.ram[screen + y * 40 + x]);
  rows.push(line.replace(/\s+$/, ''));
}

const COLOURS = ['black', 'white', 'red', 'cyan', 'purple', 'green', 'blue', 'yellow',
  'orange', 'brown', 'lt-red', 'dk-grey', 'grey', 'lt-green', 'lt-blue', 'lt-grey'];

const result = {
  prg: prgPath,
  reu: sizeArg,
  border: COLOURS[m.vic2.regs[0x20] & 0x0F],
  background: COLOURS[m.vic2.regs[0x21] & 0x0F],
  screenBase: '$' + screen.toString(16),
  rows,
};

if (pngOut) {
  const { PNG } = await import('pngjs');
  const png = new PNG({ width: CANVAS_W, height: CANVAS_H });
  png.data.set(m.vic2.frameBuffer);
  fs.writeFileSync(pngOut, PNG.sync.write(png));
}

if (asJson) {
  console.log(JSON.stringify(result));
} else {
  console.log(`${prgPath}  [REU ${sizeArg}]  border=${result.border} bg=${result.background} screen=${result.screenBase}`);
  console.log('    +' + '-'.repeat(40) + '+');
  for (const r of rows) console.log('    |' + r.padEnd(40) + '|');
  console.log('    +' + '-'.repeat(40) + '+');
}
