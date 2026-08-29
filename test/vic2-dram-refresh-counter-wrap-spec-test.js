// Bauer §3.13 — DRAM refresh.
//
// "The VIC has to perform five read accesses for the refreshing of the dynamic
//  RAM in every raster line ... There is an 8 bit refresh counter (REF) ... It
//  is reset to $ff in raster line 0 and decremented by 1 after each refresh
//  access." The refresh address is $3F00 | REF, formed from the counter value
//  BEFORE it is decremented (so raster line 0 emits $3FFF, $3FFE, ... $3FFB).
//
// vic2-nine-demo-deps already pins the line-0 reset and the $3FFF..$3FFB walk.
// This file additionally pins the parts that were only IMPLICITLY covered:
//   (b) the explicit REF underflow WRAP $00 -> $FF, and
//   (c) that exactly five refresh accesses occur per line (REF drops by 5/line).
//
// Refresh accesses are observed via vic.lastRefreshAddr / vic.refreshCounter.

import { makeVic, assert } from './_vic2-helpers.js';

// (a) §3.13: REF reset to $FF in raster line 0; line 0 walks $3FFF..$3FFB on
//     cycles 11..15; counter is $FA afterwards. (Regression-mirror of
//     nine-demo-deps so this file stands alone.)
{
  const vic = makeVic();
  vic.clock(10);
  assert(vic.cycleInLine === 10 && vic.raster === 0,
    `refresh setup: expected cyc=10 line=0, got cyc=${vic.cycleInLine} line=${vic.raster}`);

  const expected = [0x3FFF, 0x3FFE, 0x3FFD, 0x3FFC, 0x3FFB];
  for (let i = 0; i < 5; i++) {
    vic.clock(1);                       // cycles 11..15
    assert(vic.lastRefreshAddr === expected[i],
      `§3.13 line-0 refresh: cycle ${11 + i} address must be $${expected[i].toString(16).toUpperCase()}, ` +
      `got $${(vic.lastRefreshAddr ?? 0).toString(16).toUpperCase()}`);
  }
  assert(vic.refreshCounter === 0xFA,
    `§3.13: REF reset to $FF at line 0 then -5 must give $FA, got $${vic.refreshCounter.toString(16).toUpperCase()}`);
  console.log('ok  - §3.13 REF resets to $FF in line 0, walks $3FFF..$3FFB, ends $FA');
}

// (b) §3.13: REF underflow WRAPS $00 -> $FF. Park REF at $02 on a non-zero
//     raster line (so the line-0 reset can't interfere), then drive the five
//     refresh cycles 11..15. The pre-decrement address sequence must cross the
//     boundary $3F02, $3F01, $3F00, $3FFF, $3FFE, leaving REF at $FD.
{
  const vic = makeVic();
  vic.clock(10);   // raster 0, cycle 10
  vic.clock(63);   // raster 1, cycle 10 (no REF reset off raster 0)
  assert(vic.raster === 1 && vic.cycleInLine === 10,
    `wrap setup: expected raster=1 cyc=10, got raster=${vic.raster} cyc=${vic.cycleInLine}`);

  vic.refreshCounter = 0x02;            // park REF just above underflow

  const expected = [0x3F02, 0x3F01, 0x3F00, 0x3FFF, 0x3FFE];
  for (let i = 0; i < 5; i++) {
    vic.clock(1);                       // cycles 11..15
    assert(vic.lastRefreshAddr === expected[i],
      `§3.13 REF underflow wrap: cycle ${11 + i} address must be $${expected[i].toString(16).toUpperCase()}, ` +
      `got $${(vic.lastRefreshAddr ?? 0).toString(16).toUpperCase()}`);
  }
  // $02 -> 01 -> 00 -> FF -> FE -> FD over five pre-decrement accesses.
  assert(vic.refreshCounter === 0xFD,
    `§3.13: after wrapping through $00, REF must be $FD, got $${vic.refreshCounter.toString(16).toUpperCase()}`);
  console.log('ok  - §3.13 REF underflow wraps $00 -> $FF ($3F00 then $3FFF)');
}

// (c) §3.13: exactly FIVE refresh accesses per raster line — REF decreases by
//     exactly 5 from one line to the same cycle of the next.
{
  const vic = makeVic();
  vic.clock(10);   // raster 0, cycle 10
  vic.clock(63);   // raster 1, cycle 10
  vic.clock(5);    // raster 1, cycle 15 (line 1's 5 refreshes just completed)
  assert(vic.raster === 1 && vic.cycleInLine === 15,
    `5/line setup: expected raster=1 cyc=15, got raster=${vic.raster} cyc=${vic.cycleInLine}`);
  const refLine1 = vic.refreshCounter;

  vic.clock(63);   // advance one full raster line to raster 2, cycle 15
  assert(vic.raster === 2 && vic.cycleInLine === 15,
    `5/line setup: expected raster=2 cyc=15, got raster=${vic.raster} cyc=${vic.cycleInLine}`);
  const refLine2 = vic.refreshCounter;

  assert(((refLine1 - refLine2) & 0xFF) === 5,
    `§3.13: exactly 5 refresh accesses per line — REF must drop by 5 (got ` +
    `$${refLine1.toString(16).toUpperCase()} -> $${refLine2.toString(16).toUpperCase()}, ` +
    `delta ${((refLine1 - refLine2) & 0xFF)})`);
  console.log('ok  - §3.13 exactly 5 refresh accesses per raster line (REF -5/line)');
}

console.log('All DRAM refresh counter (§3.13 wrap + 5/line) tests passed.');
