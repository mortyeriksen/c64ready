// Pre-commit visual sanity check.
//
// Runs a fixed set of reference demos headless and dumps periodic PNGs into
// the commit-screenshots-out dir (test/external-assets.json) at a per-demo cadence (default every 2 s
// for 15 shots; nine, raster_time_gp and orbit_untold for 30 shots — see
// DEMOS). A "second" here is FRAMES_PER_SEC frames. No on-image overlay: the
// demo name, shot index, and run timestamp are all in the filename
// (<demo>-sNN-<timestamp>.png).
// Eyeball these before committing any render/timing change to catch visual
// regressions the spec tests + the Orbit framebuffer hash don't cover (a demo
// can break in a phase no automated check reaches — see the FAIRLIGHT skew).
//
// This is NOT a spec test: the filename is *.mjs (not *-test.js), so the
// all-test.js runner does not gather it, and it does no asserting — it just
// produces images for a human to review. It never deletes existing screenshots;
// after each run it diffs against the previous run and writes magenta-tinted
// diff PNGs for changed shots. See docs/TESTING.md for the workflow.
//
// Usage: node test/commit-screenshots.mjs [steps]   (default 15)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import { C64Machine } from '../src/machine.js';
import { D64 } from '../src/d64.js';
import { CANVAS_W, CANVAS_H } from '../src/vic2.js';
import { assetPath, collectionDir } from './external-assets.js';

const selfPath = fileURLToPath(import.meta.url);
const here = path.dirname(selfPath);
const repo = path.resolve(here, '..');
// External demo collection root — declared in test/external-assets.json
// ("collections" → c64stuff); missing files are per-demo SKIPs below.
const EXTRA = collectionDir('c64stuff');

const FRAMES_PER_SEC = 50;                     // PAL ~50 fps (2 s = 100 frames, 5 s = 250 frames)
const BOOT_FRAMES = 200;                       // KERNAL/BASIC boot to READY.
const OUT = collectionDir('commit-screenshots-out');

// Per-demo capture cadence: a screenshot every `everySec` seconds, `shots`
// times. Default = every 2 s, 15 shots. nine, raster_time_gp and orbit_untold
// run for 30 shots (nine every 5 s; the other two every 2 s). type 'prg' →
// loadPRG + injectRun; 'd64' → setD64 + injectLoadAndRun (fast $FFD5 trap load,
// no true drive).
const DEFAULT_EVERY_SEC = 2;
const DEFAULT_SHOTS = 15;
const DEMOS = [
  { name: 'nine',           type: 'prg', file: `${EXTRA}/prg/nine.prg`,                   everySec: 5, shots: 30 },
  { name: 'fppscroller',    type: 'prg', file: assetPath('fppscroller-prg') ?? '' },
  { name: 'raster_time_gp', type: 'd64', file: `${EXTRA}/d64/raster_time_gp.d64`,          shots: 30 },
  { name: '3ad_grey_dots',  type: 'prg', file: `${EXTRA}/prg/3AD_No_more_grey_dots_4k.prg` },
  { name: 'raster_bar',     type: 'prg', file: `${EXTRA}/prg/raster-bar-11124b0b.prg` },
  { name: 'cubicdream',     type: 'prg', file: `${EXTRA}/prg/cubicdream.prg` },
  { name: 'copperbooze',    type: 'prg', file: `${EXTRA}/prg/CopperBooze.prg` },
  { name: 'orbit_untold',   type: 'prg', file: assetPath('orbit-untold-prg') ?? '',        shots: 30 },
  { name: 'oneder_oxyron',  type: 'prg', file: `${EXTRA}/prg/oneder_oxyron/Oneder_Oxyron.prg`, shots: 30, keys: 'D' },
];

const roms = {
  kernal:  fs.readFileSync(`${repo}/roms/kernal.bin`),
  basic:   fs.readFileSync(`${repo}/roms/basic.bin`),
  charRom: fs.readFileSync(`${repo}/roms/chargen.bin`),
};

// Write the framebuffer to a PNG. No on-image overlay — the demo, shot index,
// and run timestamp are all in the filename.
function shot(m, file) {
  const png = new PNG({ width: CANVAS_W, height: CANVAS_H });
  png.data.set(m.vic2.frameBuffer);
  fs.writeFileSync(file, PNG.sync.write(png));
}

// Wall-clock run tag embedded in every PNG's filename so successive runs
// don't overwrite each other — a before/after pair coexists in the dir. The
// parent computes it once and hands it to the per-demo workers via CS_NOW so
// every PNG of one run shares the same tag. (Not drawn on the image; the
// on-image overlay is just "<demo> F<frame> <sec>S".)
const _now = process.env.CS_NOW || new Date().toISOString().slice(0, 19); // 2026-05-31T22:15:00
const RUN_TAG = _now.replace(/[-:]/g, '').replace('T', '-');              // filename: 20260531-221500

