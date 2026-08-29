// Sprite $163/$164 boundary garbage (Bauer §3.8.1 rule 4 + VIC-Addendum
// "sprite idle fetch").
//
// At sprite X-coordinate $164 (cycle 58, the display turn-on point) the VIC
// re-triggers every sprite's shift register; if a sprite's 24 real pixels have
// just been exhausted there (its shifter is empty), the bus contents ($ff) are
// emitted instead — feeding the sprite-collision logic. This is the mechanism
// behind VICII/spritex demusinterruptus: two sprites at X $14C (real data ends
// exactly at raw $164 = $14C+24) emit overlapping garbage and so collide on
// $D01E even though their real pixels never overlap.
//
// COLLISION-ONLY: VICE-6569 (a solid single-colour sprite at X=$14C with the
// side border open) shows the 24 real px and NO visible block past the $164
// boundary — the re-trigger drives collision but is NOT painted.
//
// Spec property asserted (NOT impl cycle counts): garbage→collision (but no
// visible pixel) iff the sprite's real data ends AT the $164 boundary; never
// when it extends past it, is disabled, or never started this line.

import { VIC2, CANVAS_W } from '../src/vic2.js';

const BGX = 0x163 + 8;            // canvas X where boundary garbage paints (363)
const BCYC = (BGX >> 3) + 11;     // 56  — boundary cycle column
const CANVAS_Y = 50;

function makeVic() {
  const vic = new VIC2();
  vic.currentVicBank = 0x0000;
  vic.irqHandler = () => {};
  vic._regOffset = 0;             // 6569 (no 8565 -1 sample shift)
  vic._deferCollisionCommit = false;
  return vic;
}

// Configure the per-cycle reg snapshot for the boundary cycles so the garbage
// painter sees an enabled hires sprite 0 at X `xLo`/`msb` with white colour.
function setRegs(vic, { xLo, msb = 1, mxe = 1, multi = 0, xexp = 0 }) {
  for (const c of [BCYC, BCYC + 1, BCYC + 2]) {
    const r = vic.lineCycleRegs[c];
    r[0x00] = xLo;                       // sprite 0 X low
    r[0x10] = msb ? 0x01 : 0x00;         // sprite 0 X MSB
    r[0x15] = mxe ? 0x01 : 0x00;         // MxE enable
    r[0x1C] = multi ? 0x01 : 0x00;       // multicolor
    r[0x1D] = xexp ? 0x01 : 0x00;        // X-expand
    r[0x1B] = 0x00;                      // priority
    r[0x27] = 0x01;                      // sprite 0 colour = white
  }
}

let testNo = 0, failing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { failing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`); currentFailures = []; }
}

// ── 1: sprite ending exactly at raw $164 emits garbage → collision, but the
//      garbage is COLLISION-ONLY (no visible pixels). VICE-6569 verification
//      (a solid single-colour sprite parked at X=$14C with the side border
//      open, testprogs/VICII/sb_sprite_fetch patched to $14C): VICE shows the
//      sprite's 24 real px and NOTHING past the $164 boundary — there is no
//      visible garbage block. The boundary re-trigger only feeds the
//      sprite-collision logic (demusinterruptus collides on $D01E). So the
//      painter must register the collision but never draw a pixel. ────────────
{
  const vic = makeVic();
  // X = $14C (332): sx = 340, end = 340+24 = 364 = $164+8 boundary. Real data
  // ends exactly at the re-trigger point.
  setRegs(vic, { xLo: 0x4C, msb: 1 });
  vic._spriteLineStarted[0] = 1;
  // Pretend another sprite (1) already painted a pixel inside the garbage byte.
  vic.spriteCollisionBuffer[BGX] = 0x02;
  // Spy: the garbage must NOT paint any visible pixel (collision-only).
  let drawCalls = 0;
  vic._drawSpritePixel = () => { drawCalls++; };

  vic._paintSpriteBoundaryGarbage(0, CANVAS_Y);

  expect((vic.regs[0x1E] & 0x03) === 0x03,
    `garbage collides with sprite 1 → $D01E bits 0+1 set (got $${vic.regs[0x1E].toString(16)})`);
  expect(drawCalls === 0,
    `boundary garbage is collision-only — no visible pixel painted (got ${drawCalls} draws)`);
  ok('Sprite ending at raw $164 emits collision-only boundary garbage (no visible block)');
}

// ── 2: sprite extending PAST $164 emits NO garbage (real data shown) ────
{
  const vic = makeVic();
  // X = $160 (352): sx = 360, end = 384 — real data still present at $164.
  setRegs(vic, { xLo: 0x60, msb: 1 });
  vic._spriteLineStarted[0] = 1;
  vic.spriteCollisionBuffer[BGX] = 0x02;

  vic._paintSpriteBoundaryGarbage(0, CANVAS_Y);

  expect(vic.regs[0x1E] === 0,
    `sprite extends past $164 → no garbage, no collision (got $${vic.regs[0x1E].toString(16)})`);
  ok('Sprite extending past $164 emits no boundary garbage (FppScroller/OrbitUntold safe)');
}

// ── 3: disabled sprite (MxE clear) emits no garbage ────────────────────
{
  const vic = makeVic();
  setRegs(vic, { xLo: 0x4C, msb: 1, mxe: 0 });
  vic._spriteLineStarted[0] = 1;
  vic.spriteCollisionBuffer[BGX] = 0x02;

  vic._paintSpriteBoundaryGarbage(0, CANVAS_Y);

  expect(vic.regs[0x1E] === 0,
    `MxE clear → no garbage (got $${vic.regs[0x1E].toString(16)})`);
  ok('Disabled sprite (MxE clear) emits no boundary garbage');
}

// ── 4: sprite that never started this line emits no garbage ────────────
{
  const vic = makeVic();
  setRegs(vic, { xLo: 0x4C, msb: 1 });
  vic._spriteLineStarted[0] = 0;     // not displaying this line
  vic.spriteCollisionBuffer[BGX] = 0x02;

  vic._paintSpriteBoundaryGarbage(0, CANVAS_Y);

  expect(vic.regs[0x1E] === 0,
    `not started → no garbage (got $${vic.regs[0x1E].toString(16)})`);
  ok('Sprite not displaying this line emits no boundary garbage');
}

// ── 5: master flag spriteBoundaryGarbage gates the whole feature ────────
// (The dispatch checks the flag before calling the painter; here we assert the
//  flag exists and defaults on so the documented bisection toggle is real.)
{
  const vic = makeVic();
  expect(vic.spriteBoundaryGarbage === true, 'spriteBoundaryGarbage defaults true');
  ok('Boundary-garbage master flag present and default-on');
}

console.log(`\n${testNo - failing}/${testNo} passed`);
if (failing) process.exit(1);
