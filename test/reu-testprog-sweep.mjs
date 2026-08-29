// Sweep the VICE REU testprogs against our emulator and tabulate the results.
//
//   node test/reu-testprog-sweep.mjs [--dir=<path>] [--only=<substr>]
//                                    [--size=512] [--frames=300] [--out=<file>]
//
// Each test is booted on a fresh machine with an REU fitted, run for a while,
// then read back: the border colour (most of these signal pass/fail with it)
// plus the decoded text screen (the rest print their findings).
//
// Classification is deliberately conservative — border green/red is only taken
// as a verdict for the tests whose readme documents that convention; everything
// else is reported as INSPECT with its screen so a human can judge.

import fs from 'fs';
import path from 'path';
import { C64Machine } from '../src/machine.js';
import { REU_MODELS } from '../src/reu.js';
import { assetPath } from './external-assets.js';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const hit = args.find(a => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const ROOT = opt('dir', assetPath('reu-testprogs-dir'));
if (!ROOT) {
  console.log('skip – REU testprogs not found (see test/external-assets.json)');
  process.exit(0);
}
const ONLY = opt('only', null);
const FRAMES = +opt('frames', '300');
const BOOT = +opt('boot', '200');
const DEFAULT_SIZE = +opt('size', '512');

const ROMS = {
  kernal:  fs.readFileSync('roms/kernal.bin'),
  basic:   fs.readFileSync('roms/basic.bin'),
  charRom: fs.readFileSync('roms/chargen.bin'),
};

// Per-directory REU size where the readme calls for something specific, and
// which directories are out of scope for a PAL C64 emulator.
const SIZE_FOR_DIR = { floatingbus: 256, raminitpattern: 256 };
const SKIP_DIR = {
  c128: 'C128-only test (we emulate a PAL C64)',
  ramlink: 'targets CMD RAMLink hardware, not a plain REU',
};

// Tests whose readme documents "green border = pass". `mirrors` is deliberately
// absent: its readme reports through the bank count and size printed top-left,
// and its border carries no verdict.
const BORDER_VERDICT = /^(colorram|ioglitch|misc\/wheels|reudetect|cpuport|64ktransfer)/;

// Some programs are written for one specific unit — mirrors<N> names the size it
// expects, and running it against anything else fails by construction.
function sizeForFile(rel, dirDefault) {
  const m = /mirrors(\d+)(k|m)\.prg$/i.exec(rel);
  if (m) return +m[1] * (m[2].toLowerCase() === 'm' ? 1024 : 1);
  return dirDefault;
}

const COLOURS = ['black', 'white', 'red', 'cyan', 'purple', 'green', 'blue', 'yellow',
  'orange', 'brown', 'lt-red', 'dk-grey', 'grey', 'lt-green', 'lt-blue', 'lt-grey'];

function scr2asc(c) {
  const r = c & 0x7F;
  if (r < 32) return String.fromCharCode(r + 64);
  if (r < 64) return String.fromCharCode(r);
  return '·';
}

// reudetect checks for BluREU's data file, not just for the hardware, so it
// only reaches green with that image loaded (its readme says so).
const BLUREU = assetPath('blureu-image');

function runOne(prgPath, sizeKb, image) {
  const model = REU_MODELS.find(x => x.kb === sizeKb);
  const m = new C64Machine();
  m.loadROMs(ROMS);
  if (model) m.attachReu(model.id);
  m.reset();
  // After reset — powerUp() clears expansion RAM.
  if (image && m.reu) m.reu.loadImage(new Uint8Array(fs.readFileSync(image)));
  for (let i = 0; i < BOOT; i++) m.runFrame();
  m.loadPRG(fs.readFileSync(prgPath));
  m.injectRun();
  for (let i = 0; i < FRAMES; i++) m.runFrame();

  const vicBank = (~m.cia2.read(0x00) & 0x03) << 14;
  const screen = vicBank + (((m.vic2.regs[0x18] >> 4) & 0x0F) << 10);
  const rows = [];
  for (let y = 0; y < 25; y++) {
    let line = '';
    for (let x = 0; x < 40; x++) line += scr2asc(m.mem.ram[screen + y * 40 + x]);
    rows.push(line.replace(/\s+$/, ''));
  }
  return {
    border: m.vic2.regs[0x20] & 0x0F,
    background: m.vic2.regs[0x21] & 0x0F,
    rows,
    blank: rows.every(r => r.trim() === ''),
  };
}

const prgs = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.prg')) prgs.push(p);
  }
})(ROOT);
prgs.sort();

const results = [];
for (const prg of prgs) {
  const rel = path.relative(ROOT, prg);
  const dir = rel.split(path.sep)[0];
  if (ONLY && !rel.includes(ONLY)) continue;
  if (SKIP_DIR[dir]) { results.push({ rel, verdict: 'SKIP', note: SKIP_DIR[dir] }); continue; }

  const wantsBluReu = dir === 'reudetect';
  if (wantsBluReu && !BLUREU) {
    results.push({ rel, verdict: 'SKIP', note: 'needs blu.reu (see test/external-assets.json)' });
    continue;
  }
  const size = wantsBluReu ? 16384 : sizeForFile(rel, SIZE_FOR_DIR[dir] || DEFAULT_SIZE);
  let r;
  try {
    r = runOne(prg, size, wantsBluReu ? BLUREU : null);
  } catch (err) {
    results.push({ rel, verdict: 'ERROR', note: err.message });
    continue;
  }

  let verdict = 'INSPECT';
  if (BORDER_VERDICT.test(rel)) {
    if (r.border === 5) verdict = 'PASS';
    else if (r.border === 2 || r.border === 10 || r.border === 7) verdict = 'FAIL';
  }
  results.push({
    rel, size, verdict,
    border: COLOURS[r.border],
    rows: r.rows,
    blank: r.blank,
  });
  process.stderr.write(`${verdict.padEnd(7)} ${rel} [${size}K] border=${COLOURS[r.border]}\n`);
}

fs.writeFileSync(opt('out', 'reu-testprog-results.json'), JSON.stringify(results, null, 1));

const tally = {};
for (const r of results) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
console.log('\n=== TALLY ===');
for (const [k, v] of Object.entries(tally).sort()) console.log(`${k.padEnd(8)} ${v}`);
console.log(`total ${results.length}`);
