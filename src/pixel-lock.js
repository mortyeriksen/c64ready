// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Pixel-art padlock glyph for the disk write-protect toggle, drawn in the
// C64/PETSCII block-graphics spirit: chunky pixels on a 12×13 grid emitted as
// crisp merged <rect> runs, so it stays sharp at any size and inherits the
// button's currentColor. Two glyphs share the same lock body + keyhole: LOCKED
// has a closed shackle (both legs into the body); UNLOCKED has the shackle open
// on the right (left leg in, right leg lifted out). Both are injected into each
// write-protect button once; CSS shows the right one by the button's
// aria-pressed state (matching the pixel-speaker mute toggle).
const COLS = 12, ROWS = 13;

function build(shackle) {
  const g = Array.from({ length: ROWS }, () => new Uint8Array(COLS));
  const rect = (c0, c1, r0, r1) => { for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) g[r][c] = 1; };
  const px = (c, r) => { g[r][c] = 1; };
  const clr = (c, r) => { g[r][c] = 0; };
  // Lock body (shared) with a keyhole punched out of the centre.
  rect(1, 10, 5, 12);
  for (let r = 7; r <= 10; r++) { clr(5, r); clr(6, r); }
  shackle(px);
  // Merge each row's horizontal runs of set pixels into one <rect> → compact.
  let out = '';
  for (let y = 0; y < ROWS; y++) {
    let x = 0;
    while (x < COLS) {
      if (g[y][x]) { let e = x; while (e < COLS && g[y][e]) e++; out += `<rect x="${x}" y="${y}" width="${e - x}" height="1"/>`; x = e; }
      else x++;
    }
  }
  return out;
}

const wrap = (cls, rects) =>
  `<svg class="lock ${cls}" viewBox="0 0 ${COLS} ${ROWS}" fill="currentColor" ` +
  `shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;

// Closed shackle: both legs descend into the body.
export const LOCK_CLOSED_SVG = wrap('lock-closed', build((px) => {
  px(4, 0); px(5, 0); px(6, 0); px(7, 0);   // arch
  px(3, 1); px(8, 1);                        // shoulders
  px(3, 2); px(3, 3); px(3, 4);             // left leg
  px(8, 2); px(8, 3); px(8, 4);             // right leg
}));

// Open shackle: left leg stays in the body, the right side kicks up and out and
// its leg is lifted clear — the classic "unlocked" look.
export const LOCK_OPEN_SVG = wrap('lock-open', build((px) => {
  px(4, 0); px(5, 0); px(6, 0); px(7, 0);   // arch
  px(3, 1); px(8, 1); px(9, 1);             // shoulders (right kicks out)
  px(3, 2); px(8, 2);                        // legs at the shoulder line
  px(3, 3); px(3, 4);                        // left leg continues into the body
}));
