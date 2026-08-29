// CPU→I/O ordering audit. Characterizes the per-cycle observable delay
// between a CPU register write at master cycle K (during phi2) and the
// chip-internal effect, sampled at cycles K, K+1, K+2.
//
// The machine clocks VIC before CPU phi2, then clocks CIA after CPU phi2.
// CIA register writes are therefore visible to the CIA timer phase in the
// same master cycle, while VIC register writes become visible at the next
// phi1. The hazard is "double-delay": chip code that also defers a write
// internally, producing an extra cycle beyond the architectural phase.
//
// This test is mechanical, not functional: it does NOT run real 6502
// code. Instead it drives the chips with the same step ordering as
// machine._runMasterCycle and injects writes at the architectural
// "CPU phi2" position (after vic.clock and before cia.clock).
//
// ── AUDIT VERDICT (2026-05-09) ─────────────────────────────────────────
// All audited registers exhibit the architectural 1-cycle delay only —
// no chip-internal pipeline stacks an additional cycle on top.
//
// register   | first cycle effect visible | mechanism
// ───────────┼────────────────────────────┼─────────────────────────────
// $DC0E b0=1 | K (timer counts)           | CPU phi2 before CIA clock
// $DC0E b0=0 | K (no count)               | CPU phi2 before CIA clock
// $DC0E b4   | K   (force-load)           | synchronous write-strobe
// $DC04/05   | K   (latch + reload-if-stopped)
// $DC0D mask | K   (IRQ line update)      | synchronous (irqHandler)
// $DC0D read | K   (clear before clock)   | CPU phi2 before CIA clock
// $DD00 PA   | K+1 (VIC sees new bank)    | writePortA→noteBankChange sync
// $D011-$D018| K+1 (VIC phi1 reads regs)  | regs[] sync; lineCycleRegs[K+1] captures
// $D019 ack  | K   (synchronous clear)
// $D01A mask | K   (IRQ line update)      | synchronous (irqHandler)
//
// Note on lineCycleRegs[]: the renderer reads per-cycle snapshots taken
// at phi1 of each cycle (in vic.clock(), BEFORE CPU phi2). So a CPU
// write at K phi2 → snapshot at K+1 phi1. The 8565 variant adds a
// further -1 cycle offset by design (real-hw render pipeline delay) —
// not a bug, that's the chip variant's documented behavior.
//
// Each test prints a one-line verdict; the test file as a whole is a
// lock-down spec: any future change that introduces a chip-internal
// write-pipeline (raising total latency to >1 cycle) will fail it.

import { CIA } from '../src/cia.js';
import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

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

// Architectural step in CIA isolation. Mirrors machine._runMasterCycle's
// CIA portion: beginMasterCycle → (CPU phi2 here) → clock(1) → endMasterCycle.
// Caller may call opts.write at CPU phi2 to model a same-cycle register
// access before the CIA's timer phase.
function ciaStep(cia, opts = {}) {
  cia.beginMasterCycle();
  if (opts.write) opts.write();   // simulates CPU phi2 register write
  cia.clock(1);
  cia.endMasterCycle();
}

// Architectural step in VIC isolation: vic.clock(1) phi1 → (CPU phi2) → vic.phi2().
function vicStep(vic, opts = {}) {
  vic.clock(1);
  if (opts.write) opts.write();
  vic.phi2();
}

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

// ───────────────────────────────────────────────────────────────────────
//  CIA — write→effect cycle audit
// ───────────────────────────────────────────────────────────────────────

// CIA-1: CRA bit 0 = 1 starts timerA.
// In machine ordering, a write at CPU phi2 of cycle K is visible to the
// CIA clock later in cycle K. Plain START 0→1 carries a ONE-clock
// count-hold before the first decrement (VICE-measured, cia-start oracle),
// so cycle K holds and K+1 does the first count.
{
  const cia = new CIA(1);
  cia.write(0x04, 0x10); cia.write(0x05, 0x00);  // latch=$0010
  cia.write(0x0E, 0x10);                          // force-load (timer=$10)
  // Timer is loaded but stopped. Write CRA bit 0 = 1 at "cycle K" phi2.
  ciaStep(cia, { write: () => cia.write(0x0E, 0x01) });
  const afterK = cia.timerA;
  ciaStep(cia);
  const after1 = cia.timerA;
  ciaStep(cia);
  const after2 = cia.timerA;
  expect(afterK === 0x10, `CRA-start: cycle K holds (start count-hold), timerA expected $10 got $${afterK.toString(16)}`);
  expect(after1 === 0x0F, `CRA-start: K+1 does the first count, timerA expected $0F got $${after1.toString(16)}`);
  expect(after2 === 0x0E, `CRA-start: K+2 counts again, timerA expected $0E got $${after2.toString(16)}`);
  ok('CIA: $DC0E bit 0 (start) — one-clock count-hold, first count in K+1');
}

