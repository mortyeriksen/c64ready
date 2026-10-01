import { forceLiveRendering } from './_vic2-equivalence.js';
import assert from 'node:assert/strict';
import { C64Machine } from '../../src/machine.js';
import { newVic, placeSprites, standardWrites } from './_vic2-equivalence.js';
import { PALETTE_RGBA } from '../../src/vic2-tables.js';

function make(tracing = false) {
  const m = new C64Machine();
  const v = m.vic2;
  v.frameTraceEnabled = tracing;
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
  const m = make(), v = m.vic2;
  for (let c = 0; c < 16; c++) v.clock(1);
  assert.equal((v._fetchFeedSamples[0] >>> 23), 1, 'Fixture exercises the captured first display byte');
  const segment = v._buildCycleRasterSegment(15);
  assert.equal((v._fetchFeedSamples[0] & 255), 0x80,
    'Bauer 3.7.2: first display g-access retains the character byte sampled at cycle 16');
  const bus = m.mem.externalDataBus8;
  v._renderSourceColumn(0, 0, segment, new Uint32Array(8), new Uint8Array(8));
  assert.equal(m.mem.externalDataBus8, bus, 'Consuming fetched display data does not perform another chip-bus access');
  m.mem.write(0x2008, 0x40);
  assert.equal(m.mem.ram[0x2008], 0x40, 'CPU RAM write completes after already-due display work');
  assert.equal((v._fetchFeedSamples[0] & 255), 0x80,
    'Bauer 3.7.2: a CPU write cannot change an already-fetched graphics byte');
  assert.equal(v._lineDeferred, true, 'Captured graphics permit RAM writes without forcing display catch-up');
  v.clock(1);
  assert.equal(v._fetchFeedSamples[1] & 255, 0x40, 'Bauer 3.6.3: the next g-access observes the completed CPU write');
}

for (const scroll of [0, 3, 7]) {
  for (const mutation of ['none', 'mode', 'observe']) {
    const a = make(true), b = make();
    for (const m of [a, b]) m.vic2.regs[0x16] = 8 | scroll;
    for (let c = 1; c <= 63; c++) {
      for (const m of [a, b]) {
        const v = m.vic2;
        v.clock(1);
        if (c === 25) {
          if (mutation === 'mode') v.write(0x11, 0x3b);
          if (mutation === 'observe') v.read(0x1f);
        }
        v.phi2();
      }
      assert.equal(b.mem.externalDataBus8, a.mem.externalDataBus8, 'Fetch-fed rendering preserves shared-bus timing');
    }
    assert.deepEqual(b.vic2.fb32, a.vic2.fb32, `Reference parity: XSCROLL=${scroll}, mutation=${mutation}`);
  }
}
// Bauer 3.6.3 / 3.7.3: a write after phi1 cannot change the fetched
// byte, including its XSCROLL-delayed tail. The next phi1 sees the write.
// These boundaries use expected bits, independently of the rereading renderer.
for (const variant of ['6569', '8565']) {
  for (const deferred of [false, true]) {
    for (let scroll = 0; scroll < 8; scroll++) {
      for (const mutation of ['ram', 'dma', 'bank']) {
        const m = make(), v = m.vic2;
        v.vicVariant = variant;
        if (!(deferred)) forceLiveRendering(v);
        v.regs[0x16] = 8 | scroll;
        for (let c = 1; c <= 63; c++) {
          v.clock(1);
          if (c === 25) {
            if (mutation === 'ram') m.mem.write(0x2008, 0x3c);
            if (mutation === 'dma') m.mem.dmaWrite(0x2008, 0xf0);
            if (mutation === 'bank') v.noteBankChange(0x4000);
          }
          v.phi2();
        }
        const after = mutation === 'ram' ? 0x3c : mutation === 'dma' ? 0xf0 : 0;
        const expected = new Uint32Array(320 - scroll);
        for (let x = 0; x < expected.length; x++) {
          const col = x >> 3;
          const byte = col < 10 ? 0x80 : after;
          expected[x] = PALETTE_RGBA[(byte & (128 >> (x & 7))) ? 2 : 0];
        }
        assert.deepEqual(v.fb32.slice(45 * 384 + 32 + scroll, 45 * 384 + 352), expected,
          `Bauer 3.7.3: ${variant}, deferred=${deferred}, XSCROLL=${scroll}, ${mutation} preserves fetched bits until shifter reload`);
      }
    }
  }
}
// Address registers affect the next g-access, without changing older samples.
for (const variant of ['6569', '8565']) {
  for (const mutation of ['charset', 'bitmap']) {
    const m = make(), v = m.vic2;
    v.vicVariant = variant;
    m.mem.ram[0x2808] = 0x42;
    m.mem.ram[0x2050] = 0x24; // Bitmap VC=10, RC=0.
    for (let c = 1; c <= 26; c++) {
      v.clock(1);
      if (c === 25) {
        if (mutation === 'charset') v.write(0x18, 0x1a);
        else v.write(0x11, 0x3b);
      }
      v.phi2();
    }
    assert.equal(v._fetchFeedSamples[9] & 255, 0x80,
      'Bauer 3.6.3: an address-register write cannot alter a completed g-access');
    assert.equal(v._fetchFeedSamples[10] & 255, mutation === 'charset' ? 0x42 : 0x24,
      `Bauer 3.7.3: ${variant} ${mutation} addressing uses the next phi1 register state`);
  }
}

