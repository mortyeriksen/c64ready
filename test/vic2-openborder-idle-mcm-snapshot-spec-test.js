// Open-border idle rendering samples $D016 MCM from the mode snapshot —
// synthetic spec.
//
// Mode bits are output-stage timed: a mid-line $D016 write takes effect on
// the graphics output later than the write cycle. The display path
// (_renderSourceColumn) samples ECM/BMM/MCM from seg.modeRegs; the
// open-border idle path (_renderOpenBorderIdleSpan) must sample $D016 MCM
// from the SAME snapshot — while $D011 ECM/BMM stay live (Nine's invalid
// $70 left-edge spans depend on the immediate ECM/BMM transition).
//
// This is the mechanism behind The Hat's disc-2 balloon row: a per-line
// side-border trick toggles MCM (set late in the line, cleared at cy18).
// With +0 (live) sampling the first display cycles saw the stale MCM=1 —
// ECM+MCM = invalid mode → BLACK — and the leftmost balloon rendered
// corrupt while its identical siblings were fine. (The demo-state
// regression for this lives outside the suite; this locks the rule
// synthetically.)
//
// Setup: one open-border line rendered through the real incremental path
// (_buildCycleRasterSegment → _renderCycleSegmentGraphics), ECM=1 constant,
// idle byte $81, and a Hat-style per-cycle MCM schedule: MCM=1 for c≤17,
// 0 for 18..53, 1 again from c=54. In the incremental path the mode
// snapshot is +1 (lineCycleRegs[c+1]; the end-of-line fixup can retime to
// +2), so the expected per-column classification is:
//   c=15,16 → snapshot MCM=1 → ECM+MCM invalid → 8× BLACK
//   c=17..52 → snapshot MCM=0 → ECM idle → $81 pattern (2 black + 6 bg0)
//   c=53,54 → snapshot MCM=1 → 8× BLACK
// The discriminating columns are c=17 (live sampling would render it
// BLACK) and c=53 (live sampling would render the pattern).

import { VIC2, CYCLES_PER_LINE, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

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

const PAL_RGBA = (() => {
  const out = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    const c = C64_PALETTE[i];
    out[i] = (0xFF000000 | ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF)) >>> 0;
  }
  return out;
})();
const BLACK = 0xFF000000 >>> 0;
const BG_BLUE = PAL_RGBA[6];
const cyX = (c) => (c - 12) * 8 + 8;

function renderMcmFlipLine() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0;
  const D011 = 0x5B;                  // ECM=1, DEN=1, RSEL=1, YSCROLL=3 — constant
  vic.regs[0x11] = D011;
  vic.regs[0x20] = 0x0E;
  vic.regs[0x21] = 0x06;              // bg0 blue
  vic._lineStartD011 = D011;
  vic._lineStartD021 = 0x06;
  vic._prevLineStartD011 = D011;
  // Hat-style schedule: MCM on for c≤17, off 18..53, on again from 54.
  const mcmAt = (c) => (c <= 17 || c >= 54) ? 1 : 0;
  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    vic.regs[0x11] = D011;
    vic.regs[0x16] = 0x08 | (mcmAt(c) << 4);
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 55) ? 1 : 0;
    vic.lineCycleHBorderBefore[c] = vic.lineCycleHBorder[c];
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleDisplayColumnActive[c] = 0;
    vic.lineCycleDisplayActive[c] = 0;      // open-border idle
    vic.lineCycleDisplayEnabled[c] = 1;
    vic.lineCycleBanks[c] = 0;
    vic.lineCycleVc[c] = 0; vic.lineCycleRc[c] = 0; vic.lineCycleRowVcBase[c] = 0;
    vic.lineCycleCselComparator[c] = 1;
    vic.lineCycleIdleByte[c] = 0x81;        // 1000_0001 → 2 fg + 6 bg per column
  }
  vic.displayActive = false; vic.lineDisplayActive = false;
  const canvasY = 20;
  vic._initRenderRasterLine(20, canvasY);
  for (let cycle = 11; cycle <= 58; cycle++)
    vic._renderCycleSegmentGraphics(vic._buildCycleRasterSegment(cycle), canvasY);
  return { vic, ro: canvasY * CANVAS_W };
}

function classifyColumn(vic, ro, c) {
  let black = 0, bg = 0, other = 0;
  for (let x = cyX(c); x < cyX(c) + 8; x++) {
    const px = vic.fb32[ro + x] >>> 0;
    if (px === BLACK) black++;
    else if (px === BG_BLUE) bg++;
    else other++;
  }
  if (other) return `other(${other})`;
  if (black === 8) return 'black';
  if (black === 2 && bg === 6) return 'pattern';
  return `mixed(${black}b/${bg}u)`;
}

const { vic, ro } = renderMcmFlipLine();

// ── 1: the two discriminating columns (live-vs-snapshot sampling) ────────
{
  expect(classifyColumn(vic, ro, 17) === 'pattern',
    `c=17 must render the ECM-idle pattern via the MCM snapshot (live MCM=1 would render BLACK) — got ${classifyColumn(vic, ro, 17)}`);
  expect(classifyColumn(vic, ro, 53) === 'black',
    `c=53 must render BLACK via the MCM snapshot (live MCM=0 would render the pattern) — got ${classifyColumn(vic, ro, 53)}`);
  ok('idle span samples $D016 MCM from the mode snapshot, not the live cycle (Hat balloon rule)');
}

// ── 2: full per-column classification across the open span ──────────────
{
  const bad = [];
  for (let c = 15; c <= 54; c++) {
    const want = (c <= 16 || c >= 53) ? 'black' : 'pattern';
    const got = classifyColumn(vic, ro, c);
    if (got !== want) bad.push(`c${c}: want ${want}, got ${got}`);
  }
  expect(bad.length === 0, `per-column classification: ${bad.slice(0, 5).join('; ')}`);
  ok('full open span: ECM+MCM(snapshot)=invalid-black edges, ECM-idle $81 pattern between');
}

console.log(`\n${testNo} open-border idle MCM-snapshot spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
