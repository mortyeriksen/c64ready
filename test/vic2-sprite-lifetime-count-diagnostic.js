// Count how many rasters our model actually renders sprite-0 pixels
// for, given a sprite at a known Y. Per Bauer §3.8.1, a non-Y-expanded
// sprite should display for exactly 21 rasters (rows 0..20). If we
// render for 22, that's the off-by-one that matches the user's
// "char-rom line below" symptom (one extra line beyond the sprite
// scroller's intended bottom row).
//
// Setup: bare VIC + minimal RAM. Sprite 0 enabled, Y = $80, X = 50,
// data block filled with 0xFF (all pixels solid) so the renderer
// produces visible non-bg pixels whenever the sprite is "on" at a
// canvas X. Y=$80 puts the sprite firmly in mid-display.
//
// Count: for each raster, check vic.spriteOwnerBuffer for any pixel
// owned by sprite 0. The number of distinct rasters with at least
// one owned pixel is the rendered-lifetime in lines.

import { VIC2, CANVAS_W, CANVAS_H } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.currentVicBank = 0;
  // Display setup: DEN=1, RSEL=1, YSCROLL=3, BMM=0, ECM=0, MCM=0.
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  // Sprite 0: enabled, single-color, X=50, Y=$80.
  vic.regs[0x15] = 0x01;
  vic.regs[0x27] = 0x07;          // yellow
  vic.regs[0x00] = 50;            // X low byte; MSB=0 → X=50
  vic.regs[0x10] = 0;
  vic.regs[0x01] = 0x80;          // Y = 0x80 = 128
  vic.regs[0x21] = 0x06;
  vic.regs[0x20] = 0x0E;
  // Sprite data: pointer $80 → block at $80*64 = $2000. All bytes 0xFF
  // so every pixel of every row is solid foreground.
  for (let i = 0; i < 63; i++) vic.ram[0x2000 + i] = 0xFF;
  vic.ram[0x07F8] = 0x80;          // sprite-0 pointer
  return vic;
}

const vic = makeVic();
// Run one full frame.
const FRAME_CYCLES = 312 * 63;
for (let i = 0; i < FRAME_CYCLES; i++) vic.clock(1);

// Count rasters where sprite 0 owned at least one canvas pixel.
const ownedRasters = [];
for (let canvasY = 0; canvasY < CANVAS_H; canvasY++) {
  const rowOffset = canvasY * CANVAS_W;
  let owned = 0;
  for (let x = 0; x < CANVAS_W; x++) {
    if (vic.spriteOwnerBuffer[x] === 0) owned++;
  }
  if (owned > 0) {
    // canvasY = raster - 15 (top-border offset).
    ownedRasters.push({ canvasY, raster: canvasY + 15, owned });
  }
}

console.log(`Sprite 0 set up at Y=$80 (raster 128), X=50, all-$FF data.`);
console.log(`Rasters where sprite 0 has at least one owned canvas pixel:`);
for (const r of ownedRasters) {
  console.log(`  raster $${r.raster.toString(16)} (canvasY=${r.canvasY}): ${r.owned} px`);
}
console.log(`\nTotal rasters with sprite-0 pixels: ${ownedRasters.length}`);
console.log(`Expected per Bauer §3.8.1 (non-Y-expanded sprite): 21`);
if (ownedRasters.length === 21) {
  console.log(`✓ Sprite lifetime matches spec.`);
} else if (ownedRasters.length === 22) {
  console.log(`✗ OFF-BY-ONE: 22 rasters instead of 21 — this matches the FppScroller "char-rom line below" symptom.`);
  console.log(`  First/last rasters: $${ownedRasters[0].raster.toString(16)}..$${ownedRasters[ownedRasters.length-1].raster.toString(16)}`);
} else {
  console.log(`✗ UNEXPECTED count: ${ownedRasters.length} (expected 21).`);
}