function runDemo(d) {
  if (!fs.existsSync(d.file)) {
    console.log(`SKIP  ${d.name.padEnd(15)} — file not found: ${d.file || '(no path in test/external-assets.json)'}`);
    return false;
  }
  const m = new C64Machine();
  m.loadROMs({
    kernal:  Buffer.from(roms.kernal),
    basic:   Buffer.from(roms.basic),
    charRom: Buffer.from(roms.charRom),
  });
  m.reset();
  // Opt-in A/B of the gated render optimisations for visual review (env so the
  // default stays untouched): CS_DEDUP=1 → capture-state dedup, CS_VERIFY=1 →
  // assert each aliased snapshot still matches the live source.
  // Symmetric (=1 force on, =0 force off) so an A/B run can disable the three
  // gated render optimisations (batchRender, captureDedup, spriteSkipIdle) and
  // confirm they're transparent vs the per-cycle/no-skip path.
  if (process.env.CS_DEDUP === '1') m.vic2.captureDedup = true;
  if (process.env.CS_DEDUP === '0') m.vic2.captureDedup = false;
  if (process.env.CS_VERIFY === '1') m.vic2.captureDedupVerify = true;
  if (process.env.CS_SPRSKIP === '1') m.vic2.spriteSkipIdle = true;
  if (process.env.CS_SPRSKIP === '0') m.vic2.spriteSkipIdle = false;
  if (process.env.CS_BATCH === '1') m.vic2.batchRender = true;
  if (process.env.CS_BATCH === '0') m.vic2.batchRender = false;
  // CS_NOGARBAGE=1 → disable the $163/$164 sprite boundary garbage (pre-fix
  // baseline) so a diff isolates exactly what that feature changed.
  if (process.env.CS_NOGARBAGE === '1') m.vic2.spriteBoundaryGarbage = false;
  if (d.type === 'd64') {
    m.setD64(new D64(new Uint8Array(fs.readFileSync(d.file))));
    for (let i = 0; i < BOOT_FRAMES; i++) m.runFrame();
    m.injectLoadAndRun();   // LOAD"*",8,1 → $FFD5 trap → auto-RUN
  } else {
    for (let i = 0; i < BOOT_FRAMES; i++) m.runFrame();
    m.loadPRG(fs.readFileSync(d.file));
    m.injectRun();
  }
  // Some demos open on a start menu and wait for a keypress (e.g. Oneder
  // wants 'D' to begin). Warm up so the menu's GETIN loop is running, then
  // feed the key(s) via the KERNAL keyboard buffer; the shot loop below then
  // captures the demo proper, not the menu. (keysAtSec is in real seconds.)
  if (d.keys) {
    const warmup = (d.keysAtSec ?? 2) * FRAMES_PER_SEC;
    for (let f = 0; f < warmup; f++) m.runFrame();
    m.bufferKeyboardText(d.keys);
  }
  const everySec = d.everySec ?? DEFAULT_EVERY_SEC;
  const shots = d.shots ?? DEFAULT_SHOTS;
  const everyFrames = everySec * FRAMES_PER_SEC;
  for (let s = 1; s <= shots; s++) {
    for (let f = 0; f < everyFrames; f++) m.runFrame();
    const fname = `${d.name}-s${String(s).padStart(2, '0')}-${RUN_TAG}.png`;
    shot(m, path.join(OUT, fname));
  }
  console.log(`OK    ${d.name.padEnd(15)} — ${shots} pngs (every ${everySec}s)`);
  return true;
}

// Runs accumulate: each PNG's filename carries the run timestamp (RUN_TAG),
// so a before/after pair coexists for comparison. Clean the dir manually when
// it gets noisy.
fs.mkdirSync(OUT, { recursive: true });

