// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Capture Live Monitor guide images using the external Nine demo.
// Usage: node tools/guide-monitor-shots.mjs [baseURL]
// Requires a running dev server (default http://localhost:5173), external ROMs,
// monitor-nine in test/external-assets.json and cwebp. Missing assets are SKIPs.
// GUIDE_OUT overrides public/guide. Runs as part of npm run guide:shots.
import fs from 'node:fs';
import path from 'node:path';
import { readAsset } from '../test/external-assets.js';
import { createGuideContext } from './guide-context.mjs';
import { launchShotBrowser } from './shot-browser.mjs';
import { saveGuideShot, shotLabel } from './guide-image.mjs';

const base = process.argv[2] || 'http://localhost:5173';
const out = path.resolve(process.env.GUIDE_OUT || 'public/guide');
const required = ['kernal', 'basic', 'chargen', 'monitor-nine'];
for (const name of required) {
  if (!readAsset(name)) {
    console.log(`# SKIP Monitor guide screenshots: external asset '${name}' unavailable`);
    process.exit(0);
  }
}
fs.mkdirSync(out, { recursive: true });
const browser = await launchShotBrowser();
try {
  const context = await createGuideContext(browser, {
    viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2,
    colorScheme: 'dark', reducedMotion: 'reduce',
  });
  await context.addInitScript(() => {
    for (const key of ['splashSeen', 'installDismissed']) localStorage.setItem(`c64emu.${key}`, '1');
  });
  const page = await context.newPage();
  await page.goto(base);
  await page.click('#btn-power');
  await page.waitForFunction(() => !document.querySelector('#btn-monitor').disabled);
  await page.waitForFunction(async () => {
    const { c64 } = await import('/src/state.js');
    if (!c64?.ready) return false;
    const screen = c64.copyCpuMemory(0x0400, new Uint8Array(1000));
    const ready = [18, 5, 1, 4, 25, 46];
    return screen.some((_, i) => ready.every((value, j) => screen[i + j] === value));
  }, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(async bytes => {
    const { c64 } = await import('/src/state.js');
    c64.loadPRG(new Uint8Array(bytes));
    c64.injectRun();
  }, [...readAsset('monitor-nine')]);
  console.log('Waiting for Nine to reach its visual effects…');
  await page.waitForTimeout(60000);
  await page.click('#btn-monitor');
  const shot = async name => {
    await page.waitForTimeout(300);
    console.log(shotLabel(name, saveGuideShot(await page.screenshot(), out, name)));
  };
  await page.waitForTimeout(1200);
  await shot('monitor-live');
  await page.click('[data-view="code"]');
  await page.waitForFunction(() => document.querySelector('.monitor-code-story').dataset.captureLabel?.startsWith('Captured frame'));
  await shot('monitor-code');
  await page.click('[data-view="frame"]');
  await page.waitForFunction(() => !document.querySelector('[data-frame="play"]').disabled);
  await page.locator('[data-video="topic"]').selectOption('sprite');
  await shot('monitor-video');
  await page.click('[data-view="sid"]');
  await shot('monitor-sound');
} finally {
  await browser.close();
}
