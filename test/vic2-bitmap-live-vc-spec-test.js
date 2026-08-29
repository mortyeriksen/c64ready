// Bauer §3.7.2 / §3.14.6: in BITMAP mode the g-access ADDRESS is decided by
// the live video counter (CB + VC*8 + RC), where VC = this line's VCBASE +
// column. On every normal/FLI line that equals the retained matrix base
// (rowVcBase) because a bad line refreshes the line buffer at VCBASE. They
// DIVERGE only under the "late bad line" trick: the CPU writes YSCROLL=raster&7
// AFTER the c-access window (cy55) so display state is kept alive (VCBASE keeps
// advancing +40 per char row) yet no c-access runs to refresh rowVcBase, which
// stays frozen at the last real bad line. There the BITMAP must follow the
// advancing live VC while the COLOR keeps coming from the frozen line buffer.
//
// This is Lunatico's moon-overlay effect: rowVcBase froze (~827) while the
// chip's VC advanced (~947), so addressing the bitmap by rowVcBase produced
// jagged repeated slabs instead of the structured overlay.
//
// TEXT mode is unaffected: there the g-access address is the matrix char code
// (rowCodes[col]); VC only selects the matrix cell, already in the buffer.

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

function makeSeg(vic, { d011, d016, d018, rowVcBase, liveVcBase, col, rawCode, colorNib }) {
  const regs = new Uint8Array(0x40);
  regs[0x11] = d011; regs[0x16] = d016; regs[0x18] = d018;
  regs[0x21] = 0x06; regs[0x22] = 0x07; regs[0x23] = 0x08; regs[0x24] = 0x09;
  const rowFetchedCols = new Uint8Array(40);
  const rowCodes = new Uint8Array(40);
  const rowColors = new Uint8Array(40);
  rowFetchedCols[col] = 1; rowCodes[col] = rawCode; rowColors[col] = colorNib;
  return {
    regs, prevRegs: regs, bank: 0x0000,
    rowFetchedCols, rowCodes, rowColors,
    rowVcBase, liveVcBase,
    displayColumnActive: 1,
  };
}

// Render one column under a spy on the renderer's g-byte peek; return the
// addresses read.
function renderProbe(vic, seg, col, line) {
  const reads = [];
  const orig = vic._vicMemRead.bind(vic);
  vic._vicMemRead = function(addr, bank) { reads.push(addr & 0x3FFF); return orig(addr, bank); };
  const outPixels = new Uint32Array(8);
  const outFgMap = new Uint8Array(8);
  vic._renderSourceColumn(col, line, seg, outPixels, outFgMap, 0);
  vic._vicMemRead = orig;
  return { reads, outPixels, outFgMap };
}

const CB = 0x2000;           // d018 bit3 = 1
const D018 = 0x08;           // CB=$2000, screen base $000

// ── Test 1: hi-res bitmap uses live VC base when rowVcBase is frozen ──
{
  const vic = makeVic();
  const rowVcBase = 827, liveVcBase = 947, col = 7, line = 3;
  const liveAddr   = CB + ((liveVcBase + col) & 0x3FF) * 8 + line;   // $3DD3
  const frozenAddr = CB + ((rowVcBase  + col) & 0x3FF) * 8 + line;   // $3A13
  vic.ram[liveAddr]   = 0xAA;
  vic.ram[frozenAddr] = 0x55;
  const seg = makeSeg(vic, { d011: 0x20, d016: 0x00, d018: D018, rowVcBase, liveVcBase, col, rawCode: 0x12, colorNib: 0x00 });
  const { reads } = renderProbe(vic, seg, col, line);
  expect(reads.includes(liveAddr), `must g-access live VC addr $${liveAddr.toString(16)} (read ${reads.map(r => '$' + r.toString(16))})`);
  expect(!reads.includes(frozenAddr), `must NOT g-access frozen rowVcBase addr $${frozenAddr.toString(16)}`);
  ok('hi-res bitmap g-access follows live VC base, not frozen rowVcBase');
}

// ── Test 2: multicolor bitmap likewise uses live VC base ──
{
  const vic = makeVic();
  const rowVcBase = 100, liveVcBase = 340, col = 5, line = 2;
  const liveAddr   = CB + ((liveVcBase + col) & 0x3FF) * 8 + line;
  const frozenAddr = CB + ((rowVcBase  + col) & 0x3FF) * 8 + line;
  vic.ram[liveAddr]   = 0xE4;
  vic.ram[frozenAddr] = 0x1B;
  const seg = makeSeg(vic, { d011: 0x20, d016: 0x10, d018: D018, rowVcBase, liveVcBase, col, rawCode: 0x34, colorNib: 0x05 });
  const { reads } = renderProbe(vic, seg, col, line);
  expect(reads.includes(liveAddr), `MCM bitmap must g-access live VC addr $${liveAddr.toString(16)}`);
  expect(!reads.includes(frozenAddr), `MCM bitmap must NOT use frozen addr $${frozenAddr.toString(16)}`);
  ok('multicolor bitmap g-access follows live VC base');
}

// ── Test 3: regression guard — when the two agree (normal line), unchanged ──
{
  const vic = makeVic();
  const base = 200, col = 9, line = 4;
  const addr = CB + ((base + col) & 0x3FF) * 8 + line;
  vic.ram[addr] = 0x99;
  const seg = makeSeg(vic, { d011: 0x20, d016: 0x00, d018: D018, rowVcBase: base, liveVcBase: base, col, rawCode: 0x00, colorNib: 0x00 });
  const { reads } = renderProbe(vic, seg, col, line);
  expect(reads.includes(addr), `normal line still g-accesses VC addr $${addr.toString(16)}`);
  ok('normal line (liveVcBase == rowVcBase) addressing unchanged');
}

// ── Test 4: TEXT mode is unaffected — address is the matrix char code ──
{
  const vic = makeVic();
  // d018 = $08 -> char base = ((d018>>1)&7)*0x800 = (4)*0x800 = $2000.
  const charBase = ((D018 >> 1) & 0x07) * 0x0800;
  const rowVcBase = 50, liveVcBase = 300, col = 3, line = 1;
  const rawCode = 0x41;
  const textAddr = charBase + rawCode * 8 + line;
  vic.ram[textAddr] = 0x7E;
  // Poison both VC-derived bitmap addresses to prove text ignores VC entirely.
  vic.ram[CB + ((liveVcBase + col) & 0x3FF) * 8 + line] = 0x11;
  vic.ram[CB + ((rowVcBase  + col) & 0x3FF) * 8 + line] = 0x22;
  const seg = makeSeg(vic, { d011: 0x00, d016: 0x00, d018: D018, rowVcBase, liveVcBase, col, rawCode, colorNib: 0x01 });
  const { reads } = renderProbe(vic, seg, col, line);
  expect(reads.includes(textAddr), `text g-access reads char code addr $${textAddr.toString(16)} (read ${reads.map(r => '$' + r.toString(16))})`);
  ok('text mode g-access uses matrix char code, independent of live VC');
}

if (failing > 0) { console.log(`\n${failing} FAILED`); process.exit(1); }
else console.log(`\nAll ${testNo} bitmap live-VC tests passed.`);
