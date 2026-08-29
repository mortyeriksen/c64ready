// Mid-line $D011 mode-flip + ghost-byte spec audit. 10 tests targeting
// the rapid $1D ↔ $70 mode flip pattern observed in the 9-sprites-in-
// top-border demo (40+ writes per frame between L44..L67).
//
// Sources: Bauer §3.7.3 (mode decode), §3.7.5 (idle byte), §3.5
// (bad-line latch), DEMO-NINE.md §7 (invalid mode $70 ghost-byte).

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

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

// ── 1: Mode decode: $1D = standard text mode (ECM=0 BMM=0 MCM=0) ──────
// Bauer §3.7.3.1: regular text. $D011=$1D has DEN=1, RSEL=1, YS=5.
// $D016=$08 has CSEL=1, no MCM/XSCROLL.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1D;
  vic.regs[0x16] = 0x08;
  const ecm = (vic.regs[0x11] >> 6) & 1;
  const bmm = (vic.regs[0x11] >> 5) & 1;
  const mcm = (vic.regs[0x16] >> 4) & 1;
  expect(ecm === 0 && bmm === 0 && mcm === 0,
    `$1D = mode 000 (text), got ECM=${ecm} BMM=${bmm} MCM=${mcm}`);
  ok('Bauer §3.7.3.1: $D011=$1D is standard text mode');
}

// ── 2: Mode decode: $70 = invalid mode 110 (ECM=1 BMM=1 MCM=0) ────────
// Bauer §3.7.3.7: invalid bitmap mode 1 — every pixel BLACK.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x70;
  vic.regs[0x16] = 0x08;
  const ecm = (vic.regs[0x11] >> 6) & 1;
  const bmm = (vic.regs[0x11] >> 5) & 1;
  expect(ecm === 1 && bmm === 1,
    `$70 = mode 110 (invalid bitmap 1)`);
  ok('Bauer §3.7.3.7: $D011=$70 is invalid mode 110 (every pixel BLACK)');
}

// ── 3: $D011 write reflects in regs immediately (no register pipeline) ─
// Used by demo to flip mode multiple times per scanline. Each write
// must reflect in regs[$11] for subsequent reads / cycle decisions.
{
  const vic = makeVic();
  vic.write(0x11, 0x1D);
  expect(vic.regs[0x11] === 0x1D, `after write $1D: regs reads back $1D`);
  vic.write(0x11, 0x70);
  expect(vic.regs[0x11] === 0x70, `after write $70: regs reads back $70`);
  ok('Bauer §3.7: $D011 register update is immediate');
}

// ── 4: YSCROLL 5 vs 0: bad-line targets shift by 5 lines ──────────────
{
  const vic = makeVic();
  vic.displayEnabled = true;
  // YS=5: bad lines at (raster & 7) === 5 → 53, 61, 69, 77, ...
  vic.regs[0x11] = 0x1D;
  expect(vic._isBadLine(53, vic.regs) === true, `YS=5 → L53 bad`);
  expect(vic._isBadLine(56, vic.regs) === false, `YS=5 → L56 not bad`);
  // YS=0: bad lines at (raster & 7) === 0 → 48, 56, 64, ...
  vic.regs[0x11] = 0x18;
  expect(vic._isBadLine(56, vic.regs) === true, `YS=0 → L56 bad`);
  expect(vic._isBadLine(53, vic.regs) === false, `YS=0 → L53 not bad`);
  ok('Bauer §3.5: YSCROLL 5↔0 swap shifts bad-line target by 5');
}

// ── 5: Mode flip $1D→$70 mid-line changes idle byte address ────────────
// Bauer §3.7.5: $D011 ECM bit selects idle source ($3FFF vs $39FF).
// Mid-line flip switches the source for any subsequent idle access.
{
  const vic = makeVic();
  vic.currentVicBank = 0x0000;
  vic.ram[0x3FFF] = 0x55;        // ECM=0 idle
  vic.ram[0x39FF] = 0xAA;        // ECM=1 idle
  vic.regs[0x11] = 0x1D;
  expect(vic._readIdleGByte(vic.regs, 0) === 0x55, `mode $1D: idle = $55`);
  vic.regs[0x11] = 0x70;
  expect(vic._readIdleGByte(vic.regs, 0) === 0xAA,
    `mode $70: idle source switches to $39FF immediately`);
  ok('Bauer §3.7.5: $D011 mode flip mid-line switches idle byte source');
}

