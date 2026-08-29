// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Unified perf/memory measurement across distinct demo workload types.
// Run from the repo root:
//   node --expose-gc tools/perf-workloads.mjs <workload> <mode> [frames]
//   (demo files resolve via test/external-assets.json)
//
// Workloads (three demo types + a fixed-overhead baseline):
//   idle       — BASIC READY prompt, blinking cursor (fixed emulator tax)
//   orbit      — Orbit Untold PRG: raster-trick/IRQ-heavy effect demo, no drive
//   rastertime — raster_time_gp D64 ($FFD5 trap load): gfx/badline per-pixel heavy
//   comaload   — Coma Light 13 side 1, TRUE DRIVE: the KERNAL serial LOAD"*",8,1
//                window (both CPUs in IEC lockstep)
//   comarun    — Coma Light 13 steady state ~30s after RUN, true drive attached
//                (trackmo: demo effects + drive clocked every cycle)
//   save       — TRUE DRIVE disk WRITE (no asset): mounts one writable blank .d64
//                and SAVEs a program on a cycle, so the profiler sees the write
//                head (drive1541 _advanceSpindle) + per-commit GCR decode (gcr)
//
// Modes:
//   time  — clean wall-clock ms/frame, median of REPS×BATCH (no profiler)
//   prof  — V8 sampling profile (100µs) → self-time by src file + top functions;
//           writes prof-<workload>.cpuprofile to the perf-profiles dir
//           (test/external-assets.json)
//   alloc — allocation rate KB/frame (chunked forced-gc heapUsed growth; needs --expose-gc)
//   mem   — typed-array/ArrayBuffer census by owner path + heap growth over a
//           2000-frame window (retained-leak check; needs --expose-gc)
//   all   — time + alloc + mem in one process (boot once)
import fs from 'fs';
import path from 'path';
import { Session } from 'inspector';
import { C64Machine } from '../src/machine.js';
import { D64, createBlankD64 } from '../src/d64.js';

// Demo disks live in your local C64 collection, NOT the repo: every path
// comes from test/external-assets.json (edit it, or set the per-entry env var).
import { assetPath, collectionDir, collectionFile } from '../test/external-assets.js';
const ORBIT = assetPath('orbit-untold-prg') ?? '';
const RASTER_TIME = assetPath('raster-time-demo') ?? '';
const COMA1 = collectionFile('c64stuff', 'd64/coma-light-13-by-oxyron/side1.d64');
const PROFILES = collectionDir('perf-profiles');

// `save` workload driver: mount one writable blank disk and SAVE a small BASIC
// program every CYCLE frames, committing at cycle end. A private frame counter
// advances once per m.runFrame() (see boot's runFrame wrapper) so it works under
// any measurement loop. One cached disk (re-blanked every 100 saves before the
// BAM fills) keeps the signal on the write head + commit decode, not fresh-disk
// encode churn.
function _pokeProg(m) {
  const prog = [0x07, 0x08, 0x0A, 0x00, 0x8F, 0x00, 0x00, 0x00];   // 10 REM
  for (let i = 0; i < prog.length; i++) m.mem.ram[0x0801 + i] = prog[i];
  m.mem.ram[0x2D] = 0x09; m.mem.ram[0x2E] = 0x08;                  // end-of-BASIC pointer
}
function _typeLine(m, text) {
  const s = text + '\r';
  for (let i = 0; i < s.length; i++) m.mem.ram[0x0277 + i] = s.charCodeAt(i) & 0xFF;
  m.mem.ram[0x00C6] = s.length;                                    // keyboard-buffer count
}
function makeSaveTick() {
  const CYCLE = 750;   // frames per SAVE+commit (a true-drive SAVE completes in <700)
  let f = 0, n = 0;
  return (m) => {
    const ph = f++ % CYCLE;
    if (ph === 0) {
      if (n > 0 && n % 100 === 0) m.setD64(createBlankD64('PERF', '01'));  // re-blank before it fills
      _pokeProg(m); m.mem.ram[0x90] = 0; _typeLine(m, `SAVE"F${n % 100}",8`); n++;
    } else if (ph === CYCLE - 1) {
      m.commitDriveWrites();                                       // fold head writes → image
    }
  };
}

