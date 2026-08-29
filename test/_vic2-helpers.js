// Shared helpers for VIC-II tests. The original vic2-test.js had grown
// past 8 kLOC, so it's being split into focused per-topic spec-test
// files. Every per-topic file imports the helpers it needs from here.
//
// Leading-underscore filename so the master test runner (test/all-test.js)
// doesn't try to spawn it as a test process — registration is explicit.

import { VIC2, C64_PALETTE, CANVAS_W, CANVAS_H, CYCLES_PER_FRAME, CYCLES_PER_LINE } from '../src/vic2.js';
import { C64Machine } from '../src/machine.js';

export { VIC2, C64_PALETTE, CANVAS_W, CANVAS_H, CYCLES_PER_FRAME, CYCLES_PER_LINE, C64Machine };

export function paletteRgba(idx) {
  // Mirrors vic2.js PALETTE_RGBA encoding: ABGR little-endian.
  const c = C64_PALETTE[idx & 0x0F];
  return (0xFF000000 | ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF)) >>> 0;
}

export const ACCESS_IDLE = 0;
export const ACCESS_REFRESH = 1;
export const ACCESS_C = 2;
export const ACCESS_G = 3;

export function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// Failure logs a `warn` line but does NOT exit. Use for documenting known
// spec deviations the project has chosen to ship — keeps the deviation
// visible without breaking CI.
export function softAssert(cond, msg) {
  if (cond) console.log(`  ok  - ${msg}`);
  else      console.warn(`  WARN - spec-deviation: ${msg}`);
}

export function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(65536);
  vic.colorRam = new Uint8Array(1024);
  vic.charRom = new Uint8Array(4096);
  vic.currentVicBank = 0x0000;
  return vic;
}

export function makeRenderSeg(vic, overrides = {}) {
  const seg = {
    regs: vic.regs,
    bank: 0x0000,
    rowVcBase: 0,
    rowFetchedCols: new Uint8Array(40),
    rowCodes: new Uint8Array(40),
    rowColors: new Uint8Array(40),
    rowFetchD011: vic.regs[0x11],
    rowFetchD016: vic.regs[0x16],
    rowFetchD018: vic.regs[0x18],
    displayColumnActive: true,
    rc: 0,
    ...overrides,
  };
  // The bitmap g-access address is decided by the LIVE VC base (= VCBASE this
  // line); it equals rowVcBase on every synthetic/normal line (they diverge
  // only under the late-bad-line trick, which these unit segs don't model).
  if (seg.liveVcBase === undefined) seg.liveVcBase = seg.rowVcBase;
  return seg;
}

export function fillSpriteLineState(vic, regs = null) {
  for (let cycle = 0; cycle <= 63; cycle++) {
    if (regs) vic.lineCycleRegs[cycle].set(regs);
    vic.lineCycleSpriteDisplayOn[cycle].fill(0);
    vic.lineCycleSpriteDataRow[cycle].fill(-1);
    vic.lineCycleSpriteDataBase[cycle].fill(0);
    vic.lineCycleSpriteDataBank[cycle].fill(0);
    vic.lineCycleSpritePointerValue[cycle].fill(0);
    vic.lineCycleSpriteRowByteMask[cycle].fill(0);
    vic.lineCycleSpriteShiftReg[cycle].fill(0);
    for (let s = 0; s < 8; s++) {
      vic.lineCycleSpriteRowData[cycle][s].fill(0);
    }
  }
}

export function fillOpaqueSpriteAcrossLine(vic, sprite, x, opts = {}) {
  const { xExpand = false, multicolor = false, color = 2, priority = false, shiftReg = 0xFFFFFF } = opts;
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x15] |= (1 << sprite);
    if (xExpand) vic.lineCycleRegs[cycle][0x1D] |= (1 << sprite);
    if (multicolor) vic.lineCycleRegs[cycle][0x1C] |= (1 << sprite);
    if (priority) vic.lineCycleRegs[cycle][0x1B] |= (1 << sprite);
    vic.lineCycleRegs[cycle][sprite * 2] = x & 0xFF;
    if (x > 255) {
      vic.lineCycleRegs[cycle][0x10] |= (1 << sprite);
    }
    vic.lineCycleRegs[cycle][0x27 + sprite] = color & 0x0F;
    vic.lineCycleSpriteDisplayOn[cycle][sprite] = 1;
    vic.lineCycleSpriteDataRow[cycle][sprite] = 0;
    vic.lineCycleSpriteRowByteMask[cycle][sprite] = 0x07;
    vic.lineCycleSpriteShiftReg[cycle][sprite] = shiftReg >>> 0;
  }
  vic.spriteLineDataRow[sprite] = 0;
  vic.spriteRowByteMask[sprite] = 0x07;
  vic.spriteShiftReg[sprite] = shiftReg >>> 0;
}