// Auto-diff the just-written run against the most recent PREVIOUS run, per
// (demo, shot). Filenames are `<demo>-s<NN>-<YYYYMMDD-HHMMSS>.png`; demo names
// contain no '-', so splitting on '-' gives [demo, sNN, date, time.png] and the
// RUN_TAG is the last two joined. For each (demo,sNN) we compare the current
// run's PNG to the newest older RUN_TAG and report differing-pixel counts.
// A per-shot diff image (changed pixels tinted magenta) is written as
// diff-<demo>-s<NN>.png so a regression is eyeballable, not just a number.
function diffAgainstPrevious(currentTag) {
  let files;
  try { files = fs.readdirSync(OUT); } catch { return; }
  // group[key] = { tag -> filename }
  const group = new Map();
  for (const f of files) {
    if (!f.endsWith('.png') || f.startsWith('diff-')) continue;
    const parts = f.slice(0, -4).split('-');         // strip .png
    if (parts.length < 4) continue;
    const tag = parts.slice(-2).join('-');           // YYYYMMDD-HHMMSS
    const key = parts.slice(0, -2).join('-');         // <demo>-sNN
    if (!group.has(key)) group.set(key, new Map());
    group.get(key).set(tag, f);
  }
  const everySecOf = {};       // demo -> seconds between shots (for the seconds tag)
  for (const d of DEMOS) everySecOf[d.name] = d.everySec ?? DEFAULT_EVERY_SEC;
  const perDemo = new Map();   // demo -> {changedShots, totalPixels, maxPixels, shots[]}
  let comparisons = 0;
  for (const [key, tags] of group) {
    if (!tags.has(currentTag)) continue;
    const others = [...tags.keys()].filter(t => t !== currentTag).sort();
    if (!others.length) continue;                    // no previous run yet
    const prevTag = others[others.length - 1];        // newest older run
    const demo = key.replace(/-s\d+$/, '');
    let cur, prev;
    try {
      cur = PNG.sync.read(fs.readFileSync(path.join(OUT, tags.get(currentTag))));
      prev = PNG.sync.read(fs.readFileSync(path.join(OUT, tags.get(prevTag))));
    } catch { continue; }
    comparisons++;
    if (cur.width !== prev.width || cur.height !== prev.height) {
      const e = perDemo.get(demo) || { changedShots: 0, totalPixels: 0, maxPixels: 0, dim: true };
      e.dim = true; perDemo.set(demo, e);
      continue;
    }
    let changed = 0;
    const diffImg = new PNG({ width: cur.width, height: cur.height });
    for (let i = 0; i < cur.data.length; i += 4) {
      const same = cur.data[i] === prev.data[i] && cur.data[i + 1] === prev.data[i + 1]
        && cur.data[i + 2] === prev.data[i + 2];
      if (same) {
        // dim the unchanged pixel so changes pop
        diffImg.data[i] = cur.data[i] >> 2; diffImg.data[i + 1] = cur.data[i + 1] >> 2;
        diffImg.data[i + 2] = cur.data[i + 2] >> 2; diffImg.data[i + 3] = 255;
      } else {
        changed++;
        diffImg.data[i] = 255; diffImg.data[i + 1] = 0; diffImg.data[i + 2] = 255; diffImg.data[i + 3] = 255;
      }
    }
    const e = perDemo.get(demo) || { changedShots: 0, totalPixels: 0, maxPixels: 0, shots: [] };
    if (changed > 0) {
      e.changedShots++; e.totalPixels += changed; e.maxPixels = Math.max(e.maxPixels, changed);
      const sm = key.match(/-s(\d+)$/); e.shots.push(sm ? +sm[1] : 0);
      fs.writeFileSync(path.join(OUT, `diff-${key}.png`), PNG.sync.write(diffImg));
    }
    perDemo.set(demo, e);
  }
  if (!comparisons) {
    console.log(`\ndiff: no previous run found in ${OUT} — captured a baseline.`);
    return;
  }
  console.log(`\ndiff vs previous run (${comparisons} shot-pairs compared):`);
  let anyChange = false;
  for (const [demo, e] of [...perDemo].sort((a, b) => b[1].totalPixels - a[1].totalPixels)) {
    if (e.dim) { console.log(`  ${demo.padEnd(16)} DIMENSION CHANGE`); anyChange = true; continue; }
    if (e.changedShots === 0) { console.log(`  ${demo.padEnd(16)} identical`); continue; }
    anyChange = true;
    const es = everySecOf[demo] ?? DEFAULT_EVERY_SEC;
    const secs = e.shots.sort((a, b) => a - b).map(n => `${n * es}s`).join(', ');
    console.log(`  ${demo.padEnd(16)} CHANGED at ${secs}  (${e.totalPixels} px total, ${e.maxPixels} px worst — see diff-${demo}-sNN.png)`);
  }
  if (!anyChange) console.log('  all shots identical to the previous run ✓');
}

// Two modes. The demos are independent, so the parent forks one worker per
// demo (capped at CPU count) and they render in parallel — ~Nx faster than
// serial. A worker (`--only <idx>`) renders exactly one demo.
const onlyArg = process.argv.indexOf('--only');
const onlyIdx = onlyArg >= 0 ? parseInt(process.argv[onlyArg + 1], 10) : -1;

if (onlyIdx >= 0) {
  // Worker: render a single demo, then exit.
  runDemo(DEMOS[onlyIdx]);
} else {
  // Parent: fork a pool of workers.
  const pool = Math.max(1, Math.min(DEMOS.length, (os.cpus()?.length || 4)));
  console.log(`commit-screenshots → ${OUT}`);
  console.log(`(${CANVAS_W}×${CANVAS_H}, ${DEMOS.length} demos, ${pool} parallel; nine 30×5s, raster_time/orbit/oneder 30×2s, rest 15×2s)\n`);
  const t0 = Date.now();
  let next = 0, active = 0, finished = 0;
  const launch = () => {
    while (active < pool && next < DEMOS.length) {
      const idx = next++;
      active++;
      const child = fork(selfPath, ['--only', String(idx)], {
        stdio: 'inherit',
        env: { ...process.env, CS_NOW: _now },
      });
      child.on('exit', () => {
        active--; finished++;
        if (finished === DEMOS.length) {
          console.log(`\ndone: ${DEMOS.length} demos in ${((Date.now() - t0) / 1000).toFixed(0)}s → review ${OUT} before committing.`);
          diffAgainstPrevious(RUN_TAG);
        } else {
          launch();
        }
      });
    }
  };
  launch();
}
