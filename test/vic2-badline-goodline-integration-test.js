// Integration test — true to a real run: boots the actual KERNAL/BASIC ROMs
// to the READY screen (standard 40x25 text mode, DEN=1, YSCROLL=3, no
// sprites), then drives the REAL CPU+VIC together one master cycle at a
// time across a bad line and the immediately following good line, and
// asserts every per-cycle event lands on the spec-correct cycle.
//
// This is deliberately NOT a bare-VIC2 unit test (cf. vic2-badline-ba-
// cycles-test.js which drives vic.clock() with no CPU). Here the CPU runs
// the genuine KERNAL idle loop, the VIC is clocked from machine
// ._runMasterCycle (vic.clock → cpu.clock → vic.phi2), so the bad-line BA
// stall, the c-access DMA, RC/VC/VMLI progression and the cycle-58 idle
// logic are all exercised exactly as in a live session.
//
// Reference timing (PAL 6569, Bauer "The MOS 6567/6569 video controller"):
//   §3.7.2 rule 2 : cycle 14 phi1 — VC<-VCBASE, VMLI<-0, and (bad line only)
//                   RC<-0.
//   §3.7.2 rule 3 : on a bad line the 40 c-accesses run in cycles 15..54;
//                   g-accesses (which advance VC/VMLI) run every display
//                   line in cycles 15..54.
//   §3.7.2 rule 5 : cycle 58 — if RC==7 the logic goes idle and VCBASE<-VC;
//                   otherwise (still display) RC is incremented.
//   §3.6.1        : bad-line BA is low cycles 12..54 (3-cycle lead before the
//                   first c-access); AEC = BA(c) AND BA(c-3) → AEC low 15..54.
//   A good (non-bad) display line performs NO c-access, never pulls BA low
//   (no sprites here), but DOES g-access (VC advances 40) and increments RC.

import { C64Machine } from '../src/machine.js';
import { readFileSync } from 'fs';

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}
function eq(actual, expected, msg) {
  assert(actual === expected, `${msg} — expected ${expected}, got ${actual}`);
}

// ── Boot a real machine to the BASIC READY prompt ──────────────────────────
const machine = new C64Machine();
machine.loadROMs({
  kernal: new Uint8Array(readFileSync('roms/kernal.bin')),
  basic: new Uint8Array(readFileSync('roms/basic.bin')),
  charRom: new Uint8Array(readFileSync('roms/chargen.bin')),
});
machine.reset();
for (let i = 0; i < 120; i++) machine.runFrame();

const vic = machine.vic2;

// Sanity: standard text-mode steady state.
eq(vic.regs[0x11] & 0x10, 0x10, 'boot: DEN set (display enabled)');
eq(vic.regs[0x11] & 0x07, 3, 'boot: YSCROLL == 3 (KERNAL default)');
eq(vic.regs[0x15], 0x00, 'boot: no sprites enabled');
eq((vic.regs[0x11] >> 5) & 3, 0, 'boot: not BMM/ECM (plain text mode)');

// ── Instrument the real fetch path ─────────────────────────────────────────
// Record the exact cycle each c-access (matrix fetch) and g-access (char/
// graphics fetch, which advances VC) fires. We observe the genuine methods
// rather than re-deriving — this is the "true to a real run" contract.
const cAccess = new Map(); // `${raster}:${cycle}` -> count
const gAccess = new Map();
const key = (r, c) => `${r}:${c}`;
const origC = vic._fetchScreenRowColumn.bind(vic);
vic._fetchScreenRowColumn = function (col, regs, bank) {
  cAccess.set(key(this.raster, this.cycleInLine),
    (cAccess.get(key(this.raster, this.cycleInLine)) || 0) + 1);
  return origC(col, regs, bank);
};
const origG = vic._advanceDisplayStateGAccess.bind(vic);
vic._advanceDisplayStateGAccess = function () {
  // g-access only counts when display is active (real fetch occurred).
  if (this.displayActive) {
    gAccess.set(key(this.raster, this.cycleInLine),
      (gAccess.get(key(this.raster, this.cycleInLine)) || 0) + 1);
  }
  return origG();
};

// ── Step to a clean mid-screen char-row boundary ───────────────────────────
// Bad lines: (raster & 7) === YSCROLL(3) within 0x30..0xF7. Pick raster 99
// (99 & 7 == 3) so we capture: 98 = rc7 good line (VCBASE advances at c58),
// 99 = bad line (rc0), 100 = good line (rc1). Mid-screen avoids top/bottom
// border edge effects.
const BAD = 99;
const GOOD = BAD + 1;          // 100, a good display line
const PREV = BAD - 1;          // 98, rc7 good line (char-row boundary)
const FIRST = PREV, LAST = GOOD + 1; // capture 98..101