export function clearLineBuffers(vic, canvasY) {
  const rowOffset = canvasY * CANVAS_W;
  vic.borderBuffer.fill(0, 0, CANVAS_W);
  vic.graphicsPriorityBuffer.fill(0, 0, CANVAS_W);
  vic.graphicsCollisionBuffer.fill(0, 0, CANVAS_W);
  vic.spriteCollisionBuffer.fill(0, 0, CANVAS_W);
  return rowOffset;
}

export function setupSpriteForRender(vic, sprite, regX, opts = {}) {
  const {
    xExpand = false, multicolor = false, color = 2,
    priority = false, shiftReg = 0xFFFFFF,
  } = opts;
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x15] |= (1 << sprite);
    if (xExpand) vic.lineCycleRegs[cycle][0x1D] |= (1 << sprite);
    if (multicolor) vic.lineCycleRegs[cycle][0x1C] |= (1 << sprite);
    if (priority) vic.lineCycleRegs[cycle][0x1B] |= (1 << sprite);
    vic.lineCycleRegs[cycle][sprite * 2] = regX & 0xFF;
    if (regX > 255) vic.lineCycleRegs[cycle][0x10] |= (1 << sprite);
    vic.lineCycleRegs[cycle][0x27 + sprite] = color & 0x0F;
    vic.lineCycleSpriteDisplayOn[cycle][sprite] = 1;
    vic.lineCycleSpriteDataRow[cycle][sprite] = 0;
    vic.lineCycleSpriteRowByteMask[cycle][sprite] = 0x07;
    vic.lineCycleSpriteShiftReg[cycle][sprite] = shiftReg >>> 0;
  }
  vic.spriteLineDataRow[sprite] = 0;
  vic.spriteRowByteMask[sprite] = 0x07;
  vic.spriteShiftReg[sprite] = shiftReg >>> 0;
}

export function setMulticolorRegs(vic, mc0, mc1) {
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x25] = mc0 & 0x0F;
    vic.lineCycleRegs[cycle][0x26] = mc1 & 0x0F;
  }
  vic.regs[0x25] = mc0 & 0x0F;
  vic.regs[0x26] = mc1 & 0x0F;
}

export function fillTextLineState(vic, regs, { hBorder = false, vBorder = false, rowVcBase = 0, rc = 0 } = {}) {
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle].set(regs);
    vic.lineCycleBanks[cycle] = vic.currentVicBank;
    vic.lineCycleDisplayEnabled[cycle] = 1;
    vic.lineCycleDisplayActive[cycle] = 1;
    vic.lineCycleDisplayPending[cycle] = 0;
    vic.lineCycleDisplayColumnActive[cycle] = (cycle >= 15 && cycle <= 54) ? 1 : 0;
    vic.lineCycleMatrixFetchActive[cycle] = 0;
    vic.lineCycleVBorderBefore[cycle] = vBorder ? 1 : 0;
    vic.lineCycleVBorder[cycle] = vBorder ? 1 : 0;
    vic.lineCycleHBorderBefore[cycle] = hBorder ? 1 : 0;
    vic.lineCycleHBorder[cycle] = hBorder ? 1 : 0;
    vic.lineCycleHInner[cycle] = 1;
    vic.lineCycleVc[cycle] = rowVcBase;
    vic.lineCycleRc[cycle] = rc;
    vic.lineCycleRowVcBase[cycle] = rowVcBase;
    vic.lineCycleRowFetchedCols[cycle].fill(0);
    vic.lineCycleRowCodes[cycle].fill(0);
    vic.lineCycleRowColors[cycle].fill(0);
    vic.lineCycleIdleByte[cycle] = 0;
  }
  // rowFetchD0xx is a per-line scalar (set at bad-line fetch begin in
  // production). The harness mirrors that by writing once.
  vic.rowFetchD011 = regs[0x11];
  vic.rowFetchD016 = regs[0x16];
  vic.rowFetchD018 = regs[0x18];
}

export function clearRenderedRow(vic, raster) {
  const rowOffset = (raster - 15) * 384;
  vic.fb32.fill(0, rowOffset, rowOffset + 384);
  vic.borderBuffer.fill(0, 0, 384);
  vic.graphicsPriorityBuffer.fill(0, 0, 384);
  vic.graphicsCollisionBuffer.fill(0, 0, 384);
  vic.spriteCollisionBuffer.fill(0, 0, 384);
  vic.spriteOwnerBuffer.fill(0xFF, 0, 384);
  return rowOffset;
}

