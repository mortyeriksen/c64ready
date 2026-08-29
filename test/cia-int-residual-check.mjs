// DOCUMENTED KNOWN RESIDUAL (tracked, not a pass-by-correctness) — so it is not
// silently re-discovered.
//
// The TLR cia-int IRQ testprog (real-breadbox reference in its own source,
// interrupts/cia-int/cia-int.asm `test_reference`, NEWCIA=0 PAL old-CIA) once
// showed our IRQ-RECOGNITION window ~2 sub-cycles too NARROW at BOTH edges of
// each delivery band: real HW DELIVERS the IRQ (records a Timer-B latency
// value) where ours SWALLOWS it (records $2d = "-"). The ICR read VALUE itself
// is correct (the $Dx0D row matches perfectly — pinned by cia-irq-ackn-bug).
// 2026-07-02: the TRAILING band edges (T1 c10-11, T2 c11-12, T3 c12-13,
// T4 c13-14, T5 c14-15) were FIXED by the poll-visible-I pipeline model
// (_pollI — CLI/SEI/PLP write I after their own poll; irqdma test6/test7
// real-C64 dumps at 0/16384). Remaining divergent cells — the LEADING band
// edges only (real-HW value / ours always $2d):
//   T2: c2-4=$84
//   T3: c2-5=$85
//   T5: c2-4=$85   (10 cells)
// Root of the remainder: CPU interrupt-recognition × ack-read-clears-line race
// window (sub-cycle analog timing on real HW vs our cycle-discrete model).
// BENIGN — no demo reads $DC0D on a band-edge sub-cycle; the ack-bug + normal
// delivery are correct. Fix = sub-cycle recognition modeling = high-risk.
//
// This is a CHARACTERIZATION LOCK: it asserts the residual is UNCHANGED. If our
// behavior changes (residual fixed, worsened, or shifted) it FAILS — prompting
// an update here.
//
// It is a `*.mjs` tool, run by hand, so all-test.js does not pick it up — the
// suite carries no VICE-testprogs dependency. Run it when touching CIA
// interrupt recognition:
//
//   node test/cia-int-residual-check.mjs
//
// The residual it locks is documented above, so it stays tracked whether or not
// anyone has the testprog. The delivery-window behavior it characterizes is
// covered by the in-repo CIA specs (cia-irq-ackn-bug pins the ICR read value,
// cia-int-recognition and cia-irq-nmi-verified-behaviors the delivery bands).
import fs from 'fs';
import { C64Machine } from '../src/machine.js';
import { assetPath, missingNote } from './external-assets.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { testsFailing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`); currentFailures = []; }
}

const PRG = assetPath('cia-int-irq-prg');
const X = 0x2d;
const REF = [   // cia-int.asm test_reference, IRQ NEWCIA=0 (5 tests × [rowA=$DxxD, rowB=cycles/TB])
  [0x2d,0x2d,0x82,0x82,0x82,0x02,X,X,X,X,X,X,X,X,X,X,X,X,X,X,X,X,X,X],
  [0x81,0x81,0x83,0x83,0x2d,0x2d,0x89,0x89,0x89,0x89,0x8b,0x8b,X,X,X,X,X,X,X,X,X,X,X,X],
  [0x2d,0x2d,0x82,0x82,0x82,0x02,X,X,X,X,X,X,X,X,X,X,X,X,X,X,X,X,X,X],
  [0x81,0x81,0x84,0x84,0x84,0x2d,0x8a,0x8a,0x8a,0x8a,0x8a,0x8c,0x8c,X,X,X,X,X,X,X,X,X,X,X],
  [0x2d,0x2d,0x82,0x82,0x82,0x82,0x02,X,X,X,X,X,X,X,X,X,X,X,X,X,X,X,X,X],
  [0x81,0x81,0x85,0x85,0x85,0x85,0x2d,0x8b,0x8b,0x8b,0x8b,0x8b,0x8d,0x8d,X,X,X,X,X,X,X,X,X,X],
  [0x2d,0x2d,0x82,0x82,0x82,0x82,0x02,X,X,X,X,X,X,X,X,X,X,X,X,X,X,X,X,X],
  [0x81,0x81,0x2d,0x2d,0x2d,0x2d,0x2d,0x8c,0x8c,0x8c,0x8c,0x8c,0x8c,0x8e,0x8e,X,X,X,X,X,X,X,X,X],
  [0x2d,0x2d,0x82,0x82,0x82,0x02,X,X,X,X,X,X,X,X,X,X,X,X,X,X,X,X,X,X],
  [0x81,0x81,0x85,0x85,0x85,0x2d,0x88,0x88,0x88,0x8d,0x8d,0x8d,0x8d,0x8d,0x8f,0x8f,X,X,X,X,X,X,X,X],
];
const TEST_ROWS = [3, 7, 11, 15, 19];
// Known residual: (refRowIdx, col, refVal). Every one: ours must be $2d
// (swallow). Leading band edges only — the trailing edges were fixed by the
// poll-visible-I pipeline (see header).
const KNOWN = [
  [3,2,0x84],[3,3,0x84],[3,4,0x84],
  [5,2,0x85],[5,3,0x85],[5,4,0x85],[5,5,0x85],
  [9,2,0x85],[9,3,0x85],[9,4,0x85],
];

