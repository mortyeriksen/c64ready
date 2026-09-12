import assert from 'node:assert/strict';
import { VIC2 } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x400);
  vic.charRom = new Uint8Array(0x1000);
  vic.raster = 0x20;
  vic.regs[0x15] = 0;
  vic.displayEnabled = false;
  return vic;
}

// PAL 6569 sprite p-accesses (Bauer §3.6.1): BA falls three cycles
// before p-access and stays low through the following s-access.
const pointerCycles = [58, 60, 62, 1, 3, 5, 7, 9];
function spriteBa(cycle, mask) {
  return pointerCycles.some((pointer, sprite) =>
    (mask & (1 << sprite)) && ((cycle - pointer + 3 + 126) % 63) <= 4);
}
for (let mask = 0; mask < 256; mask++) {
  const vic = makeVic();
  for (let s = 0; s < 8; s++) vic.spriteDmaOn[s] = (mask >> s) & 1;
  vic.clock(63);
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.clock(1);
    const expected = [0, 1, 2, 3].every(delay => spriteBa(cycle - delay, mask));
    assert.equal(vic.isAecLowPhi2(true), expected,
      `Bauer §3.6.1: sampled AEC needs three continuous BA-low lead cycles, including line wrap (mask ${mask}, cycle ${cycle})`);
  }
}
console.log('ok - sampled AEC covers every sprite DMA combination and line wrap');

{
  const vic = makeVic();
  vic.raster = 0x38;
  vic.displayEnabled = true;
  vic.regs[0x11] = 0x19;
  vic.clock(19);
  vic.write(0x11, 0x18);
  for (let cycle = 20; cycle <= 24; cycle++) {
    vic.clock(1);
    assert.equal(vic.isAecLowPhi2(true), cycle >= 23,
      `Bauer §3.6.1: late bad-line c-accesses cannot seize CPU phi2 before three BA-low lead cycles (cycle ${cycle})`);
  }
}
console.log('ok - late bad-line fetch activity remains distinct from CPU AEC');

{
  const vic = makeVic();
  vic.raster = 0x38;
  vic.displayEnabled = true;
  vic.regs[0x11] = 0x18;
  for (let s = 5; s < 8; s++) vic.spriteDmaOn[s] = 1;
  for (let cycle = 1; cycle <= 15; cycle++) {
    vic.clock(1);
    if (cycle >= 12) {
      assert.equal(vic.isAecLowPhi2(true), cycle === 15,
        `Bauer §3.6.1: BA-high at cycle 11 resets the sprite-to-bad-line AEC lead (cycle ${cycle})`);
    }
  }
}
console.log('ok - a BA-high gap resets sampled AEC before a bad line');
