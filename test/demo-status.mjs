// One-shot crash/hang status board for the README open-bug demos. Boots each
// disc-1 D64 headless (true drive, SID 8580 to match the UI default), LOAD"*",8,1
// + RUN, runs to a frame cap, and classifies the outcome:
//   • CRASH — cpu.halted / JAM ($02/$12) / stuck-low-PC loop (the only RELIABLE
//     headless crash signal); reports the opcode + PC + time.
//   • RUNS  — no crash through the cap. PC-sampling CANNOT detect a silent hang
//     (an interrupt-driven demo legitimately spins its main thread at one PC),
//     so liveness uses the FRAMEBUFFER: a frozen display is flagged
//     "DISPLAY FROZEN" as the only honest "possible silent hang" hint.
// Compares to the known/expected status (✓ / ✗ CHANGED — a regression detector)
// and writes a screenshot per demo to the demo-status-shots dir (test/external-assets.json).
//
// SID model: matches the UI's 8580 default (a 6581 default trips demos built for
// the 8580, e.g. Lunatico's "old SID detected" prompt). Override: SID=6581.
//
// Multi-disc demos boot their CRASH disc directly (Mojo disc 4, Aloft disc 2).
//
// Forks one worker per demo (parallel, capped). Run from the repo root:
//   node test/demo-status.mjs            # all demos
//   node test/demo-status.mjs coma next  # only matching names
//   SID=6581 node test/demo-status.mjs   # force the original 6581 SID
import fs from 'fs';
import path from 'path';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { collectionFile, collectionDir } from './external-assets.js';

const selfPath = fileURLToPath(import.meta.url);
const CAP = 6;                       // concurrent workers

// Disk images live in the local collections declared in
// test/external-assets.json ("collections") — edit the roots there.
const c64 = (rel) => collectionFile('c64stuff', rel);
const a64 = (rel) => collectionFile('assembly64', rel);

const DEMOS = [
  { name: 'The Hat',        disc: 'A', d64: c64('d64/05 the hat - flt & gp/the-hat-7a825b1-a.d64'),          frames: 24000, expect: 'RUNS',         note: 'runs through clean; 12/13-sprite wide-scroller artifacts (left-edge clip + 2/3 phantom) FIXED 2026-07-15 by the pre-canvas sweep rule (user-confirmed)' },
  { name: 'Lunatico',       disc: '1', d64: c64('d64/lft-lunatico/lft-lunatico-side1.d64'),                  frames: 24000, expect: 'RUNS',         note: 'OFFENCE gray block FIXED 2026-07-03 (sprite-data collisions under the CSEL border feed the scene\'s crunch engine)' },
  { name: 'Coma Light',     disc: '1', d64: c64('d64/coma-light-13-by-oxyron/side1.d64'),                    frames: 24000, expect: 'RUNS',          note: 'mole-scene JAM (~266s $390f) FIXED 2026-07-02 by the drive true-clock ratio + CIA plain-START count-hold (masks OFF); runs clean from boot, offset-A map matches VICE. End comic/credits garble GONE (user-confirmed 2026-07-02, after the _pollI CLI/SEI/PLP poll fix 49528d8 + SH drop-off 494e285).' },
  { name: 'Coma Light',     disc: '2', d64: c64('d64/coma-light-13-by-oxyron/side2.d64'),                    frames: 26000, expect: 'RUNS',         note: 'disc 2: plays its full 520s window end-to-end on the ratio+CIA-hold main (masks OFF).' },
  { name: 'Next Round',     disc: '1', d64: c64('d64/next_round_performers_2026/round1.d64'),                frames: 24000, expect: 'RUNS',         note: 'JAM $5f60 ~260s FIXED by the drive true-clock ratio (eb31124): the 1:1 lockstep froze a fatal load phase; A/B-attributed via the twin boards 2026-07-02.' },
  { name: 'Codeboys&End',   disc: '1', d64: a64('Codeboys & Endians/CodeboysAndEndians_1.d64'),              frames: 24000, expect: 'RUNS',         note: '$177b NMI-preempt KIL FIXED (clears _deferredIrq on NMI); runs clean to 140s+. left-edge render artifacts remain (not a crash)' },
  { name: 'Deus Ex Mach',   disc: '1', d64: c64('d64/crest-deusexmachina/deus-s1.d64'),                      frames: 24000, expect: 'RUNS',         note: 'hyperscreen image renders without a right-edge XSCROLL seam' },
  { name: 'Aloft',          disc: '2', d64: c64('d64/Aloft/Aloft-Side2.d64'),                                frames: 24000, expect: 'RUNS',         note: 'disc 2: runs end-to-end to the animated NEXT DISK prompt (700s retest 2026-07-02; the old purple-screen crash is gone).' },
  { name: 'Aloft',          disc: '3', d64: c64('d64/Aloft/Aloft-Side3.d64'),                                frames: 24000,  expect: 'RUNS', note: 'disc 3: runs end-to-end into the credits scroll (700s retest 2026-07-02; the old black+SID-beep crash is gone).' },
  { name: 'Mojo',           disc: '4', d64: a64('Mojo/Mojo_Side4.D64'),                                      frames: 24000, expect: 'RUNS',          note: 'runs the full demo and exits cleanly to the BASIC READY prompt (user-confirmed 2026-07-06); the board reports "completed → BASIC". Earlier this was misread as a CRASH: after the demo resets to BASIC the CPU idles in the KERNAL cursor-wait loop with PC parked near $E5D3, where the KERNAL ROM byte is $02, tripping the JAM heuristic — now vetoed by the sustained ready() completion check.' },
];

