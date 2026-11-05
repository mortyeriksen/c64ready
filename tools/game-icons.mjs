// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Draws each game's icon (tools/game-icons-art.mjs) as an SVG in public/gameicons/: the 16x16
// drawing on an 18x18 grid, a dark outline round its shape, each pixel lit on a top or left edge
// and shaded on a bottom or right one. Also writes the list of games with an icon to
// src/achievements/game-icons.js.
//
//   node tools/game-icons.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { GAME_ICON_ART } from './game-icons-art.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ICON_DIR = path.join(ROOT, 'public/gameicons');
export const ICON_LIST = path.join(ROOT, 'src/achievements/game-icons.js');

/** The C64's colours by letter, brightened to read on the dark and the light panels. */
export const ICON_COLOURS = {
  k: '#14101e', w: '#fff4e8', r: '#ff2a4d', c: '#29d0ff', p: '#b04ae0', g: '#1e9e4a', b: '#2f5ee0', y: '#ffe327',
  o: '#ff9a1f', n: '#a8542e', l: '#ffc49a', d: '#4a4660', m: '#8a87a8', G: '#52e05a', B: '#6cb8ff', L: '#c8c8d8',
};
export const OUTLINE = '#0a0814';
export const SIZE = 16, GRID = SIZE + 2;

const mix = (hex, to, a) => '#' + [1, 3, 5].map((i) => {
  const v = parseInt(hex.slice(i, i + 2), 16);
  return Math.round(v + (to - v) * a).toString(16).padStart(2, '0');
}).join('');
/** A colour lit on a top or left edge. */
export const lit = (hex) => mix(hex, 255, 0.35);
/** A colour shaded on a bottom or right edge. */
export const shaded = (hex) => mix(hex, 0, 0.35);

/** The colour of each cell of the 18x18 grid, null for none. */
export function iconCells(rows) {
  const on = (x, y) => (rows[y]?.[x] ?? '.') !== '.';
  return Array.from({ length: GRID }, (_, gy) => Array.from({ length: GRID }, (_, gx) => {
    const x = gx - 1, y = gy - 1;
    if (!on(x, y)) return on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1) ? OUTLINE : null;
    const base = ICON_COLOURS[rows[y][x]];
    const top = !on(x, y - 1) || !on(x - 1, y), bottom = !on(x, y + 1) || !on(x + 1, y);
    return top && !bottom ? lit(base) : bottom && !top ? shaded(base) : base;
  }));
}

/** The icon as an SVG: one path per colour, a rectangle per run of it along a row. */
export function iconSvg(rows) {
  const paths = new Map();
  iconCells(rows).forEach((row, y) => {
    for (let x = 0; x < GRID;) {
      let end = x + 1;
      while (end < GRID && row[end] === row[x]) end++;
      if (row[x]) paths.set(row[x], (paths.get(row[x]) ?? '') + `M${x} ${y}h${end - x}v1h-${end - x}z`);
      x = end;
    }
  });
  const body = [...paths].map(([fill, d]) => `<path fill="${fill}" d="${d}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" width="${GRID}" height="${GRID}" shape-rendering="crispEdges">${body}</svg>\n`;
}

/** The app's list of games with an icon. */
export function iconList(ids) {
  return `// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/achievements/game-icons.js — the games with an icon in public/gameicons/, written by
// tools/game-icons.mjs from tools/game-icons-art.mjs. A game without one shows its initial.

export const GAME_ICONS = new Set([
${ids.map((id) => `  '${id}',`).join('\n')}
]);
/** An icon's width and height in its own pixels, its outline included. */
export const ICON_GRID = ${GRID};

const BASE = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/';
/** A game's icon as a URL, or null for a game without one. */
export const gameIconUrl = (id) => (GAME_ICONS.has(id) ? \`\${BASE}gameicons/\${id}.svg\` : null);
`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  fs.mkdirSync(ICON_DIR, { recursive: true });
  const ids = Object.keys(GAME_ICON_ART).sort();
  for (const id of ids) fs.writeFileSync(path.join(ICON_DIR, `${id}.svg`), iconSvg(GAME_ICON_ART[id]));
  for (const f of fs.readdirSync(ICON_DIR)) if (f.endsWith('.svg') && !GAME_ICON_ART[f.slice(0, -4)]) fs.unlinkSync(path.join(ICON_DIR, f));
  fs.writeFileSync(ICON_LIST, iconList(ids));
  console.log(`${ids.length} icons in ${path.relative(ROOT, ICON_DIR)}/`);
}