// Bitmap filler belongs to the fetched matrix/color sample as well.
{
  const m = make(), v = m.vic2;
  v.regs[0x11] = 0x3b;
  v.regs[0x16] = 12;
  v.rowScreenCodes.fill(0xa2);
  m.mem.ram.fill(0, 0x2000, 0x2140);
  for (let c = 1; c <= 63; c++) {
    v.clock(1);
    if (c === 16) {
      v.rowScreenCodes[0] = 0xa5;
      v._rowSnapVersion++;
    }
    v.phi2();
  }
  assert.ok(v.fb32.slice(45 * 384 + 32, 45 * 384 + 36).every(p => p === (PALETTE_RGBA[2] >>> 0)),
    'Bauer 3.7.3.3: bitmap XSCROLL filler uses the captured matrix low nibble');
}

// Consuming a captured sample, including correction passes, cannot reread RAM.
{
  const m = make(), v = m.vic2;
  for (let c = 1; c <= 55; c++) { v.clock(1); v.phi2(); }
  const original = v._vicMemRead;
  v._vicMemRead = () => { throw Error('Display decoder must consume captured data'); };
  const pixels = new Uint32Array(8), foreground = new Uint8Array(8);
  const seg = v._buildCycleRasterSegment(15);
  v._renderSourceColumn(0, 0, seg, pixels, foreground);
  assert.equal(foreground[0], 1, 'Bauer 3.7.3: fetched bit 7 reaches foreground decoding');
  v._vicMemRead = original;
  const saved = v.serialize();
  m.mem.write(0x2008, 0);
  v.deserialize(saved);
  assert.equal(v._fetchFeedSamples[0] & 255, 0x80,
    'Snapshot restore retains already-fetched data independently of current RAM');
  assert.equal(v._fetchFeedLine, true, 'Snapshot restore retains the active sample stream');
  const old = {...saved}; delete old.fetchFeedSamples;
  v.deserialize(old);
  assert.equal(v._fetchFeedLine, false, 'Older snapshots use the reference decoder until the next line');
}
// Live/deferred consumers share the same fetch history, including late matrix
// fetches, mode/color corrections and sprite collision observations.
for (const variant of ['6569', '8565']) {
  const pair = [false, true].map(deferred => {
    const v = newVic();
    v.vicVariant = variant;
    if (!(deferred)) forceLiveRendering(v);
    placeSprites(v, [24, 50, 80, 112, 160, 210, 270, 330]);
    for (let s = 0; s < 8; s++) v.regs[s * 2 + 1] = 50 + s * 23;
    return v;
  });
  for (let step = 0; step < 2 * 312 * 63; step++) {
    for (const v of pair) {
      v.clock(1);
      standardWrites(v, v.raster, v.cycleInLine);
      if (v.cycleInLine === 25) v.write(0x16, (v.regs[0x16] & 0xf8) | (v.raster & 7));
      if (v.cycleInLine === 35 && v.raster % 9 === 0) v.write(0x11, v.regs[0x11] ^ 1);
      v.phi2();
    }
    const [a, b] = pair;
    if (a.cycleInLine === 30 || a.cycleInLine === 60) {
      for (const reg of [0x19, 0x1e, 0x1f]) assert.equal(b.read(reg), a.read(reg),
        'Fetch-fed deferral preserves CPU-visible collision and IRQ reads');
    }
    assert.equal(b.irqPending, a.irqPending, 'Fetch-fed deferral preserves IRQ timing');
    if (a.cycleInLine === 0) assert.deepEqual(b.fb32, a.fb32,
      `Fetch-fed live/deferred line-end equivalence on ${variant}`);
  }
}
console.log('ok - fetch-fed display, immutable shifter bytes and observer timing');