const WORKLOADS = {
  idle:       { kind: 'none',      profFrames: 1000 },
  orbit:      { kind: 'prg',       file: ORBIT, settle: 300, profFrames: 600 },
  rastertime: { kind: 'd64trap',   file: RASTER_TIME, settle: 600, profFrames: 600 },
  comaload:   { kind: 'truedrive', file: COMA1, phase: 'load', profFrames: 900 },
  comarun:    { kind: 'truedrive', file: COMA1, phase: 'run', settle: 1500, profFrames: 900 },
  save:       { kind: 'save',      profFrames: 3000, tick: makeSaveTick() },
};

const workload = process.argv[2] || 'orbit';
const mode = process.argv[3] || 'all';
const W = WORKLOADS[workload];
if (!W) { console.error(`unknown workload ${workload}; one of ${Object.keys(WORKLOADS)}`); process.exit(2); }
if (W.kind !== 'none' && W.kind !== 'save' && !(W.file && fs.existsSync(W.file))) {
  console.error(`workload '${workload}' needs a demo file — edit test/external-assets.json (orbit-untold-prg, raster-time-demo, c64stuff) or set its env var`);
  process.exit(2);
}
const log = (s) => process.stderr.write(s + '\n');

// ── boot the machine into the workload's measurement window ──────────────
function boot() {
  const m = new C64Machine();
  m.loadROMs({
    kernal:  fs.readFileSync('roms/kernal.bin'),
    basic:   fs.readFileSync('roms/basic.bin'),
    charRom: fs.readFileSync('roms/chargen.bin'),
  });
  if (W.kind === 'truedrive' || W.kind === 'save') {
    m.attachDrive(fs.readFileSync('roms/1541.bin'));
    m.setTrueDrive(true);
  }
  m.reset();
  if (W.kind === 'truedrive' || W.kind === 'save') m.setSidModel(true); // UI default 8580
  if (W.kind === 'none') { for (let i = 0; i < 300; i++) m.runFrame(); return m; }
  if (W.kind === 'save') {
    const ram = m.mem.ram;
    const ready = () => ram[0x00C6] === 0 && ram[0x00CC] === 0 && ram[0x002C] === 0x08;
    let f = 0; while (!ready() && f < 800) { m.runFrame(); f++; }
    m.setD64(createBlankD64('PERF', '01'));                      // one writable blank disk
    for (let i = 0; i < 1600; i++) { W.tick(m); m.runFrame(); }  // warm up JIT + drive (~2 SAVEs)
    const raw = m.runFrame.bind(m);
    m.runFrame = () => { W.tick(m); return raw(); };             // drive SAVEs through the window
    return m;
  }
  if (W.kind === 'prg') {
    for (let i = 0; i < 200; i++) m.runFrame();
    m.loadPRG(fs.readFileSync(W.file));
    m.injectRun();
    for (let i = 0; i < W.settle; i++) m.runFrame();
    return m;
  }
  if (W.kind === 'd64trap') {
    m.setD64(new D64(new Uint8Array(fs.readFileSync(W.file))));
    for (let i = 0; i < 200; i++) m.runFrame();
    m.injectLoadAndRun();
    for (let i = 0; i < W.settle; i++) m.runFrame();
    return m;
  }
  // truedrive — the demo-status board's chunked UI load path
  m.setD64(new D64(new Uint8Array(fs.readFileSync(W.file))));
  const ram = m.mem.ram;
  const ready = () => ram[0x00C6] === 0 && ram[0x00CC] === 0 && ram[0x002C] === 0x08;
  let f = 0; while (!ready() && f < 800) { m.runFrame(); f++; }
  { const cmd = 'LOAD"*",8,1\r'; let p = 0; while (p < cmd.length) { p += m.bufferKeyboardText(cmd.slice(p)); m.runFrame(); f++; } }
  if (W.phase === 'load') return m; // measurement window IS the serial load
  // phase 'run': wait for the load to finish, then RUN + settle into the demo
  let busy = false, loaded = false;
  while (f < 6000 && !loaded) { m.runFrame(); f++; if (!ready()) busy = true; else if (busy) loaded = true; }
  if (!loaded) log('WARN: load did not finish within 6000 frames');
  m.bufferKeyboardText('RUN\r');
  for (let i = 0; i < W.settle; i++) m.runFrame();
  return m;
}

const hr = () => process.hrtime.bigint();
const msSince = (t0) => Number(hr() - t0) / 1e6;

