// Stable-raster double-IRQ jitter-absorber spec test.
//
// Locks in the exact mechanism Coma Light 13's opening plasma (and most
// cycle-exact effects) depend on: a two-stage raster IRQ that turns a
// jittered raster-IRQ entry into a CYCLE-EXACT position.
//
//   irq1 (line L):   INC $D019 ack; arm $D012=L+1; point vector at irq2;
//                    CLI; long NOP pad  → irq2 fires NESTED, during the
//                    NOPs (2-cycle insns ⇒ ≤1 cy entry jitter).
//   irq2 (line L+1): INC $D019; save regs; LDX#5/DEX/BPL hand-counted
//                    delay; LDA $D012 / CMP #L+1 / BEQ *+2  ← the absorber
//                    (taken=3 cy, not-taken=2 cy compensates the last cy of
//                    jitter). After it, the CPU is cycle-exact.
//
// The bytes below are the demo's ACTUAL $2b00 init + $2b21 irq1 + $2b55
// irq2 (up to the absorber), so the hand-counted delays are correct by
// construction. The post-absorber "stable point" is $2b6d; we replace the
// per-line work there with a re-arm + RTI and capture the cycle.
//
// SPEC INVARIANT (no oracle constant needed — pure jitter elimination):
//   Across many entry phases (different main-loop instruction interrupted
//   ⇒ different irq1 entry jitter), the cycle position at $2b6d must be
//   IDENTICAL. If our CPU/VIC raster-IRQ latency, $D012 read timing, CLI
//   delay, or branch-cycle timing is off, the jitter is not absorbed and
//   $2b6d drifts.
//
// Bauer §3.12 (raster compare / once-per-line IRQ) + 6510 IRQ entry (7 cy)
// + CLI 1-instruction delay + RMW dummy-write ack ($D019) all participate.

import { C64Machine } from '../src/machine.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { testsFailing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

// Demo's real stabilizer: $2b00 init + $2b21 irq1 + $2b55 irq2 (thru BEQ).
const STAB = [
  /* $2b00 */ 0x78,0xa9,0x21,0x8d,0xfe,0xff,0xa9,0x2b,0x8d,0xff,0xff,0xa9,0x0b,0x8d,0x11,0xd0,
  /* $2b10 */ 0xa9,0x4e,0x8d,0x12,0xd0,0xa9,0x00,0x8d,0x0e,0xdc,0xa9,0x81,0x8d,0x1a,0xd0,0x58,
  /* $2b20 */ 0x60,0xee,0x19,0xd0,0x85,0x10,0xa9,0x4f,0x8d,0x12,0xd0,0xa9,0x55,0x8d,0xfe,0xff,
  /* $2b30 */ 0xa9,0x2b,0x8d,0xff,0xff,0xad,0x0d,0xdc,0xa5,0x10,0x58,0xea,0xea,0xea,0xea,0xea,
  /* $2b40 */ 0xea,0xea,0xea,0xea,0xea,0xea,0xea,0xea,0xea,0xea,0xea,0xea,0xea,0xea,0xea,0xea,
  /* $2b50 */ 0xea,0xea,0xea,0xea,0x40,0xee,0x19,0xd0,0x85,0x10,0x86,0x11,0x84,0x12,0xa2,0x05,
  /* $2b60 */ 0xca,0x10,0xfd,0xea,0xa2,0x06,0xad,0x12,0xd0,0xc9,0x4f,0xf0,0x00, // $2b6c = end of BEQ
];
// $2b6d.. : our replacement (re-arm irq1 for next frame, restore regs, RTI).
const EXIT = [
  /* $2b6d */ 0xa9,0x21,0x8d,0xfe,0xff,  // LDA #$21 / STA $FFFE
  /* $2b72 */ 0xa9,0x2b,0x8d,0xff,0xff,  // LDA #$2B / STA $FFFF  (vector -> irq1)
  /* $2b77 */ 0xa9,0x4e,0x8d,0x12,0xd0,  // LDA #$4E / STA $D012  (next frame line $4e)
  /* $2b7c */ 0xa9,0x01,0x8d,0x19,0xd0,  // LDA #$01 / STA $D019  (ack raster)
  /* $2b81 */ 0xa5,0x10,0xa6,0x11,0xa4,0x12, // LDA $10 / LDX $11 / LDY $12 (restore)
  /* $2b87 */ 0x40,                      // RTI
];
const MARKER = 0x2b6d;     // post-absorber "stable point"
const IRQ1   = 0x2b21;
const FIRST_LINE = 0x4e;