// ───────────────────────── worker mode ─────────────────────────
// Screenshots go to the demo-status-shots dir declared in test/external-assets.json.
const SHOTDIR = collectionDir('demo-status-shots');
if (process.argv[2] === '--run') {
  const d64 = process.argv[3], frames = parseInt(process.argv[4], 10), shotName = process.argv[5];
  const { C64Machine } = await import('../src/machine.js');
  const { D64 } = await import('../src/d64.js');
  const { PNG } = await import('pngjs');
  const { CANVAS_W, CANVAS_H } = await import('../src/vic2.js');
  const send = (o) => { if (process.send) process.send(o); else console.log(JSON.stringify(o)); };
  fs.mkdirSync(SHOTDIR, { recursive: true });
  const FPS = 50;                                             // PAL ~50 fps
  const shotBase = shotName.replace(/\.png$/, '');
  // tag set -> periodic shot "<base>-<tag>.png"; tag empty -> the final crash/end shot at shotName.
  const shot = (m, tag) => { try { const p = new PNG({ width: CANVAS_W, height: CANVAS_H }); p.data.set(m.vic2.frameBuffer); const out = path.join(SHOTDIR, tag ? `${shotBase}-${tag}.png` : shotName); fs.writeFileSync(out, PNG.sync.write(p)); return out; } catch (e) { return 'ERR:' + (e && e.message); } };
  if (!fs.existsSync(d64)) { send({ verdict: 'MISSING' }); process.exit(0); }
  if (!fs.existsSync('roms/1541.bin')) { send({ verdict: 'NOROM' }); process.exit(0); }
  try {
    const m = new C64Machine();
    m.loadROMs({ kernal: fs.readFileSync('roms/kernal.bin'), basic: fs.readFileSync('roms/basic.bin'), charRom: fs.readFileSync('roms/chargen.bin') });
    m.attachDrive(fs.readFileSync('roms/1541.bin')); m.setTrueDrive(true); m.reset();
    // Match the UI default (main.js: SID 8580/HMOS, persisted). The raw
    // C64Machine default is 6581, which trips the "old SID detected" prompt in
    // demos built for the 8580 (e.g. Lunatico). Override with SID=6581 env.
    m.setSidModel(process.env.SID !== '6581');
    m.setD64(new D64(new Uint8Array(fs.readFileSync(d64))));
    const ram = m.mem.ram, op = a => ram[a & 0xffff] & 0xff;
    const ready = () => ram[0x00C6] === 0 && ram[0x00CC] === 0 && ram[0x002C] === 0x08;
    let f = 0; while (!ready() && f < 800) { m.runFrame(); f++; }
    // Type LOAD"*",8,1 the way the UI does — chunked through the 10-byte keyboard
    // buffer — so the board matches the real UI load path.
    { const cmd = 'LOAD"*",8,1\r'; let p = 0; while (p < cmd.length) { p += m.bufferKeyboardText(cmd.slice(p)); m.runFrame(); f++; } }
    let busy = false, loaded = false;
    while (f < 5000 && !loaded) { m.runFrame(); f++; if (!ready()) busy = true; else if (busy) loaded = true; }
    m.bufferKeyboardText('RUN\r');
    // CRASH is the only reliable headless signal (halted / JAM opcode /
    // stuck-low-PC loop). PC-sampling CANNOT detect a silent hang — an
    // interrupt-driven demo legitimately spins its main thread at one PC. So
    // for liveness we track the framebuffer: a frozen display (no fb change for
    // a long stretch) is the only honest "possible silent hang" hint.
    const fbhash = (fb) => { let h = 2166136261 >>> 0; for (let i = 0; i < fb.length; i += 97) { h = (h ^ fb[i]) >>> 0; h = (h * 16777619) >>> 0; } return h; };
    let crash = null, stuckPc = -1, stuckN = 0, prevHash = 0, lastChange = f, bootDone = f, completed = false, readyN = 0;
    // Periodic screenshots every 10 s of demo time (from RUN), so the demo's
    // progression — and exactly when it visually breaks — is visible, not just
    // the final crash/end frame.
    const demoT0 = f; let nextShotT = 0;
    // `frames` = the per-demo run length AFTER RUN (tuned per demo to reach its
    // scene/crash: Deus Ex ~3 min, Coma past the mole scene, etc.).
    for (; (f - demoT0) < frames && !crash && !completed; f++) {
      const t = f - demoT0;
      if (t >= nextShotT) { shot(m, 's' + String(Math.round(t / FPS)).padStart(3, '0')); nextShotT += 10 * FPS; }
      m.runFrame(); const pc = m.cpu.pc;
      // Returning to the BASIC "READY." prompt = the demo finished and exited
      // cleanly to BASIC — a RUNS outcome, NOT a crash. The KERNAL cursor-wait
      // idle loop parks the CPU on ROM bytes the JAM heuristic below would
      // otherwise misread (Mojo disc 4 resets to BASIC and idles near $E5D3,
      // where the KERNAL byte is $02). Detected via the same `ready()` state
      // used for the pre-load prompt; require it sustained so a transient
      // BASIC-idle-looking zero-page mid-demo can't false-trigger completion.
      if (ready()) { if (++readyN > 100) { completed = true; break; } } else readyN = 0;
      if (m.cpu.halted) { crash = { pc, op: op(pc) }; break; }
      // Stuck-PC crash: the SAME low/KIL PC for >100 frames AND the display
      // also frozen (>100 frames). The fb-frozen gate avoids false positives on
      // demos that legitimately run code in zero page (e.g. Codeboys & Endians'
      // depacker at $0034, which otherwise trips the pc<$200 check).
      if (pc < 0x0200 || op(pc) === 0x02 || op(pc) === 0x12) { if (pc === stuckPc) { if (++stuckN > 100 && (f - lastChange) > 100) { crash = { pc, op: op(pc) }; break; } } else { stuckPc = pc; stuckN = 0; } }
      const h = fbhash(m.vic2.frameBuffer); if (h !== prevHash) { prevHash = h; lastChange = f; }
    }
    const shotPath = shot(m);                                 // capture the screen at the crash/hang/end
    if (completed) send({ verdict: 'RUNS', frames: f, completed: true, live: true, frozenFor: 0, shot: shotPath });
    else if (crash) send({ verdict: 'CRASH', pc: crash.pc, op: crash.op, frames: f, shot: shotPath });
    else {
      const frozenFor = f - lastChange;                       // frames since the display last changed
      // A long-frozen display with no crash = likely a silent hang (screen
      // black/static while IRQ music may keep playing). 1500 frames (~30s)
      // avoids flagging a scene that merely holds a static image briefly.
      const verdict = frozenFor >= 1500 ? 'FROZEN' : 'RUNS';
      send({ verdict, frames: f, frozenFor, live: frozenFor < 250, shot: shotPath });
    }
  } catch (e) { send({ verdict: 'ERROR', msg: String(e && e.message || e) }); }
  process.exit(0);
}

