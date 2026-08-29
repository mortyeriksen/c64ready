// Bad-line CANCEL boundary spec test (Bauer §3.5 + §3.7.2 rule 2).
//
// Bauer §3.5: "You can produce or cancel a Bad Line Condition multiple times
// within an arbitrary raster line ... by modifying YSCROLL." A demo can arm a
// bad line (YSCROLL matches raster&7 from line start, so BA drops at cy12),
// then rewrite YSCROLL to a non-matching value to CANCEL it before it commits
// — keeping the CPU un-stalled. This is the exact trick the Coma Light 13
// opening plasma relies on every FLI line.
//
// WHY THIS TEST EXISTS: the canonical bad-line tests (vic2-badline-goodline-
// integration-test.js, vic2-fli-badline-every-line-spec-test.js) only use a
// CONSTANT YSCROLL or only ARM bad lines (write YSCROLL to MATCH). Neither
// exercises the arm-then-CANCEL path, so neither catches the cancel-boundary
// behaviour that Coma depends on. This test pins it.
//
// Boundary (per §3.7.2 rule 2: the bad-line condition is sampled at cycle-14
// phi1; a CPU write lands phi2, i.e. AFTER that sample): a YSCROLL cancel that
// lands at or after cycle 14 is one cycle too late — the cy14 sample already
// saw the matching value and commits the bad line. So:
//   • cancel at cy ≤ 13  → bad line CANCELLED (0 c-accesses, BA released)
//   • cancel at cy ≥ 14  → bad line FIRES (40 c-accesses, full BA-low stall)
//
// Two write paths, two boundaries. DIRECT POKES (v.regs[0x11] = x after
// clock()) bypass vic.write(): the poke after clock(cy13) is phi2 of cy13, so
// cy14 phi1 sees the cancel and cy13 is the last cycle that works. The CPU's
// vic.write() path has a synchronous cancel hook in the $D011 handler that
// fires at the exact phi2 moment, so a write at cy14 phi2 still cancels the
// fetch queued for cy15; cy15 is too late (the fetch has started). Coma Light
// 13's FLI plasma writes $D011 at cy14 phi2 every line and depends on it.
// Both boundaries are locked below.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

let failures = 0;
function assert(cond, msg) { if (!cond) { console.error(`FAIL: ${msg}`); failures++; } }
function eq(a, b, msg) { assert(a === b, `${msg} — expected ${b}, got ${a}`); }

// Arm a bad line at raster 51 (YSCROLL=3 == 51&7 from line start → BA drops at
// cy12), then write a NON-matching YSCROLL (=4) at `cancelCy` to cancel it.
// Returns c-access count and BA-low cycle count for raster 51.
function trial(cancelCy) {
  const v = new VIC2();
  v.ram = new Uint8Array(0x10000); v.colorRam = new Uint8Array(0x400);
  v.charRom = new Uint8Array(0x1000); v.currentVicBank = 0;
  v.regs[0x16] = 0x08; v.regs[0x15] = 0x00; v.displayEnabled = true;
  v.regs[0x11] = 0x1B;                       // DEN, RSEL, YSCROLL=3
  let cacc = 0;
  const oc = v._fetchScreenRowColumn.bind(v);
  v._fetchScreenRowColumn = (c, r, b) => { if (v.raster === 51) cacc++; return oc(c, r, b); };
  let guard = 0;
  while (!(v.raster === 51 && v.cycleInLine === 0)) { v.clock(1); if (++guard > CYCLES_PER_LINE * 120) throw new Error('drive timeout'); }
  let baLow = 0;
  for (let c = 1; c <= CYCLES_PER_LINE; c++) {
    v.clock(1);
    if (v._thisCycleInLine === cancelCy) v.regs[0x11] = 0x1C; // YSCROLL=4 → 51&7=3 no longer matches
    if (v.baLow && v.raster === 51) baLow++;
  }
  return { cacc, baLow };
}

console.log('cancel@cy  c-accesses  BA-low');
for (const cy of [8, 11, 12, 13, 14, 15, 99 /*no cancel*/]) {
  const r = trial(cy);
  console.log(`   ${String(cy).padStart(2)}       ${String(r.cacc).padStart(2)}        ${r.baLow}`);
}
console.log('');