function makeMachine(opts = {}) {
  const m = new C64Machine();
  m.reset();
  m.mem.ram.fill(0xEA);
  // Load the stabilizer bytes verbatim at $2b00.
  for (let i = 0; i < STAB.length; i++) m.mem.ram[0x2b00 + i] = STAB[i];
  for (let i = 0; i < EXIT.length; i++) m.mem.ram[0x2b6d + i] = EXIT[i];
  // Main loop at $1000: a 7-cycle RMW (INC $0340,X) + JMP — the instruction
  // the raster IRQ interrupts, so entry jitter spans a 7-cycle window.
  let p = 0x1000;
  m.mem.ram[p++] = 0xFE; m.mem.ram[p++] = 0x40; m.mem.ram[p++] = 0x03; // INC $0340,X
  m.mem.ram[p++] = 0x4C; m.mem.ram[p++] = 0x00; m.mem.ram[p++] = 0x10; // JMP $1000
  // Arm the stabilizer exactly as the demo's $2b00 init does (DEN off via
  // $D011=$0b ⇒ no badlines perturb the sync up to the marker).
  m.vic2.write(0x11, 0x0b);
  m.vic2.write(0x12, FIRST_LINE);
  m.vic2.write(0x1a, 0x01);          // raster IRQ enable
  m.vic2.write(0x19, 0x0f);          // ack any latched
  m.mem.ram[0xFFFE] = 0x21; m.mem.ram[0xFFFF] = 0x2b;  // vector -> irq1
  if (opts.sprites) {
    // 8 sprites enabled exactly as the demo places them: Y=$51 (81). DMA/
    // p-s-accesses then begin at line $50 (80) cycle 58 — i.e. AFTER the
    // sync window (lines $4e/$4f) and after the post-absorber marker at
    // $50 (~cy 39). So the sync line is sprite-free (as a correct stable
    // raster requires), yet sprites ARE active right below it — the demo's
    // real condition. DEN stays off (faithful to the demo's sync).
    //
    // (Placing sprites so they steal ON the sync line breaks the absorber —
    // but that is CORRECT hardware behavior: IRQ recognition deferred by
    // AEC-low sprite DMA leaks the jitter through, which is why stable
    // rasters must sync on a sprite-free line. So that is intentionally
    // NOT what we assert here.)
    m.vic2.write(0x15, 0xff);        // all 8 enabled
    m.vic2.write(0x1c, 0xff);        // multicolor (like the demo)
    for (let s = 0; s < 8; s++) {
      m.vic2.write(0x00 + s * 2, 24 + s * 24);  // X spread
      m.vic2.write(0x01 + s * 2, 0x51);          // Y=$51 (demo placement)
    }
  }
  return m;
}

// Park at (raster, cy), then start the main loop cleanly at PC=$1000, X=0.
function parkAndArm(m, raster, cy) {
  let safety = 600000;
  while (--safety && !(m.vic2.raster === raster && m.vic2.cycleInLine === cy)) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  m.cpu.pc = 0x1000;
  m.cpu.x = 0;
  m.cpu.I = 0;
  m.cpu.sampledIrq = false;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
}