// Advance until we're at the very start of line FIRST (cycleInLine just
// wrapped). Cap the search so a regression can't hang the suite.
let guard = 0;
while (!(vic.raster === FIRST && vic.cycleInLine === 0)) {
  machine._runMasterCycle();
  if (++guard > 25 * 312 * 65) { console.error('FAIL: never reached target raster'); process.exit(1); }
}

// Per-cycle state, indexed [lineRaster][cycle 1..63].
const samp = {}; // lineRaster -> { cycle -> {ba,aec,vc,vcBase,rc,vmli,disp} }
for (let r = FIRST; r <= LAST; r++) samp[r] = {};

// Capture every master cycle from start of FIRST through end of LAST.
while (vic.raster <= LAST) {
  machine._runMasterCycle();
  const cyc = vic._thisCycleInLine;            // true 1..63 (survives the wrap)
  if (cyc === undefined) continue;
  // cycle 63 increments raster at end-of-line; attribute it to the line
  // that just finished.
  const lineRaster = (cyc === 63) ? vic.raster - 1 : vic.raster;
  if (lineRaster < FIRST || lineRaster > LAST) continue;
  samp[lineRaster][cyc] = {
    ba: !!vic.baLow,
    aec: !!vic.aecLow,
    vc: vic.vc,
    vcBase: vic.vcBase,
    rc: vic.rc,
    vmli: vic.vmli,
    disp: !!vic.displayActive,
  };
  if (lineRaster === LAST && cyc === 63) break;
}

// ── Pretty table (debug aid; harmless on pass) ─────────────────────────────
const cCount = (r) => { let n = 0; for (let c = 1; c <= 63; c++) if (cAccess.get(key(r, c))) n++; return n; };
const gCount = (r) => { let n = 0; for (let c = 1; c <= 63; c++) if (gAccess.get(key(r, c))) n++; return n; };
console.log('raster  type  c-acc g-acc  BA-low(cy)        AEC-low(cy)       rc@14 rc@58 vc@14==vcBase');
for (let r = FIRST; r <= LAST; r++) {
  const isBad = (r & 7) === 3;
  const baLowCy = [], aecLowCy = [];
  for (let c = 1; c <= 63; c++) {
    const s = samp[r][c]; if (!s) continue;
    if (s.ba) baLowCy.push(c);
    if (s.aec) aecLowCy.push(c);
  }
  const span = (arr) => arr.length ? `${arr[0]}..${arr[arr.length - 1]}(${arr.length})` : 'none';
  const s14 = samp[r][14], s58 = samp[r][58];
  console.log(
    `  ${r}    ${isBad ? 'BAD ' : 'good'}   ${String(cCount(r)).padStart(2)}    ${String(gCount(r)).padStart(2)}   ` +
    `${span(baLowCy).padEnd(16)}  ${span(aecLowCy).padEnd(16)}  ` +
    `${s14 ? s14.rc : '?'}     ${s58 ? s58.rc : '?'}     ${s14 ? (s14.vc === s14.vcBase) : '?'}`);
}
console.log('');

// ── Helpers ────────────────────────────────────────────────────────────────
const cyclesWith = (map, r) => { const out = []; for (let c = 1; c <= 63; c++) if (map.get(key(r, c))) out.push(c); return out; };
const arrEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const range = (lo, hi) => { const o = []; for (let c = lo; c <= hi; c++) o.push(c); return o; };

// ════════════════════════════════════════════════════════════════════════
// BAD LINE (raster 99) — full c-access DMA line
// ════════════════════════════════════════════════════════════════════════
assert((BAD & 7) === 3, 'precondition: chosen line is a bad line');

// §3.7.2 rule 3: exactly 40 c-accesses, on cycles 15..54.
const cBad = cyclesWith(cAccess, BAD);
assert(arrEq(cBad, range(15, 54)),
  `bad line: c-access must fire cycles 15..54 (got [${cBad.join(',')}])`);

// §3.6.1: BA low cycles 12..54 (3-cycle lead); high everywhere else.
for (let c = 1; c <= 63; c++) {
  const s = samp[BAD][c]; if (!s) continue;
  const expBA = (c >= 12 && c <= 54);
  eq(s.ba, expBA, `bad line cy${c}: BA-low`);
}
// AEC = BA(c) AND BA(c-3) → low cycles 15..54.
for (let c = 1; c <= 63; c++) {
  const s = samp[BAD][c]; if (!s) continue;
  const expAEC = (c >= 15 && c <= 54);
  eq(s.aec, expAEC, `bad line cy${c}: AEC-low`);
}