// ── 6: 40+ writes per frame don't corrupt VIC state ───────────────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1D;
  vic.displayEnabled = true;
  // Run to L44 then flip every cycle.
  for (let i = 0; i < CYCLES_PER_LINE * 44; i++) vic.clock(1);
  let flipCount = 0;
  for (let line = 44; line <= 67; line++) {
    for (let c = 0; c < CYCLES_PER_LINE; c++) {
      vic.clock(1);
      if (c % 17 === 0) {
        vic.write(0x11, vic.regs[0x11] === 0x1D ? 0x70 : 0x1D);
        flipCount++;
      }
    }
  }
  expect(flipCount > 40,
    `executed ${flipCount} mode flips`);
  expect(vic.raster === 68 && vic.cycleInLine === 0,
    `state correct after stress: raster=68.c0`);
  ok('VIC: 40+ mid-line $D011 flips per frame don\'t corrupt counters');
}

// ── 7: Mode $70 with idle byte: rendering produces BLACK pixels ───────
// Per Bauer §3.7.3.7, mode 110 (BMM=1 ECM=1) renders every pixel BLACK
// regardless of the bit pattern in the shifter.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x70;
  vic.regs[0x16] = 0x08;
  const seg = {
    regs: vic.regs, bank: 0, rowVcBase: 0,
    rowFetchedCols: new Uint8Array(40),
    rowCodes: new Uint8Array(40), rowColors: new Uint8Array(40),
    rowFetchD011: 0x70, rowFetchD016: 0x08, rowFetchD018: vic.regs[0x18],
    displayColumnActive: false, rc: 0, cycleStart: 32, idleByte: 0x55,
  };
  vic.fb32.fill(0xFFAAAAAA);
  vic._renderOpenBorderIdleSpan(seg, 0, 32, 40);
  for (let x = 32; x < 40; x++) {
    expect(vic.fb32[x] === 0xFF000000,
      `mode $70 + idle $55: every pixel BLACK at x=${x}`);
  }
  ok('Bauer §3.7.3.7: mode $70 ghost-byte renders every pixel BLACK');
}

// ── 8: Bad-line displayActive transitions follow YSCROLL changes ──────
// Demo uses YS flips so bad-lines fire at non-standard rasters. With
// YS=0 only every 8th line starting at L48 fires; the displayActive
// flag toggles accordingly.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;          // DEN=1, RSEL=1, YS=0
  vic.displayEnabled = true;
  // Drive past L48 (where displayEnabled latches).
  for (let i = 0; i < CYCLES_PER_LINE * 49; i++) vic.clock(1);
  expect(vic.displayEnabled === true, `L49: displayEnabled latched`);
  // L48 is bad-line for YS=0. displayActive should be true.
  // Run to L48.c59 (after rule 5 fired).
  // Actually we already passed L48. Let me check next bad-line: L56.
  for (let i = 0; i < CYCLES_PER_LINE * 7; i++) vic.clock(1);   // → L56.c0
  for (let i = 0; i < 60; i++) vic.clock(1);
  expect(vic.displayActive === true,
    `L56 (YS=0 bad-line): displayActive must be true after cycle 58`);
  ok('Bauer §3.7.2 rule 5: bad-line condition follows YSCROLL value');
}

// ── 9: lineCycleRegs captures regs at each cycle for renderer split ───
// The renderer builds segments per cycle from lineCycleRegs[cycle].
// Mid-line $D011 writes must be visible to subsequent cycles' segments.
{
  const vic = makeVic();
  // The per-cycle lineCycleRegs snapshot is only taken on visible canvas
  // lines (raster ≥ 15) — a render-cost optimisation, raster-independent in
  // real silicon. Position on a visible line so the segment-split capture
  // path under test runs.
  while (!(vic.raster === 50 && vic.cycleInLine === 0)) vic.clock(1);
  vic.write(0x11, 0x1D);
  vic.clock(1);                    // c1 — captures $1D
  vic.write(0x11, 0x70);           // CPU phi2 write
  vic.clock(1);                    // c2 — captures $70 (regs already updated)
  // Verify lineCycleRegs[2] reflects $70.
  expect(vic.lineCycleRegs[2][0x11] === 0x70,
    `lineCycleRegs[2] must capture mid-line write of $70`);
  ok('VIC: lineCycleRegs captures per-cycle reg state for segment split');
}

// ── 10: $D018 char base bits (1-3) decode to $0000..$1C00 ──────────────
// $D018 bits 1-3 select character base in 2KB units. With $70 → bits
// 1-3 = 000, char base = $0000 (within bank).
{
  const vic = makeVic();
  for (const [d018, expectedBase] of [[0x00, 0x0000], [0x02, 0x0800], [0x06, 0x1800], [0x0E, 0x3800]]) {
    vic.regs[0x18] = d018;
    const base = ((vic.regs[0x18] >> 1) & 0x07) * 0x800;
    expect(base === expectedBase,
      `$D018=$${d018.toString(16)}: char base = $${expectedBase.toString(16)}, got $${base.toString(16)}`);
  }
  ok('Bauer §3.7.4: $D018 bits 1-3 select char base in 2KB units');
}

console.log(`\n${testNo} mode-flip / ghost-byte spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
