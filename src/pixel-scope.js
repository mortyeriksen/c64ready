// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/pixel-scope.js — pixel-art scope glyph for the datasette's signal viewer.
//
// Same idiom as the speaker beside it (src/pixel-speaker.js): chunky pixels on a
// 16×12 grid, emitted as merged <rect> runs so it stays crisp at any size and
// takes the button's currentColor. A screen with a square wave on it — which is
// literally what a C64 tape holds.
const COLS = 16, ROWS = 12;

const g = Array.from({ length: ROWS }, () => new Uint8Array(COLS));
const rect = (c0, c1, r0, r1) => { for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) g[r][c] = 1; };

// Screen frame.
rect(1, 14, 1, 1); rect(1, 14, 10, 10); rect(1, 1, 1, 10); rect(14, 14, 1, 10);
// The trace: low, up, high, down, low, up, high — two cycles across the screen.
rect(3, 4, 7, 7); rect(4, 4, 4, 7); rect(5, 6, 4, 4);
rect(6, 6, 4, 7); rect(7, 8, 7, 7); rect(8, 8, 4, 7);
rect(9, 10, 4, 4); rect(10, 10, 4, 7); rect(11, 12, 7, 7);

let rects = '';
for (let y = 0; y < ROWS; y++) {
  let x = 0;
  while (x < COLS) {
    if (g[y][x]) { let e = x; while (e < COLS && g[y][e]) e++; rects += `<rect x="${x}" y="${y}" width="${e - x}" height="1"/>`; x = e; }
    else x++;
  }
}

export const SCOPE_SVG =
  `<svg class="spk scope-glyph" viewBox="0 0 ${COLS} ${ROWS}" fill="currentColor" ` +
  `shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
