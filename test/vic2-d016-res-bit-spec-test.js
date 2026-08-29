// $D016 RES bit (bit 5) spec test.
//
// Bauer §3.2 spec note: "The RES bit (bit 5) of register $d016 has no
// known function on the VIC types 6567/6569. On the 6566, this bit is
// used to stop the VIC."
//
// On 6569 (our default vicVariant) the bit must be ignored — writes
// must not freeze the shifter or otherwise affect rendering.
//
// (D016 MCM bit (bit 4) mid-line splitting is covered by vic2-test.js
// "mid-line D016 changes split text positioning at cycle boundaries"
// — not duplicated here.)

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

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

function setupBorderLineState(vic, regsTemplate, canvasY) {
  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    vic.lineCycleRegs[c].set(regsTemplate);
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleHBorder[c] = 1;
    vic.lineCycleHBorderBefore[c] = 1;
    vic.lineCycleHInner[c] = 0;
    vic.lineCycleDisplayColumnActive[c] = 0;
    vic.lineCycleIdleByte[c] = 0;
    vic.lineCycleBanks[c] = 0;
    vic.lineCycleVc[c] = 0;
    vic.lineCycleRc[c] = 0;
    vic.lineCycleRowVcBase[c] = 0;
    vic.lineCycleCselComparator[c] = 1;
  }
}

// Render same scene twice: once with D016=$08 (CSEL=1, RES=0), once
// with D016=$28 (CSEL=1, RES=1). Pixel-compare framebuffer rows.
{
  const renderWithD016 = (d016) => {
    const vic = makeVic();
    vic.regs[0x20] = 6;
    vic.regs[0x21] = 0;
    vic.regs[0x16] = d016;
    const canvasY = 50;
    setupBorderLineState(vic, vic.regs, canvasY);
    vic._initRenderRasterLine(50, canvasY);
    for (let cycle = 11; cycle <= 58; cycle++) {
      const seg = vic._buildCycleRasterSegment(cycle);
      vic._renderCycleSegmentGraphics(seg, canvasY);
    }
    const ro = canvasY * 384;
    return Array.from(vic.fb32.slice(ro, ro + 384));
  };
  const noRes = renderWithD016(0x08);
  const withRes = renderWithD016(0x28);
  let firstDiff = -1;
  for (let x = 0; x < 384; x++) {
    if (noRes[x] !== withRes[x]) { firstDiff = x; break; }
  }
  expect(firstDiff === -1,
    `D016 RES bit (bit 5) must be ignored on 6569 — pixel diff at canvasX=${firstDiff}`);
  ok('Bauer §3.2: $D016 bit 5 (RES) has no effect on VIC 6569');
}

console.log(`\n${testNo} D016 RES bit spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