// §3.7.2 rule 2: cycle 14 phi1 — VC<-VCBASE, VMLI<-0, RC<-0 (bad line).
eq(samp[BAD][14].vmli, 0, 'bad line cy14: VMLI reset to 0');
eq(samp[BAD][14].rc, 0, 'bad line cy14: RC reset to 0');
eq(samp[BAD][14].vc, samp[BAD][14].vcBase, 'bad line cy14: VC loaded from VCBASE');
assert(samp[BAD][14].disp, 'bad line cy14: display state active');

// g-accesses run cycles 15..54 and advance VC by exactly 40 over the line.
const gBad = cyclesWith(gAccess, BAD);
assert(arrEq(gBad, range(15, 54)),
  `bad line: g-access must fire cycles 15..54 (got [${gBad.join(',')}])`);
eq((samp[BAD][54].vc - samp[BAD][14].vc) & 0x3FF, 40, 'bad line: VC advances 40 (cy14→cy54)');
eq(samp[BAD][54].vmli, 40, 'bad line cy54: VMLI == 40 after 40 g-accesses');

// §3.7.2 rule 5: RC was 0 (≠7) → no idle transition; RC increments 0→1 at c58.
eq(samp[BAD][58].rc, 1, 'bad line cy58: RC incremented 0→1 (no idle, RC≠7)');
eq(samp[BAD][58].vcBase, samp[BAD][14].vcBase, 'bad line cy58: VCBASE unchanged (RC≠7)');

// ════════════════════════════════════════════════════════════════════════
// GOOD LINE (raster 100) — display line, no DMA
// ════════════════════════════════════════════════════════════════════════
assert((GOOD & 7) !== 3, 'precondition: chosen line is a good line');

// No c-access on a good line — the matrix line buffer is reused.
eq(cyclesWith(cAccess, GOOD).length, 0, 'good line: ZERO c-accesses');

// No DMA: BA and AEC stay high all line (no sprites).
for (let c = 1; c <= 63; c++) {
  const s = samp[GOOD][c]; if (!s) continue;
  eq(s.ba, false, `good line cy${c}: BA stays high`);
  eq(s.aec, false, `good line cy${c}: AEC stays high`);
}

// §3.7.2 rule 2: cy14 still loads VC<-VCBASE and clears VMLI, but RC is NOT
// reset on a good line — it carries the bad line's increment (rc==1 here).
eq(samp[GOOD][14].vmli, 0, 'good line cy14: VMLI reset to 0');
eq(samp[GOOD][14].vc, samp[GOOD][14].vcBase, 'good line cy14: VC loaded from VCBASE');
eq(samp[GOOD][14].rc, 1, 'good line cy14: RC NOT reset (carries 1 from bad line)');

// Display still fetches graphics every line: g-access 15..54, VC advances 40.
const gGood = cyclesWith(gAccess, GOOD);
assert(arrEq(gGood, range(15, 54)),
  `good line: g-access must still fire cycles 15..54 (got [${gGood.join(',')}])`);
eq((samp[GOOD][54].vc - samp[GOOD][14].vc) & 0x3FF, 40, 'good line: VC advances 40 (cy14→cy54)');

// RC increments 1→2 at c58 (still display, RC≠7).
eq(samp[GOOD][58].rc, 2, 'good line cy58: RC incremented 1→2');

// Same 40 matrix columns re-displayed: VC start identical to the bad line.
eq(samp[GOOD][14].vc, samp[BAD][14].vc, 'good line: VC start == bad line VC start (same char row)');

// ════════════════════════════════════════════════════════════════════════
// CHAR-ROW BOUNDARY (raster 98, rc7) — §3.7.2 rule 5 VCBASE<-VC advance
// ════════════════════════════════════════════════════════════════════════
eq(samp[PREV][14].rc, 7, 'rc7 line cy14: RC == 7 (last line of char row)');
// At c58 with RC==7: VCBASE<-VC, then RC wraps to 0 → next (bad) line starts
// one char-row (40 columns) further down.
eq((samp[BAD][14].vcBase - samp[PREV][14].vcBase) & 0x3FF, 40,
  'char-row boundary: VCBASE advanced by 40 across rc7→rc0 (cy58 VCBASE<-VC)');

console.log('PASS — bad-line and good-line cycle timing match spec (§3.7.2 / §3.6.1)');
