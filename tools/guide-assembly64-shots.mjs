// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Capture the Assembly64 card and browser with the guide's Lft demo search.
// Usage: node tools/guide-assembly64-shots.mjs [baseURL]
// Requires the live catalog. GUIDE_OUT redirects public/guide output.
import { chromium } from 'playwright';
import path from 'node:path';
import { createGuideContext } from './guide-context.mjs';
import { saveGuideShot, shotLabel } from './guide-image.mjs';

const out = path.resolve(process.env.GUIDE_OUT || 'public/guide');
const browser = await chromium.launch();
try {
  const context = await createGuideContext(browser, { colorScheme: 'dark',
    viewport: { width: 1460, height: 1180 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    localStorage.setItem('c64emu.installDismissed', '1');
    localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1');
  });
  const page = await context.newPage();
  await page.goto(process.argv[2] || 'http://localhost:5173', { waitUntil: 'networkidle' });
  await page.getByPlaceholder('Group / producer…').fill('lft');
  await page.getByRole('button', { name: 'Quick search', exact: true }).click();
  await page.locator('.mb-quick-result').first().waitFor({ timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  console.log(shotLabel('assembly64-control', saveGuideShot(
    await page.locator('#media-browser-card').screenshot(), out, 'assembly64-control')));
  await page.getByRole('button', { name: 'REFINE SEARCH', exact: true }).click();
  await page.locator('.mb-result').first().waitFor({ timeout: 60000 });
  await page.locator('.mb-browser input').first().blur();
  await page.mouse.move(0, 0);
  console.log(shotLabel('assembly64-browser', saveGuideShot(
    await page.locator('.mb-browser').screenshot(), out, 'assembly64-browser')));
} finally {
  await browser.close();
}
