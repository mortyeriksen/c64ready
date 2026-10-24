// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Capture portrait and landscape mobile UI inside a neutral phone frame.
// Usage: node tools/guide-mobile-shots.mjs [baseURL]
// Shared guide settings select Phosphor dark. GUIDE_OUT redirects the output.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchShotBrowser } from './shot-browser.mjs';
import { createGuideContext } from './guide-context.mjs';
import { saveGuideShot, shotLabel } from './guide-image.mjs';
import { assetPath, missingNote } from '../test/external-assets.js';

const base = process.argv[2] || 'http://localhost:5173';
const out = path.resolve(process.env.GUIDE_OUT || 'public/guide');
fs.mkdirSync(out, { recursive: true });
const browser = await launchShotBrowser();
async function phone(png, width, height, landscape) {
  const page = await browser.newPage({ viewport: { width: width + 144, height: height + 192 }, deviceScaleFactor: 2 });
  try {
    await page.setContent(`<style>
      * { box-sizing: border-box; } body { margin: 0; padding: 56px; width: max-content; }
      .device { padding: 12px; border: 2px solid #787b82; border-radius: 56px;
        background: linear-gradient(135deg,#45484f,#17191e 22%,#3a3d43 78%,#151619);
        box-shadow: 0 18px 28px #0006, inset 0 0 0 2px #111; position: relative; }
      .screen { border: 2px solid #050506; border-radius: 42px; overflow: hidden; background: #0b0b0c; }
      img { display: block; width: ${width}px; height: ${height}px; }
      .status { display: flex; justify-content: space-between; align-items: center; height: 28px;
        padding: 0 28px; color: #eee; font: 600 12px system-ui; }
      .status svg { width: 58px; height: 14px; }
      .home { height: 20px; display: grid; place-items: center; }
      .home::after { content: ''; height: 4px; width: 126px; border-radius: 4px; background: #ddd; }
      .speaker { position: absolute; width: 40px; height: 3px; border-radius: 5px; background: #070708;
        left: calc(50% - 20px); top: 5px; }
      .landscape .status { display: none; } .landscape .home { height: 10px; }
      .landscape .home::after { height: 3px; } .landscape .speaker { width: 3px; height: 40px; left: 5px; top: calc(50% - 20px); }
    </style><div class="device ${landscape ? 'landscape' : ''}"><span class="speaker"></span><div class="screen">
      <div class="status"><span>9:41</span><svg viewBox="0 0 58 14" fill="currentColor" aria-hidden="true">
      <path d="M0 10h3v4H0zm5-3h3v7H5zm5-3h3v10h-3zm5-4h3v14h-3z"/>
      <path d="M22 4q7-7 14 0l-2 2q-5-5-10 0zm3 3q4-4 8 0l-2 2q-2-2-4 0zm3 3h2v3h-2z"/>
      <rect x="40" y="2" width="15" height="10" rx="2" fill="none" stroke="currentColor"/>
      <path d="M42 4h11v6H42zm14 1h2v4h-2z"/></svg></div>
      <img src="data:image/png;base64,${png.toString('base64')}" alt="C64 READY. mobile screenshot"><div class="home"></div>
    </div></div>`);
    await page.locator('img').evaluate(img => img.decode());
    const size = await page.locator('.device').boundingBox();
    return await page.screenshot({ clip: { x: 0, y: 0, width: size.width + 112, height: size.height + 112 }, omitBackground: true });
  } finally { await page.close(); }
}
try {
  const context = await createGuideContext(browser, { colorScheme: 'dark',
    viewport: { width: 430, height: 874 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    localStorage.setItem('c64emu.installDismissed', '1');
    localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1');
  });
  const page = await context.newPage();
  await page.goto(`${base}/?CRT_SHADER_SOFTWARE=1`, { waitUntil: 'networkidle' });
  await page.click('#btn-power');
  await page.waitForTimeout(4200);
  await page.evaluate(() => document.fonts.ready);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'portrait UI fits the phone');
  console.log(shotLabel('mobile-portrait', saveGuideShot(await phone(await page.screenshot(), 430, 874, false), out, 'mobile-portrait')));
  const game = assetPath('commando');
  if (!game) console.log(`# SKIP mobile-landscape: ${missingNote('commando')}`);
  else {
    await page.setViewportSize({ width: 932, height: 430 });
    await page.setInputFiles('#prg-input', game);
    const offer = page.locator('#confirm-modal:not([hidden])');
    if (await offer.waitFor({ timeout: 3000 }).then(() => true, () => false)) await page.click('#btn-confirm-ok');
    await page.waitForTimeout(8000);
    await page.selectOption('#cp-device-p2', 'touchJoystick');
    await page.click('#btn-fullscreen');
    await page.locator('body.fullscreen-mode').waitFor();
    await page.locator('#touch-controls:not([hidden])').waitFor();
    await page.waitForTimeout(500);
    const view = page.viewportSize();
    console.log(shotLabel('mobile-landscape', saveGuideShot(await phone(await page.screenshot(), view.width, view.height, true), out, 'mobile-landscape')));
  }
} finally { await browser.close(); }
