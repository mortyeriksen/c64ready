// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Capture 3 guide screenshots (hero / wide / low) for every Retro Vibes scene,
// with the C64 powered on showing the BASIC READY screen on the modelled
// monitor. ROM requests (/roms/*.bin) are answered by this harness from the
// repo-root roms/ dir via route interception — nothing needs to be in dist.
// Usage: node tools/vibes-guide-shots.mjs <baseURL> <outDir> [slug...]
// Naming one or more scene slugs shoots only those. Worth having because a full
// run under software GL can stall on an animated scene and never reach the later
// ones, so re-shooting a single scene should not depend on the five before it.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { collectionDir } from '../test/external-assets.js';

const base = process.argv[2] || 'http://localhost:5173';
const out = (process.argv[3] || collectionDir('vibes-guide-work')).replace(/\/$/, '');
const SLUGS = ['synthwave', 'starry-plain', 'spotlight', 'ikplus', '80s-bedroom'];
const ROM_DIR = new URL('../roms/', import.meta.url).pathname;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
// Block the PWA service worker (its app-shell fallback would answer
// /roms/*.bin with index.html) and serve the ROMs straight from the
// repo-root roms/ dir — works against dev server and preview alike.
const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
// Pre-seed localStorage before the app runs: the splash screen covers the whole
// page (its teaser video swallows the POWER / VIBES clicks) and the PWA install
// card pushes the side panel around a couple of seconds in.
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('c64emu.splashSeen', '1');
    localStorage.setItem('c64emu.installDismissed', '1');
  } catch {}
});
await ctx.route('**/roms/*.bin', (route) => {
  const name = route.request().url().split('/').pop();
  try {
    route.fulfill({ status: 200, contentType: 'application/octet-stream', body: fs.readFileSync(ROM_DIR + name) });
  } catch { route.fulfill({ status: 404, body: '' }); }
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(base, { waitUntil: 'load' });
await page.waitForTimeout(1500);
// ROMs autoload from /roms/*.bin, so the setup modal should stay hidden; make sure.
await page.evaluate(() => { const m = document.getElementById('setup-modal'); if (m) m.hidden = true; });
// Power enables once the required ROMs finish loading — wait for that.
await page.waitForFunction(() => {
  const b = document.getElementById('btn-power');
  return b && !b.disabled;
}, null, { timeout: 30000 });
// Power on and let it boot to the BASIC READY screen.
await page.click('#btn-power');
await page.waitForTimeout(7000);
// Enter Retro Vibes.
await page.click('#btn-vibes');
await page.waitForFunction(() => window.modelViewer?.scene?.children.length > 0, null, { timeout: 60000 });
await page.waitForTimeout(9000);

// Remember the default (hero) camera so every scene starts identically.
await page.evaluate(() => {
  const mv = window.modelViewer;
  window.__P0 = mv.camera.position.toArray();
  window.__T0 = mv.controls.target.toArray();
});

const setCam = (mode) => page.evaluate((m) => {
  const mv = window.modelViewer;
  const R = mv._modelSphere.radius;
  const c = mv.controls, cam = mv.camera;
  c.target.fromArray(window.__T0); cam.position.fromArray(window.__P0);
  if (m === 'close') {
    // Close-up: just over half the default distance, slightly flattened,
    // panned 90 degrees clockwise (seen from above) around the machine.
    const d = cam.position.clone().sub(c.target); d.y *= 0.8;
    d.multiplyScalar(0.52);
    const rx = -d.z, rz = d.x; d.x = rx; d.z = rz;
    cam.position.copy(c.target).add(d);
  } else if (m === 'low') {
    const d = cam.position.clone().sub(c.target); d.y = 0; d.normalize();
    const ang = 0.45, dx = d.x * Math.cos(ang) - d.z * Math.sin(ang), dz = d.x * Math.sin(ang) + d.z * Math.cos(ang);
    cam.position.set(c.target.x + dx * R * 2.76, c.target.y + R * 0.42, c.target.z + dz * R * 2.76);   // low overview, ~40% closer
  }
  c.update();
}, mode);

// Scene indices stay tied to SLUGS order (that is what _applyScene takes), so a
// filter selects indices rather than reordering anything.
const want = process.argv.slice(4);
const PICK = want.length ? want.map((s) => {
  const i = SLUGS.indexOf(s);
  if (i < 0) { console.error(`unknown scene "${s}" — one of: ${SLUGS.join(', ')}`); process.exit(1); }
  return i;
}) : SLUGS.map((_, i) => i);

for (const n of PICK) {
  await page.evaluate((i) => window.modelViewer._applyScene(i), n);
  await page.waitForTimeout(3000);   // scene build + water/shadows settle
  for (const mode of ['hero', 'close', 'low']) {
    await setCam(mode);
    await page.waitForTimeout(900);
    // page.screenshot, not element.screenshot: the latter waits for the element to
    // be "stable", which on a heavy animated scene (IK+ renders twice per frame for
    // its reflector) never settles inside the timeout and the run dies there. The
    // overlay is position:fixed inset:0, so the viewport shot is the same image.
    await page.screenshot({ path: `${out}/${SLUGS[n]}-${mode}.png` });
    console.log('saved', `${out}/${SLUGS[n]}-${mode}.png`);
  }
}
await browser.close();
