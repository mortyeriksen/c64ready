// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Draws the Achievements guide's overview (docs/GUIDE-ACHIEVEMENTS.md) as an SVG in public/guide/,
// on a dark panel like the guide's other diagrams, with the app's own pixel icons.
//
//   node tools/achievements-guide-art.mjs            writes public/guide/achievements-overview.svg
//   GUIDE_OUT=dir node tools/achievements-guide-art.mjs   writes it elsewhere
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { KIND_ICONS } from '../src/achievements/toast.js';
import { GAME_ICON_ART } from './game-icons-art.mjs';
import { iconSvg, GRID } from './game-icons.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.GUIDE_OUT || path.join(ROOT, 'public/guide');

// The guide's dark palette (tools/tape-guide-art.mjs), and the toasts' kind colours.
const C = {
  bg: '#0b0e24', panel: '#11142e', line: '#2c2f63', text: '#ccd0ec', dim: '#8a8aa8',
  bright: '#ffffff', accent: '#9f9df2', green: '#8fe985', red: '#e8777c', amber: '#e6dd6b', cyan: '#7fd4ff',
};
const FONT = `font-family="ui-monospace, 'SF Mono', Menlo, Consolas, monospace"`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x, y, s, { size = 14, fill = C.text, anchor = 'start', weight = 400 } = {}) =>
  `<text x="${x}" y="${y}" ${FONT} font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
const rect = (x, y, w, h, { fill = C.panel, stroke = C.line, r = 8, sw = 1 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
const arrow = (x1, y, x2, stroke = C.accent) =>
  `<line x1="${x1}" y1="${y}" x2="${x2 - 6}" y2="${y}" stroke="${stroke}" stroke-width="1.6"/><path d="M${x2},${y} L${x2 - 8},${y - 5} L${x2 - 8},${y + 5} Z" fill="${stroke}"/>`;
// A 10x10 pixel icon: '#' in the ink, '+' a deeper shade of it.
function pixels(icon, x, y, cell, ink) {
  let s = '';
  icon.forEach((row, j) => [...row].forEach((c, i) => {
    if (c === '#' || c === '+') s += `<rect x="${x + i * cell}" y="${y + j * cell}" width="${cell}" height="${cell}" fill="${ink}"${c === '+' ? ' opacity="0.55"' : ''}/>`;
  }));
  return s;
}
// A game's colour icon (tools/game-icons.mjs), `cell` pixels to each of its own.
const gameArt = (id, x, y, cell) => iconSvg(GAME_ICON_ART[id]).trim().replace('<svg ', `<svg x="${x}" y="${y}" `).replace(/width="\d+" height="\d+"/, `width="${GRID * cell}" height="${GRID * cell}"`);
// A trophy HUD slot, as the app draws it: lit with its trophy, marked next, out with a red cross, or locked.
function slot(x, y, n, kind) {
  const s = 30;
  if (kind === 'got') return rect(x, y, s, s, { fill: '#2a2440', stroke: C.amber, r: 4 }) + pixels(KIND_ICONS.unlock, x + 5, y + 5, 2, C.amber);
  if (kind === 'out') return rect(x, y, s, s, { fill: 'none', stroke: C.line, r: 4 })
    + `<path d="M${x + 6},${y + 6} L${x + s - 6},${y + s - 6} M${x + s - 6},${y + 6} L${x + 6},${y + s - 6}" stroke="${C.red}" stroke-width="2" opacity="0.8"/>`;
  const next = kind === 'next';
  return rect(x, y, s, s, { fill: 'none', stroke: next ? C.cyan : C.line, r: 4 }) + text(x + s / 2, y + 20, String(n), { size: 12, fill: next ? C.cyan : C.dim, anchor: 'middle' });
}

const W = 1200, H = 580;
let body = text(W / 2, 64, 'How achievements work', { size: 32, fill: C.bright, anchor: 'middle', weight: 600 });
body += text(W / 2, 98, 'Each game with a set has trophies and high-score boards, checked as you play', { size: 16, fill: C.dim, anchor: 'middle' });

const stages = [
  { n: 1, title: 'Load a game', lines: ['Its file is matched', 'to the game\'s set'], art: 'commando-arcade', ink: C.green },
  { n: 2, title: 'Play', lines: ['Each frame, the set', 'reads the C64\'s memory'], icon: KIND_ICONS.unlock, ink: C.amber },
  { n: 3, title: 'Saved', lines: ['Your unlocks and best', 'scores, signed in'], icon: KIND_ICONS.score, ink: C.cyan },
  { n: 4, title: 'Shared', lines: ['Trophy Hunters, high', 'scores and activity'], icon: KIND_ICONS.crown, ink: C.accent },
];
const cw = 240, gap = 40, x0 = (W - (stages.length * cw + (stages.length - 1) * gap)) / 2, y0 = 140, ch = 232;
stages.forEach((s, i) => {
  const x = x0 + i * (cw + gap);
  body += rect(x, y0, cw, ch, { r: 12, stroke: i === 1 ? C.amber : C.line, sw: i === 1 ? 1.8 : 1.2 });
  body += text(x + 20, y0 + 30, String(s.n), { size: 14, fill: C.dim });
  body += s.art ? gameArt(s.art, x + cw / 2 - 27, y0 + 28, 3) : pixels(s.icon, x + cw / 2 - 25, y0 + 30, 5, s.ink);
  body += text(x + cw / 2, y0 + 120, s.title, { size: 21, fill: C.bright, anchor: 'middle', weight: 600 });
  s.lines.forEach((l, k) => { body += text(x + cw / 2, y0 + 148 + k * 20, l, { size: 13, fill: C.text, anchor: 'middle' }); });
  if (i < stages.length - 1) body += arrow(x + cw + 6, y0 + ch / 2, x + cw + gap - 6);
});
// Under Play: the trophy HUD's slots, two lit, the next one up, one out for now.
{
  const x = x0 + (cw + gap) + (cw - 5 * 30 - 4 * 8) / 2, y = y0 + 184;
  ['got', 'got', 'next', 'out', 'locked'].forEach((k, i) => { body += slot(x + i * 38, y, i + 1, k); });
}

// Where it shows.
const py = 420, pw = 255, pg = 20, px0 = (W - (4 * pw + 3 * pg)) / 2;
body += text(W / 2, py - 18, 'Where you see it', { size: 15, fill: C.dim, anchor: 'middle' });
[
  ['GAME tab', 'trophies, boards, your place'],
  ['Trophy HUD', 'in Retro Vibes, as you play'],
  ['Toasts', 'each unlock and new best'],
  ['Attract mode', 'the boards when a game ends'],
].forEach(([t, d], i) => {
  const x = px0 + i * (pw + pg);
  body += rect(x, py, pw, 74, { r: 10 });
  body += text(x + pw / 2, py + 31, t, { size: 16, fill: C.bright, anchor: 'middle', weight: 600 });
  body += text(x + pw / 2, py + 54, d, { size: 12, fill: C.text, anchor: 'middle' });
});
body += text(W / 2, H - 34, 'C64 READY.  ·  Achievements', { size: 14, fill: C.accent, anchor: 'middle', weight: 600 });

const title = 'How achievements work';
const desc = 'Four stages left to right. Load a game, and its file is matched to the game\'s set. Play, and each frame the set reads the C64\'s memory: the trophy HUD shows two trophies lit, the next one up and one out for now. Your unlocks and best scores are saved, signed in. They are shared as Trophy Hunters, high scores and activity. Below, where you see it: the GAME tab, the trophy HUD in Retro Vibes, toasts, and attract mode.';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<rect width="${W}" height="${H}" rx="12" fill="${C.bg}"/>
${body}
</svg>
`;
fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, 'achievements-overview.svg');
fs.writeFileSync(file, svg);
console.log(`wrote ${path.relative(ROOT, file)} (${(svg.length / 1024).toFixed(1)} KB)`);
