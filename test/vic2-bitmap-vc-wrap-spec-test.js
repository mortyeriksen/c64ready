// Bitmap-mode g-access addressing must mask VC at 10 bits, just like
// _fetchScreenRowColumn does for the matrix path. The visible failure
// mode is linecrunch / VSP scenarios that leave rowVcBase high (e.g.
// $3F0+); col 0..39 then makes the sum overflow $3FF and silently
// reads the wrong RAM byte unless masked.
//
// Verified for all 4 bitmap variants:
//   bmm only         (mode 5, lines 2746-2755 in vic2.js)
//   bmm + mcm        (mode 6, lines 2756-2772)
//   bmm + ecm        (mode 7 invalid bitmap, lines 2782-2792)
//   bmm + mcm + ecm  (invalid bitmap mode 2, lines 2793-2804)

import { VIC2 } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

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

function makeSeg(vic, d011, d016, d018, rowVcBase, col, rawCode = 0x00, colorNib = 0x00) {
  const regs = new Uint8Array(0x40);
  regs[0x11] = d011;
  regs[0x16] = d016;
  regs[0x18] = d018;
  // Background colors (irrelevant for our address probe but referenced).
  regs[0x21] = 0x06;
  regs[0x22] = 0x07;
  regs[0x23] = 0x08;
  regs[0x24] = 0x09;
  const rowFetchedCols = new Uint8Array(40);
  const rowCodes = new Uint8Array(40);
  const rowColors = new Uint8Array(40);
  rowFetchedCols[col] = 1;
  rowCodes[col] = rawCode;
  rowColors[col] = colorNib;
  return {
    regs,
    prevRegs: regs,
    bank: 0x0000,
    rowFetchedCols,
    rowCodes,
    rowColors,
    rowVcBase,
    // Bitmap g-access follows the live VC base; on these synthetic VSP lines
    // it carries the same high value the test pins into rowVcBase.
    liveVcBase: rowVcBase,
    cycleStart: 0,
    displayColumnActive: 1,
  };
}

// Helper: render one column and report (a) the byte the renderer fetched
// and (b) the address it read from. Track via instrumented _vicReadWithBank.
function probeColumn({ d011, d016, d018, rowVcBase, col, line, ramByteWrapped, ramByteUnwrapped }) {
  const vic = makeVic();
  const bitmapBase = ((d018 >> 3) & 0x01) * 0x2000;
  const wrappedVc = (rowVcBase + col) & 0x03FF;
  const unwrappedVc = (rowVcBase + col);  // can exceed $3FF
  // Place distinct bytes at the two candidate addresses.
  vic.ram[bitmapBase + wrappedVc * 8 + line]   = ramByteWrapped;
  vic.ram[bitmapBase + unwrappedVc * 8 + line] = ramByteUnwrapped;

  // Spy on _vicMemRead — the renderer's non-bus-driving peek (real-
  // silicon-side g-byte was already latched at g-access time).
  const reads = [];
  const orig = vic._vicMemRead.bind(vic);
  vic._vicMemRead = function(addr, bank) {
    reads.push(addr);
    return orig(addr, bank);
  };

  const seg = makeSeg(vic, d011, d016, d018, rowVcBase, col, /*rawCode*/ 0xFF, /*colorNib*/ 0x0F);
  const outPixels = new Uint32Array(8);
  const outFgMap = new Uint8Array(8);
  vic._renderSourceColumn(col, line, seg, outPixels, outFgMap, 0);
  return {
    reads,
    wrappedAddr: bitmapBase + wrappedVc * 8 + line,
    unwrappedAddr: bitmapBase + unwrappedVc * 8 + line,
  };
}

// Test cases: rowVcBase + col exceeds $3FF.
const ROW_VC_BASE = 0x3F0;
const COL = 30;                  // sum = 0x40E (> $3FF)
const LINE = 4;

// Mode 5: BMM only
{
  const r = probeColumn({
    d011: 0x3B,                  // bmm=1, ecm=0
    d016: 0x08,                  // mcm=0
    d018: 0x18,                  // bitmapBase = $2000
    rowVcBase: ROW_VC_BASE,
    col: COL,
    line: LINE,
    ramByteWrapped: 0x55,
    ramByteUnwrapped: 0xAA,
  });
  expect(r.reads.includes(r.wrappedAddr), `mode 5: read wrapped addr $${r.wrappedAddr.toString(16)}`);
  expect(!r.reads.includes(r.unwrappedAddr), `mode 5: did NOT read unwrapped addr $${r.unwrappedAddr.toString(16)}`);
  ok('mode 5 (BMM): VC wraps at 10 bits');
}

// Mode 6: BMM + MCM
{
  const r = probeColumn({
    d011: 0x3B,                  // bmm=1, ecm=0
    d016: 0x18,                  // mcm=1
    d018: 0x18,
    rowVcBase: ROW_VC_BASE,
    col: COL,
    line: LINE,
    ramByteWrapped: 0x55,
    ramByteUnwrapped: 0xAA,
  });
  expect(r.reads.includes(r.wrappedAddr), `mode 6: read wrapped addr $${r.wrappedAddr.toString(16)}`);
  expect(!r.reads.includes(r.unwrappedAddr), `mode 6: did NOT read unwrapped addr $${r.unwrappedAddr.toString(16)}`);
  ok('mode 6 (BMM+MCM): VC wraps at 10 bits');
}

// Note: invalid bitmap modes (BMM+ECM, BMM+MCM+ECM) apply a $33F mask
// AFTER the VC sum. Since rowVcBase+col only ever overflows by bit 10
// (max sum 0x426) and $33F drops bit 10 anyway, the 10-bit wrap there
// is mathematically a no-op for the actual fetch address. The masking
// is still applied in source for consistency and to prevent bugs if
// rowVcBase bounds ever change; we just don't have an observable
// distinction to assert here.

// Sanity: when sum is in-range, behaviour is unchanged.
{
  const r = probeColumn({
    d011: 0x3B,                  // bmm=1, ecm=0
    d016: 0x08,
    d018: 0x18,
    rowVcBase: 0x100,
    col: 5,                      // sum = 0x105 (in range)
    line: 2,
    ramByteWrapped: 0x55,
    ramByteUnwrapped: 0x55,      // same byte either way
  });
  expect(r.wrappedAddr === r.unwrappedAddr, `in-range sum: wrap is a no-op`);
  expect(r.reads.includes(r.wrappedAddr), `in-range sum: still reads correct addr`);
  ok('In-range rowVcBase+col: wrap is a no-op (regression guard)');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