// ───────────────────────── orchestrator ─────────────────────────
const filter = process.argv.slice(2).map(s => s.toLowerCase());
const list = filter.length ? DEMOS.filter(d => filter.some(f => d.name.toLowerCase().includes(f))) : DEMOS;
const hx = v => '$' + (v & 0xffff).toString(16).padStart(4, '0');
fs.mkdirSync(SHOTDIR, { recursive: true });
const safe = s => s.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
// Run timestamp stamped into every screenshot filename (so runs accumulate and
// you can tell when each was captured), matching commit-screenshots' convention:
//   <demo>-<YYYYMMDD-HHMMSS>.png  (e.g. coma-light-20260628-114523.png)
const _iso = (process.env.DS_NOW || new Date().toISOString()).slice(0, 19);   // 2026-06-28T11:45:23
const RUN_TAG = _iso.slice(0, 10).replace(/-/g, '') + '-' + _iso.slice(11).replace(/:/g, '');
console.log(`demo status board — ${list.length} demos, disc-1 headless, cap ${CAP} parallel (~6-10 min)`);
console.log(`run ${_iso.replace('T', ' ')}  →  screenshots in ${SHOTDIR} (tagged -${RUN_TAG})\n`);

function runOne(demo) {
  return new Promise(res => {
    const t0 = Date.now();
    const child = fork(selfPath, ['--run', demo.d64, String(demo.frames), `${safe(demo.name)}-d${demo.disc}-${RUN_TAG}.png`], { silent: true });
    let result = null;
    child.on('message', m => { result = m; });
    child.on('exit', () => res({ demo, result: result || { verdict: 'ERROR', msg: 'no result' }, sec: ((Date.now() - t0) / 1000) | 0 }));
  });
}