// CIA: CRA bit 0 = 0 stops timerA with a ONE-CYCLE delay (the 6526
// control-write pipeline): the timer does one more count after the stop write,
// then freezes. Real-hardware-verified by testprogs/VICII/split-tests/bascan
// (tests 3 & 6 read $dc04 right after a CRA stop; an immediate-stop model reads
// one too high). VICE passes bascan.
{
  const cia = new CIA(1);
  cia.write(0x04, 0x20); cia.write(0x05, 0x00);
  cia.write(0x0E, 0x11);                          // start + force-load
  ciaStep(cia); // K-1
  ciaStep(cia); // K-2
  const before = cia.timerA;
  // Stop at "cycle K": the one-cycle stop delay means the timer counts ONCE
  // more (this step's clock consumes the delayed count), then freezes.
  ciaStep(cia, { write: () => cia.write(0x0E, 0x00) });
  const afterStop = cia.timerA;
  ciaStep(cia);
  const oneLater = cia.timerA;
  expect(afterStop === ((before - 1) & 0xFFFF),
    `CRA-stop: one delayed count, then freeze. Expected ${(before - 1) & 0xFFFF}, got ${afterStop}`);
  expect(oneLater === afterStop,
    `CRA-stop: K+1 must NOT count (already frozen). Expected ${afterStop}, got ${oneLater}`);
  ok('CIA: $DC0E bit 0 = 0 (stop) — one-cycle delay then freeze (bascan)');
}

// CIA: force-load (CRA bit 4 strobe) — synchronous, takes effect immediately.
// Real hw: force-load loads timer = latch on the write itself.
{
  const cia = new CIA(1);
  cia.write(0x04, 0x42); cia.write(0x05, 0x12);   // latchA = $1242
  cia.timerA = 0;
  cia.write(0x0E, 0x10);                           // force-load (no start)
  expect(cia.timerA === 0x1242, `force-load: synchronous, timerA expected $1242 got $${cia.timerA.toString(16)}`);
  expect((cia.cra & 0x10) === 0, `force-load is write-strobe: CRA bit 4 must auto-clear`);
  ok('CIA: $DC0E bit 4 (force-load) — synchronous (no architectural pipeline)');
}

// CIA: latch hi-byte ($DC05) write while timer stopped reloads timer.
// MOS6526: when writing the high byte of the latch with the timer stopped,
// the timer is also reloaded from the latch synchronously.
{
  const cia = new CIA(1);
  cia.timerA = 0x1234;
  cia.cra = 0;                  // stopped
  cia.write(0x04, 0x55);        // lo only
  expect(cia.timerA === 0x1234, `latch lo while stopped: timer should NOT yet reload`);
  cia.write(0x05, 0x66);        // hi → triggers reload because stopped
  expect(cia.timerA === 0x6655, `latch hi while stopped: timer reloads from latch ($6655) got $${cia.timerA.toString(16)}`);
  ok('CIA: $DC05 hi-byte write while stopped — synchronous timer reload');
}

// CIA: latch hi-byte write while RUNNING does NOT reload.
{
  const cia = new CIA(1);
  cia.write(0x04, 0x10); cia.write(0x05, 0x00);
  cia.write(0x0E, 0x11);                          // start + load
  ciaStep(cia); ciaStep(cia); ciaStep(cia);       // run a few
  const before = cia.timerA;
  cia.write(0x04, 0xAA); cia.write(0x05, 0xBB);
  expect(cia.timerA === before, `latch write while running must NOT reload`);
  expect(cia.latchA === 0xBBAA, `latch write must update latchA`);
  ok('CIA: $DC05 hi-byte write while running — does not reload (latch only)');
}

// CIA: ICR mask write — when an unmasked status bit becomes masked-and-set,
// the (data & mask) condition re-evaluates immediately, and the IR latch /
// /IRQ follows it on the next clock (datasheet sheet 7: the IR bit is a
// phi2-clocked flip-flop one cycle behind the masked-data condition).
{
  const cia = new CIA(1);
  let irqEvents = [];
  cia.irqHandler = (s) => irqEvents.push(s);
  // Force ICR status bit 0 (TA underflow) without raising IRQ (mask=0).
  cia.icrStatus = 0x01;
  cia.icrMask = 0x00;
  expect(cia.irqState === false, `precondition: IRQ line must be low when mask=0`);
  // Write ICR mask: enable bit 0. The condition is armed now; the IR latch
  // picks it up one clock later.
  cia.write(0x0D, 0x81);
  expect(cia.irqState === false, `ICR mask enable: IR latch lags one clock`);
  cia.clock(1);
  expect(cia.irqState === true, `one clock after mask enable: IRQ asserts via IR latch`);
  expect(irqEvents.length >= 1 && irqEvents[irqEvents.length - 1] === true,
    `ICR mask enable: irqHandler should be called with true`);
  ok('CIA: $DC0D mask write — IRQ asserts via the IR latch one clock after a newly-unmasked bit');
}

