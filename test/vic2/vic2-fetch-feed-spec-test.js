import assert from 'node:assert/strict';
import { C64Machine } from '../../src/machine.js';

function make(enabled) {
  const m = new C64Machine();
  const v = m.vic2;
  v.fetchFedRender = enabled;
  v.raster = 60;
  v.cycleInLine = 0;
  v.displayEnabled = v.displayActive = true;
  v.vBorderActive = v._vBorderLatch = false;
  v.rowVcBase = v.vcBase = v.rc = 0;
  v.rowFetchedCols.fill(1);
  v.rowScreenCodes.fill(1);
  v.rowColorNibbles.fill(2);
  v.regs[0x11] = 0x1b;
  v.regs[0x16] = 8;
  v.regs[0x18] = 0x18;
  v.regs[0x21] = 0;
  v.charRom = new Uint8Array(4096);
  m.mem.ram[0x2008] = 0x80;
  return m;
}

{
  const m = make(true), v = m.vic2;
  for (let c = 0; c < 16; c++) v.clock(1);
  assert.equal(v._fetchFeedValid[31], 1, 'Fixture exercises the captured first display byte');
  const segment = v._buildCycleRasterSegment(15);
  assert.equal(v._graphicsSourceByte(0, segment, 0x2008, 0), 0x80,
    'Bauer 3.7.2: first display g-access retains the character byte sampled at cycle 16');
  const bus = m.mem.externalDataBus8;
  v._graphicsSourceByte(0, segment, 0x2008, 0);
  assert.equal(m.mem.externalDataBus8, bus, 'Consuming fetched display data does not perform another chip-bus access');
  m.mem.write(0x2008, 0x40);
  assert.equal(m.mem.ram[0x2008], 0x40, 'CPU RAM write completes after already-due display work');
  assert.equal(v._graphicsSourceByte(0, segment, 0x2008, 0), 0x40,
    'Observer catch-up returns subsequent live rendering to current RAM');
}

for (const scroll of [0, 3, 7]) {
  for (const mutation of ['none', 'ram', 'dma', 'mode', 'bank', 'observe']) {
    const a = make(false), b = make(true);
    for (const m of [a, b]) m.vic2.regs[0x16] = 8 | scroll;
    for (let c = 1; c <= 63; c++) {
      for (const m of [a, b]) {
        const v = m.vic2;
        v.clock(1);
        if (c === 25) {
          if (mutation === 'ram') m.mem.write(0x2008, 0x3c);
          if (mutation === 'dma') m.mem.dmaWrite(0x2008, 0xf0);
          if (mutation === 'mode') v.write(0x11, 0x3b);
          if (mutation === 'bank') v.noteBankChange(0x4000);
          if (mutation === 'observe') v.read(0x1f);
        }
        v.phi2();
      }
      assert.equal(b.mem.externalDataBus8, a.mem.externalDataBus8, 'Fetch-fed rendering preserves shared-bus timing');
    }
    assert.deepEqual(b.vic2.fb32, a.vic2.fb32, `Reference parity: XSCROLL=${scroll}, mutation=${mutation}`);
  }
}
console.log('ok - fetch-fed display, bus isolation and observer fallbacks');
