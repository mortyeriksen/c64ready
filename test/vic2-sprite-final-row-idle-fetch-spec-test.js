// Final-row idle fetch must not be mistaken for a display turn-on.
//
// Bauer §3.8.1: rule 4 (cy 58) enters display at MC := MCBASE = 0, so a
// sprite's turn-on line always shows row 0. Rule 8 (cy 16) switches DMA off
// once MCBASE reaches 63, which is BEFORE the sprite's own p/s slots for
// sprites 0-2 (cy 58..63) — so on its FINAL display line a sprite performs an
// idle fetch (VIC-Addendum "sprite idle fetch") exactly like it does on a
// same-line X>=$164 turn-on line. The idle fetch alone therefore cannot
// identify a turn-on; the row number is what separates the two.
//
// That distinction is CPU-visible through §3.8.2 sprite-sprite collision: a
// sprite whose X is reached after the cy-58 display-FF drop shows nothing on its
// final line, so two such sprites do not collide there (VICII/spritegap3's
// "gap"). The mirror property — a genuine X>=$164 turn-on line DOES show its
// idle-fetched row 0 — is pinned by vic2-sprite-sb-fetch-spec-test.js.
//
// This drives a bare VIC through real cycles, so it needs BOTH halves of the
// machine cycle: vic.clock(1) (phi1) and vic.phi2() — the idle fetch samples
// the bus at phi2, so a clock()-only loop never performs one.

import { VIC2 } from '../src/vic2.js';

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
  vic.regs[0x11] = 0x1B;      // DEN, text mode, RSEL
  vic.regs[0x16] = 0x08;      // CSEL
  vic.regs[0x18] = 0x10;      // screen $0400 → sprite pointers at $07F8
  return vic;
}

function driveTo(vic, raster, cycle = 20) {
  while (!(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
    vic.phi2();
  }
}

// spritegap3's scenario: sprites n and m, single lit pixel on their LAST row
// (row 20) at the same absolute X (pattern $40 vs $80, xpos(m) = xpos(n)+1),
// Y=128. $D01E is cleared at raster $90 and read at raster $A0, so only rows
// 16..20 are measured — the row-0 idle-FF-idle effect stays out of the window.
// Returns $D01E as the CPU would see it.
function finalRowCollision(vic, n, m, rawX) {
  const mx = (rawX + 1) & 0x1FF;
  vic.ram[0x07F8 + n] = 0x0D;              // sprite n data at $0340
  vic.ram[0x07F8 + m] = 0x0E;              // sprite m data at $0380
  vic.ram[0x0340 + 60] = 0x40;             // row 20, byte 0 — bit 6
  vic.ram[0x0380 + 60] = 0x80;             // row 20, byte 0 — bit 7
  // Register writes go through write() so the per-cycle capture dedup sees a
  // new snapshot version (poking regs[] directly leaves stale snapshots).
  vic.write(0x15, (1 << n) | (1 << m));
  vic.write(n * 2 + 1, 128);
  vic.write(m * 2 + 1, 128);
  vic.write(n * 2, rawX & 0xFF);
  vic.write(m * 2, mx & 0xFF);
  vic.write(0x10, ((rawX > 255 ? 1 : 0) << n) | ((mx > 255 ? 1 : 0) << m));
  vic.write(0x17, 0); vic.write(0x1C, 0); vic.write(0x1D, 0);
  // One settle frame with these coordinates, then the measured frame.
  for (let pass = 0; pass < 2; pass++) {
    driveTo(vic, 0x90); vic.read(0x1E);
    driveTo(vic, 0xA0); var seen = vic.read(0x1E);
  }
  return seen;
}

// Shared VIC across cases: sprite state is fully rewritten per measurement and
// each measurement runs its own settle frame.
const vic = makeVic();
driveTo(vic, 0, 0);

// ── 1: the final-row gap — two high-X sprites do not collide ───────────
// rawX $164..$17D is past the cy-58 display-FF drop, so neither sprite shows
// its final row. This is the window a mistaken turn-on re-paint lights up.
{
  for (const rawX of [0x164, 0x166, 0x168, 0x16F, 0x172, 0x17D]) {
    const got = finalRowCollision(vic, 0, 2, rawX);
    expect(got === 0,
      `sprites 0+2 at raw X=$${rawX.toString(16)}: final row is past the cy58 ` +
      `display-FF drop → no $D01E, got $${got.toString(16)}`);
  }
  ok('Bauer §3.8.1 r4: high-X sprites do not collide on their final display row');
}

// ── 2: same for a pair whose lower sprite is 1, and for the 0+1 pair ────
// Sprites 0-2 are the ones that idle-fetch on the final line (their p/s slots
// sit at cy 58..63, after rule 8 has already cleared DMA at cy 16), so these
// are the pairs a turn-on misdetection reaches.
{
  for (const [n, m] of [[0, 1], [1, 2], [1, 7]]) {
    for (const rawX of [0x166, 0x172]) {
      const got = finalRowCollision(vic, n, m, rawX);
      expect(got === 0,
        `sprites ${n}+${m} at raw X=$${rawX.toString(16)}: no final-row collision, ` +
        `got $${got.toString(16)}`);
    }
  }
  ok('final-row gap holds for every pair containing a sprite that idle-fetches at cy58+');
}

// ── 3: the gap has edges — below it the sprites still collide ───────────
// Front edge is sprite-slot dependent: sprite 0 stops one pixel earlier than
// the rest (VICII/spritegap3 logs $163 for sprite-0 pairs, $164 for others).
{
  expect(finalRowCollision(vic, 0, 2, 0x161) === 0x05,
    `sprites 0+2 at raw X=$161: still colliding before the gap`);
  expect(finalRowCollision(vic, 0, 2, 0x162) === 0x00,
    `sprites 0+2 at raw X=$162: gap has started for a sprite-0 pair`);
  expect(finalRowCollision(vic, 1, 2, 0x162) === 0x06,
    `sprites 1+2 at raw X=$162: sprite-0-free pair still collides here`);
  expect(finalRowCollision(vic, 1, 2, 0x163) === 0x00,
    `sprites 1+2 at raw X=$163: gap has started`);
  ok('VICII/spritegap3: gap front edge is one pixel earlier for sprite-0 pairs');
}

// ── 4: and above it, collision resumes at the slot-dependent restart ────
// Old PAL restarts final-row collision in the physical right border at an X
// that follows the HIGHER sprite slot (logged $17F + (m-1)·$10).
{
  const cases = [[0, 1, 0x17e, 0x03], [0, 2, 0x18e, 0x05],
                 [1, 2, 0x18e, 0x06], [2, 3, 0x19e, 0x0c]];
  for (const [n, m, restart, mask] of cases) {
    expect(finalRowCollision(vic, n, m, restart - 1) === 0x00,
      `sprites ${n}+${m} at raw X=$${(restart - 1).toString(16)}: still inside the gap`);
    expect(finalRowCollision(vic, n, m, restart) === mask,
      `sprites ${n}+${m} at raw X=$${restart.toString(16)}: collision resumes ` +
      `($${mask.toString(16)})`);
  }
  ok('VICII/spritegap3: right-border collision restart follows the later sprite slot');
}

console.log(`\n${testNo} final-row idle-fetch spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