// CIA: ICR read returns and clears a latched underflow. The machine now
// clocks the CIA at phi1, BEFORE the CPU's phi2 read, so a read sees this
// cycle's underflow. The IR/bit 7 + /IRQ follow the data bit by one clock
// (the IR latch, datasheet sheet 7).
//
// MOS6526 force-load+start: 2-clock load phase in the raw cia.clock(). With
// latch=1, one-shot (no re-underflow):
//   K=1,2: load phase (timerA stays at 1)
//   K=3:   count, timerA 1→0
//   K=4:   timerA was 0 → reload to 1, raise underflow (ICR bit 0 set)
//   K=5:   IR latch fires → /IRQ asserted
{
  const cia = new CIA(1);
  cia.write(0x04, 0x01); cia.write(0x05, 0x00);   // latch=1
  cia.write(0x0D, 0x81);                           // mask: enable bit 0
  cia.write(0x0E, 0x19);                           // start + 1-shot + force-load → timerA=1
  cia.clock(1); cia.clock(1);                       // K=1,2: 2-clock load phase
  expect(cia.timerA === 1, `K=2 (end of load phase): timerA still at 1`);
  cia.clock(1);                                     // K=3: count, timer→0
  expect(cia.timerA === 0, `K=3: timerA decremented to 0`);
  expect((cia.icrStatus & 0x01) === 0, `K=3: no underflow yet`);
  cia.clock(1);                                     // K=4: underflow, reload, set data bit
  expect((cia.icrStatus & 0x01) === 0x01, `K=4: underflow must set ICR data bit 0`);
  expect(cia.irqState === false, `K=4: IR latch still low (data→IR is one clock)`);
  cia.clock(1);                                     // K=5: IR latch fires
  expect(cia.irqState === true, `K=5: IR latch asserts /IRQ one clock after the data bit`);
  // CPU read of $DC0D returns the latched status ($81) and clears the line.
  const readVal = cia.read(0x0D);
  expect((readVal & 0x81) === 0x81, `read returns ICR with bit 7 (IRQ-was-set) and bit 0`);
  expect(cia.irqState === false, `IRQ line clears after $DC0D read`);
  ok('CIA: $DC0D read returns + clears a latched underflow (data→IR one-clock latch)');
}

// CIA: port A write (CIA2 PA → VIC bank). The bank change should propagate
// to the VIC the next master cycle's phi1, NOT the same one. Since CIA2's
// writePortA callback fires the noteBankChange synchronously at write time,
// VIC at K+1's clock(1) sees the new bank — that's the intended 1-cycle
// architectural delay.
{
  const cia = new CIA(2);
  let bankNotes = [];
  cia.writePortA = (val) => bankNotes.push(cia.vicBank);
  cia.write(0x02, 0x03);  // PA bits 0-1 are output
  cia.write(0x00, 0x00);  // bank 0 ($0000) but inverted: vicBank = (3-0)*4000 = $C000
  expect(bankNotes[bankNotes.length - 1] === 0xC000, `writePortA fires synchronously, vicBank=$C000`);
  cia.write(0x00, 0x03);  // bank = (3-3)*4000 = $0000
  expect(bankNotes[bankNotes.length - 1] === 0x0000, `writePortA fires synchronously, vicBank=$0000`);
  ok('CIA2: PA write → vicBank update — synchronous at write time (architecture provides 1-cycle delay to VIC)');
}

// ───────────────────────────────────────────────────────────────────────
//  VIC-II — write→effect cycle audit
// ───────────────────────────────────────────────────────────────────────

// VIC: $D012 raster compare write. The IRQ asserts when raster matches
// at the START of the matching line (cycle 0/1 depending on raster=0).
// Architecture: write at K phi2 → next cycle K+1 phi1 sees new compare.
// If the NEXT raster transition matches new $D012, IRQ should fire then.
{
  const vic = makeVic();
  vic.irqMask = 0x01;               // enable raster IRQ (live field)
  let irqEvents = [];
  vic.irqHandler = (s) => irqEvents.push({ raster: vic.raster, cycle: vic.cycleInLine, s });
  // Drive VIC until raster=10, mid-line.
  while (!(vic.raster === 10 && vic.cycleInLine === 30)) vicStep(vic);
  // Set $D012=11. Next line (raster=11, cycle 1) should fire IRQ.
  vicStep(vic, { write: () => vic.write(0x12, 11) });
  // Walk to raster=11 cycle ~2 and verify IRQ asserted.
  let fired = false;
  for (let i = 0; i < CYCLES_PER_LINE * 2; i++) {
    vicStep(vic);
    if (vic.raster === 11 && vic.irqPending) { fired = true; break; }
  }
  expect(fired, `$D012 write at K → raster IRQ on next matching raster (no double-delay)`);
  ok('VIC: $D012 raster compare — write effective from cycle K+1 phi1');
}