// Run one trial: park at (0x30, cy0), then run until the marker ($2b6d) is
// reached. Capture irq1 entry cycle (the jitter) and marker cycle.
function runTrial(cy0, opts = {}) {
  const m = makeMachine(opts);
  parkAndArm(m, 0x48, cy0);
  let entryCy = -1, entryRaster = -1, markerCy = -1, markerRaster = -1;
  const origClock = m.cpu.clock.bind(m.cpu);
  m.cpu.clock = function() {
    if (this.instructionCyclesRemaining === 0) {
      if (this.pc === IRQ1 && entryCy < 0) { entryCy = m.vic2.cycleInLine; entryRaster = m.vic2.raster; }
      if (this.pc === MARKER && markerCy < 0) { markerCy = m.vic2.cycleInLine; markerRaster = m.vic2.raster; }
    }
    return origClock();
  };
  // From line $48, the first IRQ is at $4e (~6 lines); irq2 + marker land a
  // line or two later. Run a generous budget.
  for (let i = 0; i < 16 * 63 && markerCy < 0; i++) C64Machine.prototype._runMasterCycle.call(m);
  return { entryCy, entryRaster, markerCy, markerRaster };
}

// ── Test 1: sanity — entry jitter actually varies across phases ─────────
// (If it didn't, the absorber test below would be vacuous.)
const trials = [];
for (let k = 0; k < 12; k++) trials.push(runTrial(8 + k));

{
  const reached = trials.filter(t => t.markerCy >= 0).length;
  expect(reached === trials.length,
    `every trial reaches the post-absorber marker $2b6d; got ${reached}/${trials.length}`);
  const entrySet = new Set(trials.map(t => `${t.entryRaster}:${t.entryCy}`));
  expect(entrySet.size >= 3,
    `irq1 entry must jitter across phases (≥3 distinct entry cycles); got ${entrySet.size} ` +
    `(${[...entrySet].join(', ')})`);
  ok('main-loop phase shift produces varying irq1 entry jitter (meaningful test)');
}

// ── Test 2: the absorber eliminates the jitter (THE spec invariant) ─────
{
  const markerSet = new Set(trials.filter(t => t.markerCy >= 0).map(t => `${t.markerRaster}:${t.markerCy}`));
  const detail = trials.map((t, k) =>
    `phase${k}: entry=${t.entryRaster}:${t.entryCy} -> marker=${t.markerRaster}:${t.markerCy}`).join('\n     ');
  expect(markerSet.size === 1,
    `post-absorber marker $2b6d must land at ONE cycle position across all entry jitters; ` +
    `got ${markerSet.size} distinct (${[...markerSet].join(', ')})\n     ${detail}`);
  ok('double-IRQ + $D012/CMP/BEQ absorber yields cycle-exact $2b6d (jitter eliminated)');
}

// ── Test 3: sync stays cycle-exact with the demo's sprites active ───────
// The demo runs the plasma with 8 sprites enabled (Y=$51), displaying
// immediately below the sync. Their DMA must NOT retroactively perturb the
// sprite-free sync line. If our sprite-DMA scheduling bled cycles into the
// sync/marker window, the absorbed marker would drift.
{
  const sTrials = [];
  for (let k = 0; k < 12; k++) sTrials.push(runTrial(8 + k, { sprites: true }));
  const reached = sTrials.filter(t => t.markerCy >= 0).length;
  expect(reached === sTrials.length,
    `every sprite trial reaches $2b6d; got ${reached}/${sTrials.length}`);
  const markerSet = new Set(sTrials.filter(t => t.markerCy >= 0).map(t => `${t.markerRaster}:${t.markerCy}`));
  const detail = sTrials.map((t, k) =>
    `phase${k}: entry=${t.entryRaster}:${t.entryCy} -> marker=${t.markerRaster}:${t.markerCy}`).join('\n     ');
  expect(markerSet.size === 1,
    `with the demo's sprites (Y=$51) active, the sprite-free sync line must stay ` +
    `cycle-exact; got ${markerSet.size} distinct (${[...markerSet].join(', ')})\n     ${detail}`);
  ok('sync stays cycle-exact with demo-placement sprites (Y=$51) active');
}

console.log(`\n${testsFailing === 0 ? 'PASS' : 'FAIL'} — ${testNo} tests, ${testsFailing} failing`);
process.exit(testsFailing === 0 ? 0 : 1);
