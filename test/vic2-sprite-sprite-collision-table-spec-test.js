// Sprite-sprite collision across edge X-coordinates — synthesized from
// the VICE test-suite program `sprite-sprite.prg` (VICII/spritecollisions),
// without loading the PRG (per AGENTS.md: synthesize VIC state directly).
//
// The PRG places two single-pixel sprites (6 & 7) at the SAME X/Y across
// an 11-entry table and reads the sprite-sprite collision register $D01E.
// Its documented C64/C64C result (readme.txt) is:
//     ---------@-      `-` = $C0 (sprites 6+7 collide), `@` = 0 (no coll)
// i.e. the two overlapping pixels collide at every X EXCEPT entry 9, where
// both sprites sit at X=511 ($1FF) — a coordinate inside the $1F8..$1FF
// band the PAL horizontal counter skips (Bauer §3.8). There the sprites
// are never displayed, so they cannot collide.
//
// Each entry below enables sprites 6 & 7 with a single-pixel shifter
// (top-left pixel, like the PRG's $3FC0=$80 sprite data) at the same X,
// renders one line, and asserts $D01E. Y is not modeled — sprite display
// is forced on — because the readme result is X-dependent only.
//
// Regression guard for the phantom-collision bug where the modular canvas
// wrap aliased X=511 (sx=519) onto canvas X=15 and painted both sprites
// there, falsely latching $D01E.

import { VIC2, CANVAS_W } from '../src/vic2.js';

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

// Enable a single-pixel sprite `s` at sprite-X `regX` (9-bit). The shifter
// holds only the leftmost pixel (0x800000), matching the PRG's $80,$00,$00
// sprite row, so the sprite paints exactly one pixel at canvas X = regX+8.
function setupSinglePixelSprite(vic, s, regX) {
  for (let cycle = 1; cycle <= 63; cycle++) {
    const cr = vic.lineCycleRegs[cycle];
    cr[0x15] |= (1 << s);                       // sprite enable
    cr[s * 2] = regX & 0xFF;                    // X low byte
    if (regX > 255) cr[0x10] |= (1 << s); else cr[0x10] &= ~(1 << s);  // X MSB
    cr[0x27 + s] = 0x01;                        // sprite color (white)
    vic.lineCycleSpriteDisplayOn[cycle][s] = 1;
    vic.lineCycleSpriteDataRow[cycle][s] = 0;
    vic.lineCycleSpriteRowByteMask[cycle][s] = 0x07;
    vic.lineCycleSpriteShiftReg[cycle][s] = 0x800000;   // leftmost pixel only
    vic.lineCycleHBorderBefore[cycle] = 0;
    vic.lineCycleHBorder[cycle] = 0;
    vic.lineCycleVBorderBefore[cycle] = 0;
    vic.lineCycleVBorder[cycle] = 0;
  }
}

// readme.txt C64/C64C table — sprite-X and whether 6&7 collide there.
// $C0 = bits 6|7 set in $D01E. Entry 9 (X=511) is the lone non-collision.
const ENTRIES = [
  { x: 0,   coll: true  },
  { x: 23,  coll: true  },
  { x: 24,  coll: true  },   // first visible
  { x: 24,  coll: true  },
  { x: 0,   coll: true  },
  { x: 50,  coll: true  },
  { x: 255, coll: true  },
  { x: 250, coll: true  },
  { x: 255, coll: true  },
  { x: 511, coll: false },   // $1FF — counter-skipped band: no display, no collision
  { x: 343, coll: true  },   // MSB set, X=343 — still on the line
];

const cy = 50;
const observed = [];
for (const { x } of ENTRIES) {
  const vic = makeVic();
  setupSinglePixelSprite(vic, 6, x);
  setupSinglePixelSprite(vic, 7, x);
  vic._renderSpriteLine(50, cy);
  observed.push(vic.regs[0x1E]);
}

// ── 1: each table entry latches the expected $D01E ─────────────────────
{
  for (let i = 0; i < ENTRIES.length; i++) {
    const want = ENTRIES[i].coll ? 0xC0 : 0x00;
    expect(observed[i] === want,
      `entry ${i} (X=${ENTRIES[i].x}): expected $D01E=$${want.toString(16)}, ` +
      `got $${observed[i].toString(16)}`);
  }
  ok('Bauer §3.11: sprites 6&7 overlap → $D01E=$C0 at every reachable X');
}

// ── 2: entry 9 (X=511, $1FF) — sprites in the skipped band never collide
{
  expect(observed[9] === 0x00,
    `two single-pixel sprites at X=511 ($1FF): X counter skips $1F8..$1FF ` +
    `→ no display, no collision (expected $D01E=0), got $${observed[9].toString(16)}`);
  ok('Bauer §3.8: two sprites at X=511 do not collide (no canvas-X=15 phantom)');
}

// ── 3: rendered collision row matches the readme pattern ---------@- ───
{
  const pattern = observed.map(v => (v === 0xC0 ? '-' : (v === 0 ? '@' : '?'))).join('');
  expect(pattern === '---------@-',
    `collision pattern must be "---------@-" (readme C64/C64C), got "${pattern}"`);
  ok('readme.txt: sprite-sprite.prg pattern reproduced as ---------@-');
}

console.log(`\n${testNo} sprite-sprite collision-table spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
