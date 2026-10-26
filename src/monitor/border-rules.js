// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

// Bauer §3.9 comparator rules. Inputs are comparator events, not renderer cycles.
// Phase conversion, delayed latch effects and §3.14.1 tricks require a separate
// capture adapter. This module neither imports the VIC nor validates its output.
export const BORDER_RULES = Object.freeze([
  ['border.main.right', 1, 'Close the main border at the right edge'],
  ['border.vertical.bottom.line', 2, 'Close the vertical border at line end'],
  ['border.vertical.top.line', 3, 'Open the vertical border at line end'],
  ['border.vertical.bottom.left', 4, 'Close the vertical border at the left edge'],
  ['border.vertical.top.left', 5, 'Open the vertical border at the left edge'],
  ['border.main.left', 6, 'Open the main border when the vertical gate permits'],
].map(([id, number, title]) => Object.freeze({ id, number, title,
  section: '3.9', source: 'https://www.cebix.net/VIC-Article.txt', revision: '2024-09-29' })));

export function borderComparators(d011, d016, out = {}) {
  if (!Number.isInteger(d011) || d011 < 0 || d011 > 255 || !Number.isInteger(d016) || d016 < 0 || d016 > 255) return null;
  out.left=d016&8?24:31; out.right=d016&8?344:335;
  out.top=d011&8?51:55; out.bottom=d011&8?251:247; out.den=!!(d011&16);
  return out;
}

// Null is unknown, including a starting state omitted by a capture. A definite
// SET or RESET can establish a known state without guessing the earlier one.
export function stepBorderComparators(state, sample) {
  const compare = borderComparators(sample?.d011, sample?.d016);
  if (!compare || !Number.isInteger(sample.raster) || sample.raster < 0 || sample.raster > 311
      || !Number.isInteger(sample.x) || sample.x < 0 || sample.x > 511
      || typeof sample.endOfLine !== 'boolean') {
    return { mainClosed: null, verticalClosed: null, rules: 0, valid: false };
  }
  let mainClosed = typeof state?.mainClosed === 'boolean' ? state.mainClosed : null;
  let verticalClosed = typeof state?.verticalClosed === 'boolean' ? state.verticalClosed : null;
  let rules = 0;
  if (sample.x === compare.right) { mainClosed = true; rules |= 1; }
  if (sample.endOfLine) {
    if (sample.raster === compare.bottom) { verticalClosed = true; rules |= 2; }
    if (sample.raster === compare.top && compare.den) { verticalClosed = false; rules |= 4; }
  }
  if (sample.x === compare.left) {
    if (sample.raster === compare.bottom) { verticalClosed = true; rules |= 8; }
    if (sample.raster === compare.top && compare.den) { verticalClosed = false; rules |= 16; }
    if (verticalClosed === false) { mainClosed = false; rules |= 32; }
    else if (verticalClosed === null && mainClosed !== false) mainClosed = null;
  }
  return { mainClosed, verticalClosed, rules, valid: true };
}

export function replayBorderComparators(initial, samples) {
  const states = [];
  let state = initial;
  for (const sample of samples) { state = stepBorderComparators(state,sample); states.push(state); }
  return states;
}
