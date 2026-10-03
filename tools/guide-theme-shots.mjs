// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Capture the User Guide's theme gallery: for every built-in theme, the main
// screen in dark mode and in light mode, side by side in one image.
//
//   node tools/guide-theme-shots.mjs [baseURL] [themeId ...]
//
// baseURL defaults to http://localhost:5173 (the live dev server). Naming theme
// ids shoots only those. The machine is powered on at READY. with the raster
// demo's disk in drive 8 (autorun off), so the directory colours show; the disk comes from
// the asset registry (raster-time-demo) and is skipped when missing.
// Output: public/guide/theme-<id>.webp (GUIDE_OUT redirects it). It also shoots
// overview-<id>.webp for every theme but Classic: the guide's opening overview
// in that theme's dark mode, taken the way guide-shots.mjs takes overview.webp
// (Classic's slide), so the opening gallery's slides match.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assetPath } from '../test/external-assets.js';
import { saveGuideShot, shotLabel } from './guide-image.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.GUIDE_OUT ? path.resolve(process.env.GUIDE_OUT) : path.join(root, 'public', 'guide');
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.argv[2] || 'http://localhost:5173';
const ONLY = process.argv.slice(3);
const DISK = assetPath('raster-time-demo') || '';
const THEMES = ['classic', 'geos', 'breadbin', 'phosphor', 'outrun', 'commando'].filter((t) => !ONLY.length || ONLY.includes(t));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const romCache = {};
for (const [slot, asset] of Object.entries({ kernal: 'kernal', basic: 'basic', charRom: 'chargen', drive1541: 'drive1541' })) {
  const file = assetPath(asset);
  if (file) romCache['c64emu.rom.' + slot] = fs.readFileSync(file).toString('base64');
}

const browser = await chromium.launch();

// One mode of one theme: a fresh context, so nothing carries over between shots.
// `overview` is the guide-shots overview: retina, a clean READY. with no disk,
// running, cropped 24px below the panels.
async function capture(theme, mode, overview = false) {
  const ctx = await browser.newContext({ colorScheme: mode, viewport: { width: 1460, height: 1180 }, deviceScaleFactor: overview ? 2 : 1, reducedMotion: 'reduce' });
  await ctx.addInitScript(({ cache, theme, mode }) => {
    try {
      localStorage.setItem('c64emu.installDismissed', '1');
      localStorage.setItem('c64emu.splashSeen', '1');
      localStorage.setItem('c64emu.appearance', mode);
      localStorage.setItem('c64emu.autorun', 'off');   // a disk goes in without loading
      if (theme !== 'classic') localStorage.setItem('c64emu.theme', theme);
      for (const [key, value] of Object.entries(cache)) localStorage.setItem(key, value);
    } catch {}
  }, { cache: romCache, theme, mode });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?CRT_SHADER_SOFTWARE=1`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#btn-power:not([disabled])', { timeout: 20000 });
  await page.locator('#btn-power').click();
  await sleep(4200);                                   // blue screen settles to READY.
  if (overview) {
    const bottom = await page.evaluate(() => Math.ceil(document.querySelector('.main-wrap').getBoundingClientRect().bottom));
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1460, height: Math.min(1180, bottom + 24) } });
    await ctx.close();
    return png;
  }
  if (DISK && fs.existsSync(DISK)) {
    // With autorun off, inserting it types nothing: the screen stays at READY.
    await page.locator('#d64-input').setInputFiles(DISK);
    const ask = page.locator('#confirm-modal:not([hidden])');
    if (await ask.waitFor({ timeout: 2000 }).then(() => true, () => false)) await page.locator('#btn-confirm-cancel').click();
    await sleep(1200);
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => document.getElementById('btn-pause')?.click());
  await sleep(500);
  // The interface down to the bottom of the tallest column.
  const bottom = await page.evaluate(() => Math.ceil(document.querySelector('.main-wrap').getBoundingClientRect().bottom) + 16);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1460, height: Math.min(1180, bottom) } });
  await ctx.close();
  return png;
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
  try {
    const info = saveGuideShot(await sideBySide(await capture(theme, 'dark'), await capture(theme, 'light')), OUT, `theme-${theme}`);
    console.log('  ✓', shotLabel(`theme-${theme}`, info));
  } catch (e) {
    console.error('  ✗', `theme-${theme}`, '—', e.message.split('\n')[0]);
  }
  if (theme === 'classic') continue;
  try {
    const info = saveGuideShot(await capture(theme, 'dark', true), OUT, `overview-${theme}`);
    console.log('  ✓', shotLabel(`overview-${theme}`, info));
  } catch (e) {
    console.error('  ✗', `overview-${theme}`, '—', e.message.split('\n')[0]);
  }
}
await browser.close();