// ── modes ─────────────────────────────────────────────────────────────────
function runTime(m) {
  const BATCH = 300, REPS = 9, times = [];
  for (let r = 0; r < REPS; r++) {
    const t0 = hr();
    for (let i = 0; i < BATCH; i++) m.runFrame();
    times.push(msSince(t0) / BATCH);
  }
  times.sort((a, b) => a - b);
  const med = times[(times.length - 1) >> 1];
  log(`TIME ${workload}: median=${med.toFixed(3)} ms/frame  best=${times[0].toFixed(3)}  ` +
      `(${(1000 / med).toFixed(0)} fps = ${(1000 / med / 50).toFixed(1)}× realtime)  ` +
      `all=[${times.map(t => t.toFixed(2)).join(', ')}]`);
}

async function runProf(m) {
  const N = parseInt(process.argv[4] || String(W.profFrames), 10);
  const session = new Session();
  session.connect();
  const post = (method, params) => new Promise((res, rej) =>
    session.post(method, params, (err, r) => err ? rej(err) : res(r)));
  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', { interval: 100 });
  await post('Profiler.start');
  const t0 = hr();
  for (let i = 0; i < N; i++) m.runFrame();
  const wall = msSince(t0);
  const { profile } = await post('Profiler.stop');
  fs.mkdirSync(PROFILES, { recursive: true });
  fs.writeFileSync(path.join(PROFILES, `prof-${workload}.cpuprofile`), JSON.stringify(profile));
  log(`PROF ${workload}: ${N} frames in ${wall.toFixed(0)}ms = ${(wall / N).toFixed(3)} ms/frame (profiler on)`);

  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);
  const selfHits = new Map();
  for (const id of profile.samples) selfHits.set(id, (selfHits.get(id) || 0) + 1);
  const total = profile.samples.length;
  const byFn = new Map(), byFile = new Map();
  for (const [id, hits] of selfHits) {
    const n = byId.get(id); if (!n) continue;
    const cf = n.callFrame;
    const file = cf.url ? cf.url.split('/').pop() : (cf.functionName || '(v8)');
    const fnKey = `${cf.functionName || '(anon)'}  ${file}:${cf.lineNumber + 1}`;
    byFn.set(fnKey, (byFn.get(fnKey) || 0) + hits);
    // bucket v8 meta-frames ((garbage collector), (program), (idle)) by their name
    const bucket = cf.url ? file : `[${cf.functionName || 'v8'}]`;
    byFile.set(bucket, (byFile.get(bucket) || 0) + hits);
  }
  log(`\n== ${workload}: self-time by file (${total} samples) ==`);
  for (const [k, h] of [...byFile.entries()].sort((a, b) => b[1] - a[1]))
    if (h / total > 0.001) log(`${(100 * h / total).toFixed(2).padStart(7)}%  ${k}`);
  log(`\n== ${workload}: top functions ==`);
  for (const [k, h] of [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40))
    log(`${(100 * h / total).toFixed(2).padStart(7)}%  ${k}`);
}

// Sampling heap profiler → which call sites allocate (statistical, live run).
async function runAllocSites(m) {
  const N = parseInt(process.argv[4] || String(W.profFrames), 10);
  const session = new Session();
  session.connect();
  const post = (method, params) => new Promise((res, rej) =>
    session.post(method, params, (err, r) => err ? rej(err) : res(r)));
  await post('HeapProfiler.enable');
  // include*CollectedBy*: without these the report shows only LIVE objects at
  // stop — short-lived churn (the interesting part) vanishes.
  await post('HeapProfiler.startSampling', {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let i = 0; i < N; i++) m.runFrame();
  const { profile } = await post('HeapProfiler.stopSampling');
  const byFn = new Map();
  let total = 0;
  (function walk(node) {
    const cf = node.callFrame;
    const size = node.selfSize || 0;
    if (size > 0) {
      const key = `${cf.functionName || '(anon)'}  ${(cf.url || '').split('/').pop()}:${cf.lineNumber + 1}`;
      byFn.set(key, (byFn.get(key) || 0) + size);
      total += size;
    }
    for (const c of node.children || []) walk(c);
  })(profile.head);
  log(`\nALLOCSITES ${workload}: ${(total / 1024 / 1024).toFixed(2)} MiB / ${N} frames = ${(total / N / 1024).toFixed(1)} KiB/frame`);
  for (const [k, v] of [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15))
    log(`${(100 * v / total).toFixed(1).padStart(6)}%  ${(v / 1024).toFixed(0).padStart(8)} KiB  ${k}`);
}

function runAlloc(m) {
  if (!global.gc) { log('alloc mode needs --expose-gc'); return; }
  const FRAMES = 1500, CHUNK = 20;
  let allocBytes = 0, done = 0;
  while (done < FRAMES) {
    const n = Math.min(CHUNK, FRAMES - done);
    global.gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < n; i++) m.runFrame();
    const h1 = process.memoryUsage().heapUsed;
    if (h1 > h0) allocBytes += (h1 - h0);
    done += n;
  }
  log(`ALLOC ${workload}: ${(allocBytes / FRAMES / 1024).toFixed(2)} KB/frame  (${(allocBytes / 1e6).toFixed(1)} MB over ${FRAMES} frames)`);
}

