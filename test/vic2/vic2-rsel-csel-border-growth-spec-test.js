// VIC-II §3.4 — Display window dimensions: RSEL/CSEL border growth.
//
// Bauer §3.4 ("Display generation and display window dimensions"): the
// 24-row / 38-column selections do NOT move the display window or the
// 40×25 character matrix — they make the BORDER grow INTO the window by
// fixed pixel amounts:
//
//   RSEL: 1 → 25 rows, first/last display line 51 ($33)/250 ($FA)
//         0 → 24 rows, first/last display line 55 ($37)/246 ($F6)
//         => top & bottom borders each grow 4px into the window.
//   CSEL: 1 → 40 cols, first/last display X 24 ($18)/343 ($157)
//         0 → 38 cols, first/last display X 31 ($1F)/334 ($14E)
//         => left border grows 7px, right border grows 9px.
//
// `vic2-spec-tables-spec-test.js` already pins the raw §3.9 comparator
// constants (24/31/335/344 and 51/55/247/251). This file pins the §3.4
// INVARIANT those constants must satisfy: the exact 4/4/7/9 px growth and
// that narrowing the window only shrinks it (border grows inward), keeping
// the window an integral number of 8px character cells.
//
// Note on the §3.4-vs-§3.9 convention (documented in vic2-spec-tables): the
// impl's getters return the §3.9 *comparator* values (= last-visible-coord
// + 1). The GROWTH DELTAS are convention-independent, so they read directly
// from those comparators.

import { makeVic, assert } from './_vic2-helpers.js';

function hCompare(vic, csel) {
  vic.regs[0x16] = csel ? 0x08 : 0x00; // bit 3 = CSEL
  return vic._getHorizontalBorderCompareX(vic.regs);
}

function vRange(vic, rsel) {
  vic.regs[0x11] = rsel ? 0x08 : 0x00; // bit 3 = RSEL
  return vic._getVerticalDisplayRange(vic.regs);
}

// GROWTH-H: CSEL=0 grows the left border 7px and the right border 9px into
// the window (Bauer §3.4).
{
  const vic = makeVic();
  const wide = hCompare(vic, 1);   // CSEL=1, 40 cols
  const narrow = hCompare(vic, 0); // CSEL=0, 38 cols

  // Absolute comparators (Bauer §3.9 table, the substrate of the §3.4 rule).
  assert(wide.left === 24,   `Bauer §3.4/§3.9: CSEL=1 left compare is 24 (got ${wide.left})`);
  assert(wide.right === 344, `Bauer §3.4/§3.9: CSEL=1 right compare is 344 (got ${wide.right})`);
  assert(narrow.left === 31, `Bauer §3.4/§3.9: CSEL=0 left compare is 31 (got ${narrow.left})`);
  assert(narrow.right === 335,`Bauer §3.4/§3.9: CSEL=0 right compare is 335 (got ${narrow.right})`);

  // §3.4 growth invariant.
  assert(narrow.left - wide.left === 7,
    `Bauer §3.4: CSEL=0 grows the LEFT border exactly 7px into the window (got ${narrow.left - wide.left})`);
  assert(wide.right - narrow.right === 9,
    `Bauer §3.4: CSEL=0 grows the RIGHT border exactly 9px into the window (got ${wide.right - narrow.right})`);

  // Border grows INWARD: the narrow window is strictly inside the wide one.
  assert(narrow.left > wide.left && narrow.right < wide.right,
    `Bauer §3.4: CSEL=0 window lies strictly inside the CSEL=1 window (border grows inward, doesn't move the window)`);

  console.log('ok  - GROWTH-H: §3.4 — CSEL=0 grows borders 7px (left) / 9px (right) into the window');
}

// GROWTH-V: RSEL=0 grows the top and bottom borders 4px each into the
// window (Bauer §3.4).
{
  const vic = makeVic();
  const tall = vRange(vic, 1);   // RSEL=1, 25 rows
  const short = vRange(vic, 0);  // RSEL=0, 24 rows

  assert(tall.top === 51,    `Bauer §3.4/§3.9: RSEL=1 top compare is 51 (got ${tall.top})`);
  assert(tall.bottom === 251,`Bauer §3.4/§3.9: RSEL=1 bottom compare is 251 (got ${tall.bottom})`);
  assert(short.top === 55,   `Bauer §3.4/§3.9: RSEL=0 top compare is 55 (got ${short.top})`);
  assert(short.bottom === 247,`Bauer §3.4/§3.9: RSEL=0 bottom compare is 247 (got ${short.bottom})`);

  assert(short.top - tall.top === 4,
    `Bauer §3.4: RSEL=0 grows the TOP border exactly 4px into the window (got ${short.top - tall.top})`);
  assert(tall.bottom - short.bottom === 4,
    `Bauer §3.4: RSEL=0 grows the BOTTOM border exactly 4px into the window (got ${tall.bottom - short.bottom})`);

  assert(short.top > tall.top && short.bottom < tall.bottom,
    `Bauer §3.4: RSEL=0 window lies strictly inside the RSEL=1 window (border grows inward, doesn't move the window)`);

  console.log('ok  - GROWTH-V: §3.4 — RSEL=0 grows top & bottom borders 4px each into the window');
}

// WINDOW-DIM: each window spans an integral number of 8px character cells —
// 40/38 cols and 25/24 rows — confirming the matrix shrinks by exactly the
// border growth (Bauer §3.4: 320×200, 304×200, 320×192, 304×192).
{
  const vic = makeVic();
  const wide = hCompare(vic, 1), narrow = hCompare(vic, 0);
  const tall = vRange(vic, 1), short = vRange(vic, 0);

  assert(wide.right - wide.left === 320,
    `Bauer §3.4: CSEL=1 window is 320px = 40 cols × 8 (got ${wide.right - wide.left})`);
  assert(narrow.right - narrow.left === 304,
    `Bauer §3.4: CSEL=0 window is 304px = 38 cols × 8 (got ${narrow.right - narrow.left})`);
  assert(tall.bottom - tall.top === 200,
    `Bauer §3.4: RSEL=1 window is 200px = 25 rows × 8 (got ${tall.bottom - tall.top})`);
  assert(short.bottom - short.top === 192,
    `Bauer §3.4: RSEL=0 window is 192px = 24 rows × 8 (got ${short.bottom - short.top})`);

  // The two columns lost (40→38) = 16px = the 7px left + 9px right growth.
  assert((wide.right - wide.left) - (narrow.right - narrow.left) === 16,
    `Bauer §3.4: CSEL=1→0 removes exactly 2 columns (16px = 7px left + 9px right)`);
  // The one row lost (25→24) = 8px = the 4px top + 4px bottom growth.
  assert((tall.bottom - tall.top) - (short.bottom - short.top) === 8,
    `Bauer §3.4: RSEL=1→0 removes exactly 1 row (8px = 4px top + 4px bottom)`);

  console.log('ok  - WINDOW-DIM: §3.4 — windows are integral 8px cells; growth removes exactly 2 cols / 1 row');
}

console.log('\nAll VIC-II RSEL/CSEL border-growth (§3.4) tests passed.');
