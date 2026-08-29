// Raster-IRQ → STA $D016 cycle-alignment guard.
//
// This is the BA/RDY-timing concern translated into a CI guard. It was
// written alongside a characterization test that ran VICE-testprogs'
// sbsprf24-164.prg; that one is gone (the suite carries no external PRGs),
// so this is now the whole of the coverage. Self-contained — no ROMs, no
// fixture — it pins two invariants directly via a vic.write hook:
//
//   1. Across many frames, every STA $D016 from the IRQ handler lands
//      at the SAME (cycle-in-line, raster) tuple — stable-IRQ doesn't
//      mean "low jitter on average", it means "zero jitter, period".
//   2. The cycle is exactly the value derived from the documented
//      timing chain:
//        raster IRQ fires at cycle 1 of the latched line
//        + handler-entry overhead (CPU current-instr completion + 7 cyc
//          hardware IRQ entry)
//        + first-handler-instruction cycles up to (but not including)
//          the STA's write cycle.
//      If a future model change shifts ANY component by even one cycle,
//      one of these two assertions breaks.

import { C64Machine } from '../src/machine.js';

let testNo = 0, failing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { failing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

// Build a self-contained scenario: no ROMs needed. CPU runs a tight 3-
// cycle JMP-self loop at $1000 with I=0; a raster IRQ fires at line $30
// and dispatches through the IRQ vector at $FFFE/$FFFF → handler at
// $C000 (PHA / STA $D016 / PLA / RTI). $0001 is set so $E000-$FFFF
// reads from RAM (no KERNAL).
function makeScenario({ targetRaster = 0x30, handlerPaddingNops = 0 } = {}) {
  const machine = new C64Machine();
  // Bypass ROM-gated runFrame.
  machine.ready = true;

  const ram = machine.mem.ram;
  // CPU loop @ $1000: JMP $1000 (3 cyc, deterministic 3-cycle period)
  ram[0x1000] = 0x4C; ram[0x1001] = 0x00; ram[0x1002] = 0x10;

  // IRQ handler @ $C000:
  //   PHA              [3 cyc]
  //   LDA #$01         [2 cyc]
  //   STA $D019        [4 cyc] — ACK the raster latch (W1C). Without
  //                    this the latch stays set, I=0 on RTI re-takes
  //                    the IRQ, and the handler re-fires across the
  //                    rest of the frame.
  //   { NOP * N }       [N * 2 cyc]   <- optional cycle padding
  //   STA $D016        [4 cyc, write fires on 4th cycle]
  //   PLA              [4 cyc]
  //   RTI              [6 cyc]
  let p = 0xC000;
  ram[p++] = 0x48;                                            // PHA
  ram[p++] = 0xA9; ram[p++] = 0x01;                           // LDA #$01
  ram[p++] = 0x8D; ram[p++] = 0x19; ram[p++] = 0xD0;          // STA $D019 (ACK)
  for (let i = 0; i < handlerPaddingNops; i++) ram[p++] = 0xEA; // NOP
  ram[p++] = 0x8D; ram[p++] = 0x16; ram[p++] = 0xD0;          // STA $D016
  ram[p++] = 0x68;                                            // PLA
  ram[p++] = 0x40;                                            // RTI

  // IRQ vector @ $FFFE/$FFFF → $C000.
  ram[0xFFFE] = 0x00; ram[0xFFFF] = 0xC0;

  // Bring the CPU out of reset state and put it in the loop with I=0.
  // (cpu.reset() reads $FFFC/$FFFD which is RAM here = $0000, so PC=0;
  // we just override after reset.)
  machine.cpu.pc = 0x1000;
  machine.cpu.I = 0;
  // Drain the post-reset 7-cycle internal queue.
  for (let i = 0; i < 7; i++) machine.cpu.clock();

  // CPU port $0001: bit 0 LORAM, bit 1 HIRAM, bit 2 CHAREN.
  // Set to $35 = LORAM=1, HIRAM=0, CHAREN=1 → $E000-$FFFF is RAM,
  // $D000-$DFFF is I/O.
  machine.mem.write(0x0001, 0x35);

  // VIC: set raster IRQ target. Deliberately DEN=0 so there are no bad
  // lines — bad-line stalls shift CPU phase by `40 mod (JMP-period)`
  // cycles each, which would jitter the IRQ-take cycle across frames.
  // We're testing IRQ-entry/handler timing, not display.
  machine.vic2.regs[0x11] = 0x0B;     // DEN=0, RSEL=1, YSCROLL=3
  machine.vic2.regs[0x12] = targetRaster & 0xFF;
  machine.vic2.irqMask = 0x01;        // raster IRQ enabled
  // Clear any stale latch from the reset path.
  machine.vic2.irqStatus = 0;
  return machine;
}

function captureD016Writes(machine, framesToRun) {
  const vic = machine.vic2;
  const writes = [];
  const orig = vic.write.bind(vic);
  vic.write = function(reg, val) {
    if ((reg & 0x3F) === 0x16) {
      writes.push({ raster: vic.raster, cycle: vic.cycleInLine, val: val & 0xFF });
    }
    return orig(reg, val);
  };
  for (let f = 0; f < framesToRun; f++) machine.runFrame();
  return writes;
}

// ── 1: at least one $D016 write fires per frame ────────────────────────
{
  const machine = makeScenario();
  const writes = captureD016Writes(machine, 5);
  expect(writes.length >= 5,
    `expected ≥5 $D016 writes across 5 frames, got ${writes.length}`);
  ok(`raster-IRQ handler executes: captured ${writes.length} $D016 writes`);
}

// ── 2: zero jitter — every write lands at THE SAME (raster, cycle) ────
//      With a 3-cycle JMP-self loop and uniform raster-IRQ fire, the
//      current-instruction-completion jitter is 0..2. We don't predict
//      the exact landing cycle here; we pin the STABILITY — i.e., the
//      handler-entry is deterministic across frames once steady state
//      is reached. ANY drift across 20 frames is a model regression.
{
  const machine = makeScenario();
  const writes = captureD016Writes(machine, 20);
  expect(writes.length > 0, `need at least one write to compare`);
  if (writes.length > 0) {
    const ref = writes[0];
    const allSame = writes.every(w => w.raster === ref.raster && w.cycle === ref.cycle);
    expect(allSame,
      `every write must land at the same (raster=${ref.raster}, cycle=${ref.cycle}); ` +
      `got distribution: ${
        JSON.stringify(writes.reduce((m, w) => {
          const k = `r${w.raster}c${w.cycle}`;
          m[k] = (m[k] || 0) + 1; return m;
        }, {}))}`);
  }
  ok(`STA $D016 has zero cycle drift across 20 IRQ entries`);
}

// ── 3: handler-entry cycle math matches spec ──────────────────────────
//      Predicted landing cycle = (IRQ-fire cycle 1)
//                              + 7 (hardware IRQ entry)
//                              + 3 (PHA)
//                              + 2 (LDA #$01)
//                              + 4 (STA $D019 ACK)
//                              + 3 (STA $D016 opcode + addrLo + addrHi,
//                                   write fires on cycle 4 so we add 3)
//                              + jitter from CPU current-instruction
//                                completion (≤ 2 for a 3-cycle JMP-self
//                                loop with no bad-line stalls).
//      = 20 + jitter. We pin write cycle === 20 + 2 = 22 as the
//      observed steady-state value (the IRQ fires while the JMP loop
//      is consistently in phase 2 of its 3-cycle period). If a future
//      model change adds even one cycle anywhere in the IRQ-entry
//      sequence or the early-handler opcode lengths, this assertion
//      catches it.
{
  const machine = makeScenario({ handlerPaddingNops: 0 });
  const writes = captureD016Writes(machine, 5);
  expect(writes.length > 0, `need at least one write`);
  if (writes.length > 0) {
    const cycle = writes[0].cycle;
    expect(cycle === 22,
      `write cycle === 22 (= 7 hw-entry + 3 PHA + 2 LDA# + 4 ACK + 3 STA opcode + 2 JMP-jitter + 1 raster-IRQ fire cycle), got ${cycle}`);
  }
  ok(`handler-entry cycle math: write lands at the spec-predicted cycle 22`);
}

// ── 4: padding the handler shifts the write by exactly 2*N cycles ─────
//      Each NOP between PHA and STA adds 2 cycles. Confirms the
//      write-cycle is linearly responsive to handler content — i.e.
//      there's no hidden cycle absorber in our model.
{
  const baseline = captureD016Writes(makeScenario({ handlerPaddingNops: 0 }), 5)[0].cycle;
  const padded3  = captureD016Writes(makeScenario({ handlerPaddingNops: 3 }), 5)[0].cycle;
  const padded10 = captureD016Writes(makeScenario({ handlerPaddingNops: 10 }), 5)[0].cycle;
  expect(padded3 === baseline + 6,
    `+3 NOPs shifts write by +6 cyc (got ${padded3}, baseline ${baseline})`);
  expect(padded10 === baseline + 20,
    `+10 NOPs shifts write by +20 cyc (got ${padded10}, baseline ${baseline})`);
  ok(`handler NOP padding shifts write cycle linearly (2 cyc per NOP)`);
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
