// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Capture ROM setup and the theme picker for the Getting Started guide:
// setup-dialog.webp (Fetch), setup-vice.webp, setup-upload.webp and
// theme-picker.webp, all in Phosphor dark. The Fetch shot uses example URLs
// so deployment-local defaults do not appear in tracked guide assets.
//
// The Setup dialog only auto-opens on first run when NO ROMs are found (cache +
// server both empty), which the normal guide-shots.mjs run can't reproduce (it
// boots with ROMs auto-loaded from /roms/). This harness uses a fresh context
// with empty storage AND aborts every /roms/ request, so loader.autoLoad() finds
// nothing and main.js opens the dialog.
//
//   node tools/guide-setup-shot.mjs [baseURL] [--setup-only]
//
// baseURL defaults to http://localhost:5173 (the live dev server). Output lands
// in public/guide/ (tracked, served at /guide/); set GUIDE_OUT to redirect.
// --setup-only captures the three setup tabs without updating the theme picker.
import { chromium } from 'playwright';
import { createGuideContext } from './guide-context.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { saveGuideShot, shotLabel } from './guide-image.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.GUIDE_OUT ? path.resolve(process.env.GUIDE_OUT) : path.join(root, 'public', 'guide');
fs.mkdirSync(OUT, { recursive: true });

const BASE = process.argv.slice(2).find(arg => !arg.startsWith('--')) || 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();                 // headless by default
const ctx = await createGuideContext(browser, { colorScheme: 'dark',
  viewport: { width: 1460, height: 1180 },
  deviceScaleFactor: 2,                                   // crisp retina PNG, matches the other guide shots
  reducedMotion: 'reduce',
}, { roms: false });
// Hide the PWA install card so it can't intrude; storage is otherwise empty.
await ctx.addInitScript(() => { try { localStorage.setItem('c64emu.installDismissed', '1'); localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1'); } catch {} });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('  page error:', e.message));
// Defensive: even if /roms/ still holds files, block them so autoLoad finds none.
await page.route('**/roms/**', (r) => r.abort());
await page.route('**/rom-sources.json', route => route.fulfill({ json: {
  kernal: 'https://example.com/roms/kernal.bin',
  basic: 'https://example.com/roms/basic.bin',
  charRom: 'https://example.com/roms/chargen.bin',
  drive1541: 'https://example.com/roms/1541.bin',
} }));

console.log(`\nSetup-dialog shot → ${OUT}\n  base=${BASE}`);
await page.goto(BASE, { waitUntil: 'networkidle' });

// autoLoad scans (cache + server) first; with both empty it calls _openSetup().
await page.waitForSelector('#setup-modal:not([hidden])', { timeout: 20000 });
await page.waitForFunction(() => document.querySelector('#setup-url-kernal').value === 'https://example.com/roms/kernal.bin');
await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
await page.mouse.move(0, 0);                              // no hover highlight baked in
await sleep(500);

for (const [tab, name] of [['fetch', 'setup-dialog'], ['vice', 'setup-vice'], ['upload', 'setup-upload']]) {
  await page.click(`#setup-tab-${tab}`);
  await page.mouse.move(0, 0);
  await sleep(150);
  console.log('  ✓', shotLabel(name, saveGuideShot(
    await page.locator('#setup-modal .modal-card').first().screenshot(), OUT, name)));
}

if (!process.argv.includes('--setup-only')) {
const themeContext = await createGuideContext(browser, {
  colorScheme: 'dark', viewport: { width: 1460, height: 1180 },
  deviceScaleFactor: 2, reducedMotion: 'reduce',
});
await themeContext.addInitScript(() => {
  localStorage.setItem('c64emu.installDismissed', '1');
  localStorage.setItem('c64emu.splashSeen', '1');
});
const themePage = await themeContext.newPage();
const themeUrl = new URL(BASE); themeUrl.searchParams.set('THEME_PICKER', '1');
await themePage.goto(themeUrl.href, { waitUntil: 'networkidle' });
await themePage.locator('.theme-picker').waitFor();
await themePage.evaluate(() => document.fonts.ready);
await themePage.locator('.theme-picker').evaluate(card => card.focus());
await themePage.mouse.move(0, 0);
console.log('  ✓', shotLabel('theme-picker', saveGuideShot(
  await themePage.locator('.theme-picker').screenshot(), OUT, 'theme-picker')));
}

await browser.close();
console.log('\nDone.');
