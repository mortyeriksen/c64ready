import assert from 'node:assert/strict';
import { newVic, placeSprites, standardWrites } from './_vic2-equivalence.js';

const regsAt = (v, c) => v._historyRegs[v._regCycle[c]];
{
  const v = newVic();
  v.raster = 60;
  v.cycleInLine = 0;
  v.clock(1);
  v.write(0x21, 9);
  v.phi2();
  assert.equal(regsAt(v, 1)[0x21], 6, 'Bauer 3.6.3: phi2 write cannot alter the preceding phi1 sample');
  v.clock(1);
  assert.equal(regsAt(v, 2)[0x21], 9, 'Bauer 3.6.3: phi2 register write is visible at the next phi1');
  const graphicsVersion = v._graphicsCycleVersion[2];
  v.write(0x27, 5);
  v.phi2();
  v.clock(1);
  assert.equal(v._graphicsCycleVersion[3], graphicsVersion, 'Bauer 3.7/3.8: sprite color does not alter graphics-sequencer inputs');
  v.clock(1);
  v._unaliasRegSnapshot(3)[0] = 123;
  assert.equal(regsAt(v, 4)[0], 0, 'Captured register samples remain independent when a historical sample is patched');
  const samples = Array.from({length: 5}, (_, c) => Array.from(regsAt(v, c)));
  const diagnostic = v.lineCycleRegs;
  assert.deepEqual(diagnostic.slice(0, 5).map(a => Array.from(a)), samples, 'Diagnostic materialization preserves every captured register sample');
}

// The reference renderer is an additional oracle; hardware timing rules remain
// covered by the dedicated border, DMA, sprite and collision specifications.
for (const variant of ['6569', '8565']) {
  for (const deferred of [false, true]) {
    for (const [sparse, intervals] of [[true, false], [false, true], [true, true]]) {
      const make = optimized => {
        const v = newVic();
        v.vicVariant = variant;
        v.lineBatchRender = deferred;
        v.sparseRenderState = optimized && sparse;
        v.spriteIntervals = optimized && intervals;
        placeSprites(v, [0, 37, 128, 255, 355, 400, 496, 511]);
        for (let s = 0; s < 8; s++) v.regs[s * 2 + 1] = 45 + s * 25;
        v.regs[0x1c] = 0x55;
        v.regs[0x1d] = 0xaa;
        return v;
      };
      const a = make(false), b = make(true);
      for (let step = 0; step < 2 * 312 * 63; step++) {
        for (const v of [a, b]) {
          v.clock(1);
          const r = v.raster, c = v.cycleInLine;
          standardWrites(v, r, c);
          if (c === 28 && r % 7 === 0) v.write((r % 8) * 2, (r * 13) & 255);
          if (c === 35 && r % 9 === 0) v.write(0x1d, r & 255);
          if (c === 41 && r % 11 === 0) v.write(0x1a, r & 6);
          v.phi2();
        }
        if (a.cycleInLine === 30 || a.cycleInLine === 60) {
          for (const reg of [0x19, 0x1e, 0x1f]) {
            assert.equal(b.read(reg), a.read(reg), `${variant}: collision/IRQ observer sees the reference result at the same cycle`);
          }
        }
        assert.equal(b.irqPending, a.irqPending, `${variant}: IRQ output preserves cycle ordering`);
        assert.equal(b.vicInternalBus, a.vicInternalBus, `${variant}: render recording preserves bus accesses`);
        if (a.cycleInLine === 0) {
          assert.deepEqual(b.fb32, a.fb32, `${variant}: line-end pixels agree with the reference renderer`);
        }
      }
      console.log(`ok - render history: ${variant}, deferred=${deferred}, sparse=${sparse}, intervals=${intervals}`);
    }
  }
}