// ── Cancel succeeds through cy13 ──────────────────────────────────────────
for (const cy of [8, 11, 12, 13]) {
  const r = trial(cy);
  eq(r.cacc, 0, `cancel@cy${cy}: bad line cancelled → 0 c-accesses`);
  assert(r.baLow <= 3, `cancel@cy${cy}: BA released promptly (got ${r.baLow} BA-low cycles)`);
}

// ── At cy14 the cy14-phi1 sample has already committed → bad line fires ────
// This is the boundary the Coma demo's cancel must beat. Our boundary is cy13;
// the demo's write landing at cy14 in our run is what fires the spurious bad
// line and stalls the CPU.
{
  const r = trial(14);
  eq(r.cacc, 40, 'cancel@cy14: TOO LATE — bad line fires (40 c-accesses)');
  eq(r.baLow, 43, 'cancel@cy14: full bad-line BA-low stall (cy12..54 = 43)');
}
{
  const r = trial(99);
  eq(r.cacc, 40, 'no cancel: bad line fires (40 c-accesses)');
}

// ── Reference: a clean armed bad line with no cancel attempt ──────────────
// (Sanity that the harness actually produces a bad line to cancel.)
eq(trial(99).cacc, 40, 'control: armed bad line does 40 c-accesses');

// ── Write path: vic.write($D011) at phi2 ──────────────────────────────────
// Same arm, but the cancel goes through write() after clock() at `writeCy`,
// the way a CPU store lands in phi2.
function trialWrite(writeCy, cancelVal = 0x1C) {
  const v = new VIC2();
  v.ram = new Uint8Array(0x10000); v.colorRam = new Uint8Array(0x400);
  v.charRom = new Uint8Array(0x1000); v.currentVicBank = 0;
  v.regs[0x16] = 0x08; v.regs[0x15] = 0x00; v.displayEnabled = true;
  for (let i = 0; i < 0x4000; i++) v.ram[i] = (i * 13 + 7) & 0xFF;
  v.regs[0x18] = 0x14;
  v.regs[0x11] = 0x1B;                       // DEN, RSEL, YSCROLL=3 → arms on raster 51
  let cacc = 0;
  const oc = v._fetchScreenRowColumn.bind(v);
  v._fetchScreenRowColumn = (c, r, b) => { if (v.raster === 51) cacc++; return oc(c, r, b); };
  let guard = 0;
  while (!(v.raster === 51 && v.cycleInLine === 0)) { v.clock(1); if (++guard > CYCLES_PER_LINE * 320) throw new Error('drive timeout'); }
  let baLow = 0;
  for (let c = 1; c <= CYCLES_PER_LINE; c++) {
    v.clock(1);
    if (v._thisCycleInLine === writeCy) v.write(0x11, cancelVal);
    if (v.baLow && v.raster === 51) baLow++;
  }
  return { cacc, baLow };
}

{
  const r = trialWrite(14);
  eq(r.cacc, 0, 'phi2 write cancel at cy14: bad line cancelled → 0 c-accesses');
  assert(r.baLow <= 4, `phi2 write cancel at cy14: BA released promptly (got ${r.baLow} BA-low cycles)`);
}
{
  const r = trialWrite(13);
  eq(r.cacc, 0, 'phi2 write cancel at cy13: bad line cancelled → 0 c-accesses');
  assert(r.baLow <= 3, `phi2 write cancel at cy13: BA released promptly (got ${r.baLow} BA-low cycles)`);
}
{
  const r = trialWrite(15);
  eq(r.cacc, 40, 'phi2 write cancel at cy15: too late — fetch already started → 40 c-accesses');
}
eq(trialWrite(99).cacc, 40, 'write path, no cancel: bad line fires normally (40 c-accesses)');

if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1); }
console.log('PASS — bad-line cancel boundary is cy13 for direct pokes and cy14 for vic.write() (phi2 hook); ' +
  'both are the path the Coma FLI cancel depends on.');
