// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Capture the "Setup C64 READY." first-run dialog for the User / Getting-Started
// guides (setup-dialog.webp).
//
// The Setup dialog only auto-opens on first run when NO ROMs are found (cache +
// server both empty), which the normal guide-shots.mjs run can't reproduce (it
// boots with ROMs auto-loaded from /roms/). This harness uses a fresh context
// with empty storage AND aborts every /roms/ request, so loader.autoLoad() finds
// nothing and main.js opens the dialog.
//
//   node tools/guide-setup-shot.mjs [baseURL]
//
// baseURL defaults to http://localhost:5173 (the live dev server). Output lands
// in public/guide/ (tracked, served at /guide/); set GUIDE_OUT to redirect.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { saveGuideShot, shotLabel } from './guide-image.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.GUIDE_OUT ? path.resolve(process.env.GUIDE_OUT) : path.join(root, 'public', 'guide');
fs.mkdirSync(OUT, { recursive: true });

const BASE = process.argv[2] || 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();                 // headless by default
const ctx = await browser.newContext({
  viewport: { width: 1460, height: 1180 },
  deviceScaleFactor: 2,                                   // crisp retina PNG, matches the other guide shots
  reducedMotion: 'reduce',
});
// Hide the PWA install card so it can't intrude; storage is otherwise empty.
await ctx.addInitScript(() => { try { localStorage.setItem('c64emu.installDismissed', '1'); localStorage.setItem('c64emu.splashSeen', '1'); } catch {} });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('  page error:', e.message));
// Defensive: even if /roms/ still holds files, block them so autoLoad finds none.
await page.route('**/roms/**', (r) => r.abort());

console.log(`\nSetup-dialog shot → ${OUT}\n  base=${BASE}`);
await page.goto(BASE, { waitUntil: 'networkidle' });

// autoLoad scans (cache + server) first; with both empty it calls _openSetup().
await page.waitForSelector('#setup-modal:not([hidden])', { timeout: 20000 });
await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
await page.mouse.move(0, 0);                              // no hover highlight baked in
await sleep(500);

console.log('  ✓', shotLabel('setup-dialog', saveGuideShot(
  await page.locator('#setup-modal .modal-card').first().screenshot(),
  OUT, 'setup-dialog')));

await browser.close();
console.log('\nDone.');