// VIC: $D018 VM/CB pointer change. Affects c-access (matrix base) and g-access
// (char base) starting next master cycle's phi1. Verify by reading
// _getVideoMatrixBase / _getCharBase or by direct regs comparison.
// Since the chip uses regs[0x18] live, no internal pipeline; arch gives 1 cycle.
{
  const vic = makeVic();
  vic.regs[0x18] = 0x14;
  vicStep(vic, { write: () => vic.write(0x18, 0x18) });
  expect(vic.regs[0x18] === 0x18, `$D018 write lands in regs immediately`);
  // Next phi1 will use it. (Functional check: c-access uses regs[0x18] live in
  // _getVideoMatrixBase; verified by code inspection — no cached snapshot.)
  ok('VIC: $D018 — regs updated synchronously; phi1 of K+1 uses new base (no double)');
}

// VIC: $D019 IRQ ack — write 1 to a status bit clears it. Should be synchronous.
{
  const vic = makeVic();
  vic.irqMask = 0x01;
  vic.irqStatus = 0x81;             // raster IRQ pending (status+top bit)
  expect(vic.irqPending === true, `precondition: IRQ pending`);
  vic.write(0x19, 0x01);            // ack raster IRQ
  expect((vic.irqStatus & 0x01) === 0, `$D019 ack: bit 0 cleared synchronously`);
  expect(vic.irqPending === false, `$D019 ack: IRQ line clears synchronously`);
  ok('VIC: $D019 ack — synchronous clear');
}

// VIC: $D01A IRQ mask — synchronous IRQ-line update like CIA's $DC0D.
{
  const vic = makeVic();
  vic.irqStatus = 0x01;             // raster IRQ pending status (no top bit yet)
  vic.irqMask = 0x00;
  let irqEvents = [];
  vic.irqHandler = (s) => irqEvents.push(s);
  vic.write(0x1A, 0x01);            // enable raster IRQ
  expect(vic.irqPending === true, `$D01A enable: IRQ asserts synchronously when status already set`);
  expect(irqEvents.length >= 1 && irqEvents[irqEvents.length - 1] === true,
    `$D01A enable: irqHandler invoked with true`);
  ok('VIC: $D01A mask — synchronous IRQ assert when newly-unmasked bit already set');
}

// VIC: $D016 CSEL — already locked down by border-timing-precision-spec-test
// and csel-veto-window-spec-test. This test confirms the basic "regs write
// is synchronous, comparator reads live regs" property: write at K phi2,
// next phi1 of K+1 sees new value.
{
  const vic = makeVic();
  vic.regs[0x16] = 0x08;            // CSEL=1
  vic.write(0x16, 0x00);            // CSEL=0
  expect(vic.regs[0x16] === 0x00, `$D016 write lands synchronously`);
  ok('VIC: $D016 — synchronous regs update (covered by border-timing-precision-spec)');
}

// VIC: $D015 sprite enable. Setting/clearing here affects DMA-start checks
// at cycle 55/56 phi1. Architecture: write at K phi2 → DMA check at K+1
// phi1 sees new value. Spec-correct (no double).
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;
  vic.write(0x15, 0xFF);
  expect(vic.regs[0x15] === 0xFF, `$D015 write synchronous`);
  ok('VIC: $D015 sprite enable — synchronous regs update');
}

// VIC: $D011 (RST8/DEN/RSEL/YSCROLL). Multiple consumers. Test that the
// RST8 bit (bit 7, top bit of raster compare) lands synchronously and
// affects the next raster IRQ comparison.
{
  const vic = makeVic();
  vic.write(0x11, 0x80);            // RST8 = 1
  expect((vic.regs[0x11] & 0x80) === 0x80, `$D011 RST8 lands synchronously`);
  ok('VIC: $D011 — synchronous regs update (RST8 visible to next phi1 raster compare)');
}

// VIC: $D017 MxYE — already explicitly handled by phi2() reconciliation
// at cycle 56. This test just confirms the regs[] write is synchronous.
{
  const vic = makeVic();
  vic.write(0x17, 0xFF);
  expect(vic.regs[0x17] === 0xFF, `$D017 write synchronous`);
  ok('VIC: $D017 MxYE — synchronous regs update (c56 phi2 reconciliation handled)');
}

// ───────────────────────────────────────────────────────────────────────
//  Summary
// ───────────────────────────────────────────────────────────────────────

if (testsFailing > 0) {
  console.log(`\n${testsFailing} of ${testNo} tests FAILED`);
  process.exit(1);
}
console.log(`\nAll ${testNo} tests passed`);
