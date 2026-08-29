// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Pixel-art speaker glyph for the Settings ▸ Sound mute toggle, drawn in the
// C64/PETSCII block-graphics spirit: chunky pixels on a 16×12 grid emitted as
// crisp merged <rect> runs, so it stays sharp at any size and inherits the
// button's currentColor (light text normally, red when muted). Two glyphs share
// the same speaker body — ON adds two sound-wave arcs, MUTE adds an X. Both are
// injected into #btn-mute-toggle once; CSS shows the right one per state.
const COLS = 16, ROWS = 12;

// Build the merged-rect run string for the shared speaker body plus whatever
// `extra(rect, px)` draws (waves or the X). rect/px take grid coordinates.
function build(extra) {
  const g = Array.from({ length: ROWS }, () => new Uint8Array(COLS));
  const rect = (c0, c1, r0, r1) => { for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) g[r][c] = 1; };
  const px = (c, r) => { g[r][c] = 1; };
  // Speaker body: magnet box at left + cone widening to the mouth at right.
  rect(1, 3, 4, 7); rect(4, 4, 3, 8); rect(5, 6, 2, 9);
  extra(rect, px);
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
  `<svg class="spk ${cls}" viewBox="0 0 ${COLS} ${ROWS}" fill="currentColor" ` +
  `shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;

// Two nested ")" sound-wave arcs off the mouth.
export const SPEAKER_ON_SVG = wrap('spk-on', build((rect, px) => {
  px(8, 3); rect(9, 9, 4, 7); px(8, 8);
  px(11, 2); rect(12, 12, 3, 8); px(11, 9);
}));

// An X where the waves would be.
export const SPEAKER_MUTE_SVG = wrap('spk-mute', build((rect, px) => {
  px(9, 3); px(14, 3); px(10, 4); px(13, 4); px(11, 5); px(12, 5);
  px(11, 6); px(12, 6); px(10, 7); px(13, 7); px(9, 8); px(14, 8);
}));
