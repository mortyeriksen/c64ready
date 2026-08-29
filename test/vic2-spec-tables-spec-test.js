// VIC-II spec-table pins: small, focused exact-equality asserts against
// hard-wired constants from the Bauer reference.
//
//   §3.2 — Register mirroring. The chip decodes A0-A5 only, so the 64-
//          byte register file mirrors 16× across $D000-$D3FF. $D02F-$D03F
//          always read $FF (writes ignored). $D020-$D02E are 4-bit color
//          regs — high nibble reads as $F.
//   §3.9 — Border-unit comparator constants. Horizontal: CSEL=0 → 31/335,
//          CSEL=1 → 24/344. Vertical: RSEL=0 → 55/247, RSEL=1 → 51/251.
//
// Extracted from vic2-test.js (was tests REG-MIRROR-1..3 and BORDER-CMP-1..2).

import { makeVic, assert } from './_vic2-helpers.js';

// REG-MIRROR-1: every $40-byte stride reads the same register.
{
  const vic = makeVic();
  // Pick a register with a directly-readable value: $D000 (sprite 0 X low).
  // (Avoid bits-set-from-state regs like $D011/$D016/$D018/$D019 which
  // inject synthetic high bits in their read paths.)
  vic.write(0x00, 0x55);
  for (let m = 0; m < 16; m++) {
    const mirror = (m << 6) | 0x00;
    assert(vic.read(mirror) === 0x55,
      `Bauer §3.2: $D000 mirror at +${m * 0x40} reads back the same value (got ${vic.read(mirror).toString(16)})`);
  }
  // Writing through a mirror also lands on the canonical register.
  vic.write(0x180, 0xA3);  // $D180 mirrors $D000
  assert(vic.read(0x00) === 0xA3,
    `Bauer §3.2: write through mirror $D180 lands on canonical $D000`);
  assert(vic.regs[0x00] === 0xA3,
    `Bauer §3.2: write through mirror updates the underlying register file`);
  console.log('ok  - REG-MIRROR-1: §3.2 — register file mirrors every $40 across $D000-$D3FF');
}

// REG-MIRROR-2: $D02F-$D03F are unconnected and read $FF.
{
  const vic = makeVic();
  for (let r = 0x2F; r <= 0x3F; r++) {
    assert(vic.read(r) === 0xFF,
      `Bauer §3.2: unused register $D0${r.toString(16).padStart(2, '0').toUpperCase()} reads $FF (got ${vic.read(r).toString(16)})`);
  }
  // Writes to the dead range are ignored (no exceptions; reads still $FF).
  for (let r = 0x2F; r <= 0x3F; r++) vic.write(r, 0x42);
  for (let r = 0x2F; r <= 0x3F; r++) {
    assert(vic.read(r) === 0xFF,
      `Bauer §3.2: write to unused register $D0${r.toString(16).padStart(2, '0').toUpperCase()} doesn't change its $FF read value`);
  }
  console.log('ok  - REG-MIRROR-2: §3.2 — $D02F-$D03F always read $FF');
}

// REG-MIRROR-3: color registers ($D020-$D02E) read with high nibble
// forced to $F.
{
  const vic = makeVic();
  for (let r = 0x20; r <= 0x2E; r++) {
    vic.write(r, 0x05);
    assert(vic.read(r) === 0xF5,
      `Bauer §3.2: color reg $D0${r.toString(16).padStart(2, '0').toUpperCase()} reads with high nibble $F (got ${vic.read(r).toString(16)})`);
  }
  console.log('ok  - REG-MIRROR-3: §3.2 — color registers read with unused high nibble $F');
}

// BORDER-CMP-1: horizontal compares (Bauer §3.9 table).
//   CSEL=0 → Left=31  ($1F),  Right=335 ($14F)
//   CSEL=1 → Left=24  ($18),  Right=344 ($158)
{
  const vic = makeVic();

  vic.regs[0x16] = 0x00; // CSEL=0
  let h = vic._getHorizontalBorderCompareX(vic.regs);
  assert(h.left === 31,  `Bauer §3.9: CSEL=0 left compare is exactly 31 (got ${h.left})`);
  assert(h.right === 335, `Bauer §3.9: CSEL=0 right compare is exactly 335 (got ${h.right})`);

  vic.regs[0x16] = 0x08; // CSEL=1
  h = vic._getHorizontalBorderCompareX(vic.regs);
  assert(h.left === 24,  `Bauer §3.9: CSEL=1 left compare is exactly 24 (got ${h.left})`);
  assert(h.right === 344, `Bauer §3.9: CSEL=1 right compare is exactly 344 (got ${h.right})`);

  console.log('ok  - BORDER-CMP-1: §3.9 — horizontal compares 24/31/335/344 match the spec table exactly');
}

// BORDER-CMP-2: vertical compares (Bauer §3.9 table).
//   RSEL=0 → Top=55 ($37),  Bottom=247 ($F7)
//   RSEL=1 → Top=51 ($33),  Bottom=251 ($FB)
{
  const vic = makeVic();

  vic.regs[0x11] = 0x00; // RSEL=0 (DEN=0 doesn't matter for compares)
  let v = vic._getVerticalDisplayRange(vic.regs);
  assert(v.top === 55,  `Bauer §3.9: RSEL=0 top compare is exactly 55 (got ${v.top})`);
  assert(v.bottom === 247, `Bauer §3.9: RSEL=0 bottom compare is exactly 247 (got ${v.bottom})`);

  vic.regs[0x11] = 0x08; // RSEL=1
  v = vic._getVerticalDisplayRange(vic.regs);
  assert(v.top === 51,  `Bauer §3.9: RSEL=1 top compare is exactly 51 (got ${v.top})`);
  assert(v.bottom === 251, `Bauer §3.9: RSEL=1 bottom compare is exactly 251 (got ${v.bottom})`);

  console.log('ok  - BORDER-CMP-2: §3.9 — vertical compares 51/55/247/251 match the spec table exactly');
}

console.log('\nAll VIC-II spec-table tests passed.');