if (!PRG) {
  testNo++;
  console.log(`cia-int edge residual — not run: ${missingNote('cia-int-irq-prg')}`);
  console.log(`(the residual itself is documented in this file's header)`);
} else {
  const m = new C64Machine();
  m.loadROMs({ kernal: fs.readFileSync('roms/kernal.bin'), basic: fs.readFileSync('roms/basic.bin'), charRom: fs.readFileSync('roms/chargen.bin') });
  for (let i = 0; i < 150; i++) m.runFrame();
  const loadAddr = m.loadPRG(fs.readFileSync(PRG)); m.injectRun();
  let stx = -1;
  for (let a = loadAddr; a < loadAddr + 4000; a++) if (m.mem.ram[a] === 0x8e && m.mem.ram[a+1] === 0xff && m.mem.ram[a+2] === 0xd7) { stx = a; break; }
  let snap = null;
  const orig = m.cpu.clock.bind(m.cpu);
  m.cpu.clock = function () { if (stx >= 0 && this.atInstructionBoundary() && this.pc === stx) snap = m.mem.ram.slice(0x0400, 0x0400 + 25 * 40); return orig(); };
  for (let i = 0; i < 400; i++) m.runFrame();

  expect(!!snap, 'cia-int-irq verdict captured');
  if (snap) {
    // (a) The $DxxD (ICR-value) rows must match real HW EXACTLY (correct).
    let icrMism = 0;
    for (let t = 0; t < 5; t++) for (let c = 0; c < 24; c++) if (snap[TEST_ROWS[t] * 40 + c] !== REF[t * 2][c]) icrMism++;
    expect(icrMism === 0, `ICR-value ($DxxD) rows must match real HW exactly; got ${icrMism} mismatches`);

    // (b) The KNOWN residual must be present & unchanged: every known cell =
    //     real-HW delivers (ref != $2d) and ours swallows ($2d).
    const refRowToScreen = i => TEST_ROWS[(i - 1) / 2 | 0] + 1;   // odd REF idx = the cycles/TB row
    let stillKnown = 0;
    for (const [ri, col, refVal] of KNOWN) {
      const ours = snap[refRowToScreen(ri) * 40 + col];
      if (REF[ri][col] === refVal && ours === X) stillKnown++;
    }
    expect(stillKnown === KNOWN.length,
      `recognition-edge residual UNCHANGED: ${stillKnown}/${KNOWN.length} known cells still "real-HW delivers / ours $2d". ` +
      `If this dropped, the residual changed — update this lock + IRQ-CIA-NMI-chain.md §7b.`);

    // (c) No OTHER mismatch should have appeared in the TB rows (residual hasn't spread).
    let extra = 0;
    for (let t = 0; t < 5; t++) {
      const srow = TEST_ROWS[t] + 1, ri = t * 2 + 1;
      for (let c = 0; c < 24; c++) {
        const ours = snap[srow * 40 + c];
        if (ours !== REF[ri][c] && !KNOWN.some(k => k[0] === ri && k[1] === c)) extra++;
      }
    }
    expect(extra === 0, `no NEW TB-row mismatches beyond the known residual; got ${extra} unexpected`);
  }
  ok('cia-int IRQ recognition-edge residual present & unchanged (10 leading-edge cells; ICR value correct; trailing edges fixed by _pollI) — KNOWN/tracked');
}

console.log(`\n${testNo} cia-int residual lock; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