export function firstForegroundX(vic, raster, start = 0, end = 384) {
  const rowOffset = (raster - 15) * 384;
  for (let x = start; x < end; x++) {
    if (vic.graphicsPriorityBuffer[x]) return x;
  }
  return -1;
}

export function lastForegroundX(vic, raster, start = 0, end = 384) {
  const rowOffset = (raster - 15) * 384;
  for (let x = end - 1; x >= start; x--) {
    if (vic.graphicsPriorityBuffer[x]) return x;
  }
  return -1;
}

// Canonical "rendered-on" VIC: DEN=1, RSEL=1, CSEL=1, YSCROLL=3, screen
// at $0400, chargen at $1000, blue bg, light-blue border. Used by the
// sprite render-output and overlay tests.
export function makeRenderableVic() {
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;   // DEN=1, ECM=0, BMM=0, RSEL=1, YSCROLL=3
  vic.regs[0x16] = 0x08;   // CSEL=1
  vic.regs[0x18] = 0x14;   // screen $0400 (chargen $1000 in bank 0)
  vic.regs[0x20] = 0x0E;   // border = light blue
  vic.regs[0x21] = 0x06;   // bg = blue
  vic.displayEnabled = true;
  return vic;
}

// Tiny C64-machine harness for master-cycle / BA-stall / sprite-DMA
// tests. Stubs out everything the master-cycle scheduler reads from
// (sid voices, cias, drive, cpu boundary detection) while letting the
// test set the BA / AEC / sprite-BA / bad-line-BA gating directly.
export function makeMasterCycleHarness({ baLow, busKind, aecLow = false, spriteBaLow = false, badLineBaLow }) {
  // Default: any BA-low that isn't sprite-source must be bad-line.
  const effBadLineBa = badLineBaLow !== undefined ? badLineBaLow : (baLow && !spriteBaLow);
  // Stub matches the SIDVoice methods _runMasterCycle drives on the shadow:
  // v1/v2 clockPhaseOnly(), v3 clockCore() + outputStageOsc3() (OSC3-only —
  // the shadow discards the audio sample). outputStage/outputStageAudio kept
  // for any harness caller that clocks a full/audio voice.
  const stubVoice = { clock() {}, clockPhaseOnly() {}, clockCore() {}, outputStage() {}, outputStageAudio() {}, outputStageOsc3() {}, predictMsbRise() { return false; }, ctrl: 0 };
  return {
    sidCycleCounter: 0,
    shadowV1: stubVoice, shadowV2: stubVoice, shadowV3: stubVoice,
    cia1: { clock() { } },
    cia2: { clock() { } },
    datasette: { clock() { } },
    driveCycleAccum: 0,
    drive1541: null,
    _prevSpriteBaLow: false,
    vic2: {
      clockCalls: 0,
      clock() { this.clockCalls++; },
      phi2() { },
      isBaLow() { return baLow; },
      isAecLow() { return aecLow; },
      isSpriteBaLow() { return spriteBaLow; },
      isBadLineBaLow() { return effBadLineBa; },
    },
    cpu: {
      clockCalls: 0,
      peekNextBusKind() { return busKind; },
      nextBusIsWrite() { return busKind === 'write'; },
      peekNextRdyClass() { return busKind === 'write' ? 'write' : 'read'; },
      atInstructionBoundary() { return false; },
      clock() { this.clockCalls++; },
      setIrqLine() {},
      setNmiLine() {},
    },
    truedriveEnabled: false,
    currentD64: null,
    mem: { ram: new Uint8Array(65536) },
    _cpuIrqPending: false,
    _cpuNmiPending: false,
    _sampleCpuInterrupts() {},
    _trapLoad() {
      assert(false, 'trap load should not run in master-cycle harness');
    },
  };
}

export function runUntil(vic, raster, cycle = 0) {
  let guard = 312 * 63 * 3;
  while ((vic.raster !== raster || vic.cycleInLine !== cycle) && guard-- > 0) {
    vic.clock(1);
    // Drive phi2 so cycle-58 transition fires in master-cycle ordering
    // (per `cycle58-live-badline-sampling-spec-test.js`).
    vic.phi2();
  }
  assert(guard > 0, `timed out waiting for raster ${raster} cycle ${cycle}`);
}
