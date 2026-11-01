// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Capture the User Guide's theme gallery: for every built-in theme, the main
// screen in dark mode and in light mode, side by side in one image.
//
//   node tools/guide-theme-shots.mjs [baseURL] [themeId ...]
//
// baseURL defaults to http://localhost:5173 (the live dev server). Naming theme
// ids shoots only those. Every shot is the same scene: Commando Arcade's title
// screen at 2.5X, its Achievements window docked on the right, signed in as a
// player with results beside four others (tools/guide-achievements.mjs), 1720px
// wide and cropped with as much room below the C64 screen as above it. Run it
// against a dev server with accounts in memory (VITE_ACCOUNTS_IN_MEMORY=1).
// Output: public/guide/theme-<id>.webp (GUIDE_OUT redirects it), and
// overview-<id>.webp, the dark mode alone at 2x, for every theme including
// Classic. Set GUIDE_OVERVIEW_ONLY=1 to shoot only the overviews.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assetPath } from '../test/external-assets.js';
import { saveGuideShot, shotLabel } from './guide-image.mjs';
import { COMMANDO_ARCADE_ME, COMMANDO_ARCADE_PLAYERS, captureScene, deleteAccounts, seedPlayers } from './guide-achievements.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.GUIDE_OUT ? path.resolve(process.env.GUIDE_OUT) : path.join(root, 'public', 'guide');
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.argv[2] || 'http://localhost:5173';
const ONLY = process.argv.slice(3);
const GAME = assetPath('commando-arcade-crt') || '';
const OVERVIEW_ONLY = process.env.GUIDE_OVERVIEW_ONLY === '1';
const THEMES = ['classic', 'geos', 'breadbin', 'phosphor', 'outrun', 'commando', 'artdeco', 'lookout'].filter((t) => !ONLY.length || ONLY.includes(t));

const browser = await chromium.launch();

// The overviews' players, made once for every theme's shot.
const tokens = [];
let account = null;
if (GAME && fs.existsSync(GAME)) {
  const set = JSON.parse(fs.readFileSync(path.join(root, 'server/sets/commando-arcade.json'), 'utf8'));
  try { account = await seedPlayers(browser, BASE, set.hashes[0].hash, COMMANDO_ARCADE_PLAYERS, COMMANDO_ARCADE_ME, tokens); }
  catch (e) { console.error('  ✗ overview players —', e.message.split('\n')[0]); }
}

// One mode of one theme, in a fresh context. `overview` shoots at 2x (the gallery's pairs at 1x).
async function capture(theme, mode, overview = false) {
  if (!(GAME && fs.existsSync(GAME))) throw new Error('no Commando Arcade cartridge (commando-arcade-crt)');
  return captureScene(browser, { base: BASE, theme, mode, dpr: overview ? 2 : 1, game: GAME, account });
}

// Dark and light side by side, drawn on a canvas in the browser.
async function sideBySide(dark, light) {
  const page = await browser.newPage();
  const data = await page.evaluate(async ([a, b]) => {
    const load = (src) => new Promise((resolve) => { const img = new Image(); img.onload = () => resolve(img); img.src = src; });
    const [left, right] = await Promise.all([load(a), load(b)]);
    const gap = 24;
    const canvas = document.createElement('canvas');
    canvas.width = left.width + gap + right.width;
    canvas.height = Math.max(left.height, right.height);
    const g = canvas.getContext('2d');
    g.fillStyle = '#808080';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(left, 0, 0);
    g.drawImage(right, left.width + gap, 0);
    return canvas.toDataURL('image/png');
  }, [`data:image/png;base64,${dark.toString('base64')}`, `data:image/png;base64,${light.toString('base64')}`]);
  await page.close();
  return Buffer.from(data.split(',')[1], 'base64');
}

console.log(`\nTheme gallery → ${OUT}\n  base=${BASE}`);
for (const theme of THEMES) {
  if (!OVERVIEW_ONLY) try {
    const info = saveGuideShot(await sideBySide(await capture(theme, 'dark'), await capture(theme, 'light')), OUT, `theme-${theme}`);
    console.log('  ✓', shotLabel(`theme-${theme}`, info));
  } catch (e) {
    console.error('  ✗', `theme-${theme}`, '—', e.message.split('\n')[0]);
  }
  try {
    const info = saveGuideShot(await capture(theme, 'dark', true), OUT, `overview-${theme}`);
    console.log('  ✓', shotLabel(`overview-${theme}`, info));
  } catch (e) {
    console.error('  ✗', `overview-${theme}`, '—', e.message.split('\n')[0]);
  }
}
await deleteAccounts(BASE, tokens);
await browser.close();