// simple concurrency pool
const results = []; let idx = 0;
async function worker() { while (idx < list.length) { const d = list[idx++]; process.stderr.write(`  running ${d.name}…\n`); results.push(await runOne(d)); } }
await Promise.all(Array.from({ length: Math.min(CAP, list.length) }, worker));
results.sort((a, b) => list.indexOf(a.demo) - list.indexOf(b.demo));

// render
const fmt = (r) => {
  const v = r.result.verdict;
  if (v === 'CRASH') return `CRASH op=$${(r.result.op).toString(16).padStart(2,'0')}@${hx(r.result.pc)} (~${(r.result.frames/50)|0}s)`;
  if (v === 'FROZEN') return `FROZEN ${(r.result.frozenFor/50)|0}s (silent hang? screen static, music may play)`;
  if (v === 'RUNS')  return r.result.completed ? `completed → BASIC (${(r.result.frames/50)|0}s)` : (r.result.live ? `runs clean (${(r.result.frames/50)|0}s)` : `runs, display static ${(r.result.frozenFor/50)|0}s`);
  if (v === 'MISSING') return 'D64 MISSING';
  if (v === 'NOROM') return '1541 ROM MISSING (roms/1541.bin)';
  return `ERROR ${r.result.msg||''}`;
};
const matches = (r) => {
  const v = r.result.verdict, e = r.demo.expect;
  if (e === 'RUNS') return v === 'RUNS';
  if (e === 'FROZEN') return v === 'FROZEN';
  if (e.startsWith('CRASH')) { const want = e.split(':')[1]; return v === 'CRASH' && (!want || hx(r.result.pc) === want); }
  return false;
};
const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
console.log('\n' + pad('DEMO', 15) + pad('DISC', 5) + pad('RESULT', 34) + pad('EXPECTED', 14) + 'MATCH');
console.log('-'.repeat(78));
let bad = 0;
for (const r of results) {
  const ok = matches(r); if (!ok) bad++;
  console.log(pad(r.demo.name, 15) + pad(r.demo.disc, 5) + pad(fmt(r), 34) + pad(r.demo.expect, 14) + (ok ? '✓' : '✗ CHANGED'));
}
console.log('-'.repeat(78));
console.log(`${results.length} demos; ${bad} differ from expected.`);
console.log('\nnotes + screenshots (the screen captured at the crash/hang/end):');
for (const r of results) console.log(`  ${pad(r.demo.name, 15)} ${r.demo.note}\n  ${pad('', 15)} shot: ${r.result.shot || '(none)'}`);
if (bad) console.log('⚠ a ✗ CHANGED row means the headless crash status moved — re-verify visually before editing README status.');