// Walk the machine object graph; census every ArrayBuffer (deduped by buffer
// identity) and big plain arrays. Skips accessor properties (no getter side
// effects). Reports top owners by bytes.
function runMem(m) {
  const seen = new Set(), bufs = new Map(), bigArrays = [];
  const stack = [[m, 'm']];
  while (stack.length) {
    const [obj, path] = stack.pop();
    if (obj === null || typeof obj !== 'object' || seen.has(obj)) continue;
    seen.add(obj);
    if (ArrayBuffer.isView(obj)) {
      const b = obj.buffer;
      const e = bufs.get(b) || { bytes: b.byteLength, paths: [] };
      if (e.paths.length < 2) e.paths.push(`${path} (${obj.constructor.name}×${obj.length})`);
      bufs.set(b, e);
      continue;
    }
    if (obj instanceof ArrayBuffer) {
      const e = bufs.get(obj) || { bytes: obj.byteLength, paths: [] };
      if (e.paths.length < 2) e.paths.push(path);
      bufs.set(obj, e);
      continue;
    }
    if (Array.isArray(obj) && obj.length >= 4096)
      bigArrays.push({ path, len: obj.length, t: typeof obj[0] });
    const names = Object.getOwnPropertyNames(obj);
    for (const k of names) {
      const d = Object.getOwnPropertyDescriptor(obj, k);
      if (!d || !('value' in d)) continue; // skip getters
      stack.push([d.value, `${path}.${k}`]);
    }
  }
  const list = [...bufs.values()].sort((a, b) => b.bytes - a.bytes);
  const totalAB = list.reduce((s, e) => s + e.bytes, 0);
  log(`\nMEM ${workload}: ${list.length} distinct ArrayBuffers reachable from machine = ${(totalAB / 1e6).toFixed(2)} MB`);
  for (const e of list.slice(0, 30))
    log(`${(e.bytes / 1024).toFixed(1).padStart(10)} KB  ${e.paths.join('  |  ')}`);
  if (bigArrays.length) {
    log(`-- plain JS arrays ≥4096 elems (est. 8B+/elem) --`);
    for (const a of bigArrays.sort((x, y) => y.len - x.len).slice(0, 20))
      log(`${String(a.len).padStart(10)}  ${a.path}  (elem: ${a.t})`);
  }
  const mu = process.memoryUsage();
  log(`process: rss=${(mu.rss / 1e6).toFixed(0)}MB heapUsed=${(mu.heapUsed / 1e6).toFixed(1)}MB external=${(mu.external / 1e6).toFixed(1)}MB arrayBuffers=${(mu.arrayBuffers / 1e6).toFixed(1)}MB`);

  if (global.gc) {                       // retained-growth (leak) check
    global.gc(); global.gc();
    const h0 = process.memoryUsage().heapUsed, a0 = process.memoryUsage().arrayBuffers;
    for (let i = 0; i < 2000; i++) m.runFrame();
    global.gc(); global.gc();
    const h1 = process.memoryUsage().heapUsed, a1 = process.memoryUsage().arrayBuffers;
    log(`LEAK ${workload}: heapUsed ${((h1 - h0) / 1024).toFixed(0)} KB, arrayBuffers ${((a1 - a0) / 1024).toFixed(0)} KB retained over 2000 frames (post-gc)`);
  }
}

// ── main ──────────────────────────────────────────────────────────────────
const tBoot = hr();
const m = boot();
log(`boot(${workload}) took ${(msSince(tBoot) / 1000).toFixed(1)}s wall`);
if (mode === 'time') runTime(m);
else if (mode === 'prof') await runProf(m);
else if (mode === 'alloc') runAlloc(m);
else if (mode === 'allocsites') await runAllocSites(m);
else if (mode === 'mem') runMem(m);
else if (mode === 'all') { runTime(m); runAlloc(m); runMem(m); }
else { console.error(`unknown mode ${mode}`); process.exit(2); }