// ── auto-diff vs the previous run (mirrors commit-screenshots' diffAgainstPrevious) ──
// demo-status filenames are `<key>-<YYYYMMDD-HHMMSS>[-s<NNN>].png`, where <key> is
// `<safe-name>-d<disc>` (may itself contain '-') and the optional `-s<NNN>` is the
// periodic shot at NNN seconds; no suffix = the final crash/end frame. We locate the
// RUN_TAG by its fixed `\d{8}-\d{6}` shape (so the hyphenated key is unambiguous), group
// by (key, shot), and compare THIS run's PNG to the newest OLDER run's per shot. Reports
// differing-pixel counts per demo and writes a magenta diff image (diff-<key>-<shot>.png)
// so a regression is eyeballable, not just a number. Only the demos in this run are diffed.
async function diffAgainstPrevious(currentTag, runKeys) {
  const { PNG } = await import('pngjs');
  let files; try { files = fs.readdirSync(SHOTDIR); } catch { return; }
  const re = /^(.*)-(\d{8}-\d{6})(?:-(s\d+))?\.png$/;
  const group = new Map();                 // "<key>|<shot>" -> Map(tag -> filename)
  for (const f of files) {
    if (!f.endsWith('.png') || f.startsWith('diff-')) continue;
    const mt = f.match(re); if (!mt) continue;
    const [, key, tag, shot] = mt;
    const gk = key + '|' + (shot || 'final');
    if (!group.has(gk)) group.set(gk, new Map());
    group.get(gk).set(tag, f);
  }
  const perDemo = new Map();               // key -> {changedShots,totalPixels,maxPixels,shots[],dim}
  let comparisons = 0;
  for (const [gk, tags] of group) {
    if (!tags.has(currentTag)) continue;
    const sep = gk.lastIndexOf('|');
    const key = gk.slice(0, sep), shot = gk.slice(sep + 1);
    if (runKeys && !runKeys.has(key)) continue;     // only demos captured in THIS run
    const others = [...tags.keys()].filter(t => t !== currentTag).sort();
    if (!others.length) continue;                    // no previous run for this shot yet
    const prevTag = others[others.length - 1];        // newest older run
    let cur, prev;
    try {
      cur = PNG.sync.read(fs.readFileSync(path.join(SHOTDIR, tags.get(currentTag))));
      prev = PNG.sync.read(fs.readFileSync(path.join(SHOTDIR, tags.get(prevTag))));
    } catch { continue; }
    comparisons++;
    const e = perDemo.get(key) || { changedShots: 0, totalPixels: 0, maxPixels: 0, shots: [] };
    if (cur.width !== prev.width || cur.height !== prev.height) { e.dim = true; perDemo.set(key, e); continue; }
    let changed = 0;
    const diffImg = new PNG({ width: cur.width, height: cur.height });
    for (let i = 0; i < cur.data.length; i += 4) {
      const same = cur.data[i] === prev.data[i] && cur.data[i + 1] === prev.data[i + 1]
        && cur.data[i + 2] === prev.data[i + 2];
      if (same) {                                     // dim unchanged pixels so changes pop
        diffImg.data[i] = cur.data[i] >> 2; diffImg.data[i + 1] = cur.data[i + 1] >> 2;
        diffImg.data[i + 2] = cur.data[i + 2] >> 2; diffImg.data[i + 3] = 255;
      } else {
        changed++;
        diffImg.data[i] = 255; diffImg.data[i + 1] = 0; diffImg.data[i + 2] = 255; diffImg.data[i + 3] = 255;
      }
    }
    if (changed > 0) {
      e.changedShots++; e.totalPixels += changed; e.maxPixels = Math.max(e.maxPixels, changed);
      e.shots.push(shot);
      fs.writeFileSync(path.join(SHOTDIR, `diff-${key}-${shot}.png`), PNG.sync.write(diffImg));
    }
    perDemo.set(key, e);
  }
  if (!comparisons) { console.log(`\ndiff: no previous run found in ${SHOTDIR} — captured a baseline.`); return; }
  console.log(`\ndiff vs previous run (${comparisons} shot-pairs compared):`);
  let anyChange = false;
  for (const [key, e] of [...perDemo].sort((a, b) => (b[1].totalPixels || 0) - (a[1].totalPixels || 0))) {
    if (e.dim) { console.log(`  ${pad(key, 22)} DIMENSION CHANGE`); anyChange = true; continue; }
    if (e.changedShots === 0) { console.log(`  ${pad(key, 22)} identical`); continue; }
    anyChange = true;
    const lbl = [...new Set(e.shots)]
      .map(s => s === 'final' ? 'final' : (parseInt(s.slice(1), 10) + 's'))
      .sort((a, b) => parseInt(a) - parseInt(b)).join(', ');
    console.log(`  ${pad(key, 22)} CHANGED at ${lbl}  (${e.totalPixels} px total, ${e.maxPixels} px worst — see diff-${key}-*.png)`);
  }
  if (!anyChange) console.log('  all shots identical to the previous run ✓');
}

const runKeys = new Set(list.map(d => `${safe(d.name)}-d${d.disc}`));
await diffAgainstPrevious(RUN_TAG, runKeys);
