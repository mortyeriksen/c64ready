// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Capture UI screenshots for the User Guide (docs/USER-GUIDE.md).
//
// Drives the LIVE dev server (http://localhost:5173) in headless Chromium via
// Playwright, boots the machine (ROMs auto-load from /roms/), then screenshots
// every feature-group panel and every modal. Shots land in public/guide/ (a
// tracked static dir served at /guide/, referenced from the compiled doc page)
// as 1920-capped WebP via guide-image.mjs; re-runs overwrite the names in place.
//
//   node tools/guide-shots.mjs [baseURL] [dirArtD64] [rasterDemoD64]
//
// baseURL defaults to http://localhost:5173. Both disks are optional, supplied
// as arguments, and NOT part of the repo — bring your own:
//   dirArtD64      a PETSCII directory-art .d64 for the drive-8 / directory-zoom
//                  shots (drive8-loaded, directory-zoom). Defaults to the
//                  raster demo below, whose directory carries the art.
//   rasterDemoD64  a raster demo .d64 for the "in action" overview-running shot.
// Omit either and its shots are skipped; the rest still run.
//
// GUIDE_ONLY=drive8-empty,drive9 (env, comma-separated) regenerates only the
// named shots and skips the slow retro-vibes / overview-running passes — a
// targeted refresh that won't rewrite every tracked shot.
//
// The script captures 20 UI shots: overview, overview-running, the main feature
// cards, the modals, directory zoom, and Retro Vibes. It pre-seeds localStorage
// for reproducibility, including hiding the PWA card and forcing the lighter
// VIBES model for software WebGL.
//
// FULL REGENERATION of public/guide/ — start your Vite first, then, in order:
//   node tools/guide-shots.mjs                     20 shots (above)
//   node tools/guide-extra-shots.mjs               5 shots needing their own setup
//   node tools/guide-setup-shot.mjs                setup-dialog (fresh, ROM-less ctx)
//   node tools/guide-dialog-shots.mjs [baseURL] <demoDir> <statesDir>
//                                                  the populated Library + Save-States
//   node tools/vibes-guide-shots.mjs <baseURL> <paneDir>    3 panes per 3D scene
//   node tools/vibes-strip.mjs <paneDir> public/guide       stitched into 5 strips
// Both vibes tools take trailing scene slugs to shoot/stitch just those scenes.
//   node tools/datasette-anim.mjs                  the Datasette loading animation
// Bring your own inputs: a raster-demo .d64 and a game .tap (both registry), plus
// a dir of .d64s and a dir of .c64state files for the dialogs. Every tool
// takes GUIDE_OUT to write elsewhere, which also suppresses the screens/ mirror,
// so a trial run leaves public/ untouched. tools/pick-frames.mjs dumps a
// per-second burst of a demo when a specific overview-running frame is wanted.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assetPath } from '../test/external-assets.js';
import { saveGuideShot, shotLabel } from './guide-image.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Output dir — defaults to the tracked public/guide/; set GUIDE_OUT to redirect
// (e.g. a scratch dir for a test run).
const OUT = process.env.GUIDE_OUT ? path.resolve(process.env.GUIDE_OUT) : path.join(root, 'public', 'guide');
fs.mkdirSync(OUT, { recursive: true });

const BASE = process.argv[2] || 'http://localhost:5173';
// Disk shown in the drive-8 / directory-zoom shots: a PETSCII directory-art
// disk. Argument first, else the registry — the raster demo's own directory is
// the art these shots use, so one entry serves both.
const DISK = process.argv[3] || assetPath('raster-time-demo') || '';
const hasDisk = DISK !== '' && fs.existsSync(DISK);
// Disk for the "in action" running shot — a raster demo. Supplied as an
// argument, else resolved from test/external-assets.json ('raster-time-demo',
// or the C64_RASTER_TIME_D64 env var); omit both to skip that shot.
const RASTER = process.argv[4] || assetPath('raster-time-demo') || '';
// Set GUIDE_ONLY=drive8-empty,drive9 (comma-separated) to regenerate only some
// shots; empty = all. A targeted re-run refreshes a few cards without rewriting
// every tracked shot or paying for the slow retro-vibes / overview-running passes.
const ONLY = (process.env.GUIDE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (name) => ONLY.length === 0 || ONLY.includes(name);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = [];
const skipped = [];

const browser = await chromium.launch();               // headless by default
const ctx = await browser.newContext({
  viewport: { width: 1460, height: 1180 },
  deviceScaleFactor: 2,                                 // crisp retina PNGs
  reducedMotion: 'reduce',                              // freeze CRT roll / animations
});
// Pre-seed localStorage before the app runs: hide the PWA install card (it
// otherwise pops in at the top of the side panel after ~2.5s), force the
// lighter VIBES model (the AUTO/desktop 4K GLB is slow to load + render in
// software WebGL), and open Retro Vibes on the 80s Bedroom, which is the scene
// the guide's lead image shows. Seeding the remembered index rather than
// clicking 🎬 keeps the default camera, so the framing matches every other
// scene's hero pane.
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('c64emu.installDismissed', '1');
    localStorage.setItem('c64emu.splashSeen', '1');
    localStorage.setItem('c64emu.vibesModel', 'small');
    localStorage.setItem('c64emu.modelViewerScene', '4');
  } catch {}
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('  page error:', e.message));

async function shot(sel, name) {
  if (!want(name)) return;
  try {
    const el = page.locator(sel).first();
    await el.waitFor({ state: 'visible', timeout: 8000 });
    const info = saveGuideShot(await el.screenshot(), OUT, name);
    done.push(name);
    console.log('  ✓', shotLabel(name, info));
  } catch (e) {
    skipped.push(name);
    console.error('  ✗', name, '—', e.message.split('\n')[0]);
  }
}
// `timeout` buys extra time for the one heavy shot: the 80s Bedroom (two 2048²
// shadow maps + bloom) renders a frame slowly enough under software WebGL at
// this viewport that the 30s default expires mid-capture.
async function shotPage(name, fullPage = false, timeout = 0) {
  if (!want(name)) return;
  try {
    const info = saveGuideShot(await page.screenshot({ fullPage, ...(timeout ? { timeout } : {}) }), OUT, name);
    done.push(name);
    console.log('  ✓', shotLabel(name, info));
  } catch (e) {
    skipped.push(name);
    console.error('  ✗', name, '—', e.message.split('\n')[0]);
  }
}
// Full-window shot cropped to the actual content height — the side panel is
// shorter than the window, so a plain full-page grab leaves ~30% dead space
// below the panels. Clip to the bottom of `.main-wrap` (+ a small margin).
async function shotCropped(name) {
  if (!want(name)) return;
  try {
    const bottom = await page.evaluate(() => {
      const mw = document.querySelector('.main-wrap');
      return mw ? Math.ceil(mw.getBoundingClientRect().bottom) : 0;
    });
    const height = Math.min(1180, (bottom || 1180) + 24);
    const shot = await page.screenshot({ clip: { x: 0, y: 0, width: 1460, height } });
    const info = saveGuideShot(shot, OUT, name);
    done.push(name);
    console.log('  ✓', shotLabel(name, info), `(crop ${height}px)`);
  } catch (e) {
    skipped.push(name);
    console.error('  ✗', name, '—', e.message.split('\n')[0]);
  }
}
const click = (sel) => page.locator(sel).first().click({ timeout: 5000 });
async function closeModal(sel) {
  try { await page.keyboard.press('Escape'); await sleep(150); } catch {}
  try { if (await page.locator(sel).first().isVisible()) await click(sel); } catch {}
  await sleep(200);
}

console.log(`\nGuide screenshots → ${OUT}\n  base=${BASE}  disk=${hasDisk ? DISK : '(none)'}`);

await page.goto(BASE, { waitUntil: 'networkidle' });

// ROMs auto-load from /roms/ → POWER enables. Dismiss the Setup dialog if
// it popped (only happens when no ROMs are found on the server).
await page.waitForSelector('#btn-power:not([disabled])', { timeout: 20000 });
try {
  if (await page.locator('#setup-modal:not([hidden])').isVisible())
    await click('#btn-setup-later');
} catch {}
await sleep(300);

// ── Boot ────────────────────────────────────────────────────────────────
console.log('\n[boot]');
await click('#btn-power');
await page.waitForSelector('body.powered-on', { timeout: 8000 }).catch(() => {});
await sleep(4200);                                     // blue screen settles to READY.

// ── Full-interface overview (clean READY. screen) ───────────────────────
console.log('\n[overview + panels]');
await shotCropped('overview');
await shot('header', 'header');
await shot('.panel-card:has(#status)', 'status');
await shot('#controls-card', 'controls');
await shot('#media-load-card', 'media-load');
await shot('#controlports-card', 'control-ports');

// The Cartridge card starts collapsed — expand it to reveal its controls. The
// Datasette card has no still of its own: the guide shows it mid-load, which is
// the animation from datasette-anim.mjs.
try { await click('#cartridge-card .expand-btn'); await sleep(300); } catch {}
await shot('#cartridge-card', 'cartridge');

await shot('#diskdrive-card', 'drive8-empty');

// Drive 9: power it on so the deck (LOAD / EJECT / TDE) shows. The real
// checkbox is hidden behind a custom switch and isn't click-actionable, so
// toggle it directly; turning it on raises a "Demos might not work" confirm
// (OK = "Turn on") which must be accepted or it blocks every later click.
try {
  await page.locator('#drive9-power')
    .evaluate((el) => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForSelector('#confirm-modal:not([hidden])', { timeout: 3000 }).catch(() => {});
  if (await page.locator('#confirm-modal:not([hidden])').isVisible().catch(() => false)) {
    await click('#btn-confirm-ok');
    await sleep(500);
  }
  if (!(await page.locator('#drive9-deck').isVisible().catch(() => false)))
    await click('#diskdrive9-card .expand-btn').catch(() => {});
  await sleep(400);
} catch (e) { console.error('  drive9:', e.message.split('\n')[0]); }
await shot('#diskdrive9-card', 'drive9');

// RAM Expansion: fit a unit, pick the 16 MB model, and load an image, so the
// card shows an expansion in use rather than an empty slot. The power switch is
// a custom control like drive 9's, so drive the checkbox directly. Turning it
// on raises the IO2-cartridge-conflict confirm, which must be accepted or it
// blocks every later click. The file is a stand-in: the card reports the unit
// and the image name, neither of which depends on the contents, and a real
// 16 MB image would make this shot depend on an asset nobody needs for it.
try {
  await page.locator('#reu-power')
    .evaluate((el) => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForSelector('#confirm-modal:not([hidden])', { timeout: 3000 }).catch(() => {});
  if (await page.locator('#confirm-modal:not([hidden])').isVisible().catch(() => false)) {
    await click('#btn-confirm-ok');
    await sleep(400);
  }
  await sleep(300);
  await page.locator('#reu-unit')
    .evaluate((el) => { el.value = '16mb'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await sleep(300);
  await page.locator('#reu-input').setInputFiles({
    name: 'blu.reu', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1024),
  });
  await sleep(400);
} catch (e) { console.error('  ram-expansion:', e.message.split('\n')[0]); }
await shot('#reu-card', 'ram-expansion');
// Put it back to nothing-fitted so the later whole-interface shots show the
// default machine.
try {
  await page.locator('#reu-power')
    .evaluate((el) => { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await sleep(300);
} catch {}

// If only the shots up to here were requested, stop now — skip the modals,
// the slow Retro Vibes / overview-running passes, and the disk load entirely.
const restShots = ['options', 'keymap', 'library', 'save-states', 'key-joystick', 'retro-vibes', 'drive8-loaded', 'directory-zoom', 'overview-running'];
if (ONLY.length && !restShots.some(want)) {
  await browser.close();
  console.log(`\nDone. ${done.length} shots → ${OUT}`);
  if (skipped.length) console.log('Skipped:', skipped.join(', '));
  process.exit(0);
}

// ── Modals ──────────────────────────────────────────────────────────────
console.log('\n[modals]');
// Options (Display / Video / Sound / Media / ROM Files)
await click('#btn-settings');
await page.waitForSelector('#settings-modal:not([hidden])', { timeout: 5000 });
await sleep(300);
await shot('#settings-modal .modal-card', 'options');
await closeModal('#btn-settings-close');
// The Setup C64 READY. dialog only auto-opens on first run (no ROMs), which the
// running-app shots can't reproduce — capture setup-dialog.png separately with a
// fresh context that blocks /roms/ so autoLoad finds none.

// Key Map
await click('#btn-keymap');
await page.waitForSelector('#keymap-modal:not([hidden])', { timeout: 5000 });
await sleep(300);
await shot('#keymap-modal .modal-card', 'keymap');
await closeModal('#btn-keymap-close');

// Library
await click('#btn-library');
await page.waitForSelector('#library-modal:not([hidden])', { timeout: 5000 });
await sleep(300);
await shot('#library-modal .modal-card', 'library');
await closeModal('#btn-library-close');

// Save States
await click('#btn-load-state');
await page.waitForSelector('#state-modal:not([hidden])', { timeout: 5000 });
await sleep(300);
await shot('#state-modal .modal-card', 'save-states');
await closeModal('#btn-state-close');

// Key Joystick redefine dialog (set a port to Key Joystick, click the readout)
try {
  await page.selectOption('#cp-device-p2', 'keyboardJoystick1');
  await sleep(400);
  await click('#cp-detail-p2 .cp-joy-edit-link');
  await page.waitForSelector('#joykeys-modal:not([hidden])', { timeout: 5000 });
  await sleep(300);
  await shot('#joykeys-modal .modal-card', 'key-joystick');
  await closeModal('#btn-joykeys-close');
  await page.selectOption('#cp-device-p2', 'none');
} catch (e) {
  skipped.push('key-joystick');
  console.error('  ✗ key-joystick —', e.message.split('\n')[0]);
}

// ── Retro Vibes 3D overlay ──────────────────────────────────────────────
console.log('\n[retro vibes]');
if (want('retro-vibes')) try {
  await click('#btn-vibes');
  // Wait until the loader overlay is hidden (_setLoading(null) → display:none).
  await page.waitForFunction(() => {
    const l = document.querySelector('.model-viewer-loading');
    return !l || getComputedStyle(l).display === 'none';
  }, { timeout: 60000 });
  await sleep(6000);                                   // let it build + render a frame
  await shotPage('retro-vibes', false, 180000);
  await page.keyboard.press('Escape');
  await sleep(600);
} catch (e) {
  skipped.push('retro-vibes');
  console.error('  ✗ retro-vibes —', e.message.split('\n')[0]);
}

// ── Disk loaded (drive 8 populated + directory zoom) ────────────────────
// Needs the directory-art .d64 supplied as argv[3] (not shipped in the repo).
// Skipped cleanly if absent.
if (hasDisk && (want('drive8-loaded') || want('directory-zoom'))) {
  console.log('\n[disk]');
  try {
    await page.setInputFiles('#d64-input', DISK);
    await page.waitForSelector('#drive-loaded:not([hidden])', { timeout: 6000 });
    await sleep(600);
    // Expand the directory listing only when it is collapsed. An unconditional
    // click closed an already-open one, which is how the shot ended up collapsed.
    // '\u25b6' = collapsed, '\u25bc' = expanded (see _wireDirToggle in media.js).
    try {
      const arrow = (await page.locator('#drive-dir-toggle').textContent()).trim();
      if (arrow.startsWith('\u25b6')) { await click('#drive-dir-toggle'); await sleep(400); }
    } catch {}
    await shot('#diskdrive-card', 'drive8-loaded');
    // Directory zoom viewer
    await click('#drive-dir-zoom');
    await page.waitForSelector('#dirzoom-modal:not([hidden])', { timeout: 5000 });
    await sleep(500);
    await shot('#dirzoom-modal .modal-card', 'directory-zoom');
    await closeModal('#btn-dirzoom-close');
  } catch (e) {
    console.error('  ✗ disk —', e.message.split('\n')[0]);
  }
} else {
  console.log('\n[disk] skipped —', DISK ? `no d64 at ${DISK}` : 'no directory-art d64 (argv[3] or the asset registry)');
}

// ── "In action" overview ────────────────────────────────────────────────
// A colourful running frame ~58 s into the raster demo (the "PROJECT" logo over
// the woven raster bars). The demo animates every frame, so a re-run lands on an
// equivalent frame rather than the identical one; tools/pick-frames.mjs dumps a
// per-second burst to choose from when a particular frame is wanted.
// Runs last: eject + reset so the earlier disk's load doesn't bleed
// in; restore the default collapsed panel layout; TDE OFF so LOAD"*",8,1 is
// instant (a true-drive load would blow past the mark before the demo even
// starts).
console.log('\n[in action]');
if (want('overview-running') && fs.existsSync(RASTER)) {
  try {
    try { await click('#btn-d64-eject'); await sleep(400); } catch {}
    await click('#btn-reset');
    await sleep(2800);                                 // cold boot back to READY.
    // Collapse cartridge/datasette + power drive 9 back off (all opened earlier
    // for their own shots) so the layout matches the picked frame.
    try {
      if (await page.locator('#drive9-deck').isVisible().catch(() => false))
        await page.locator('#drive9-power').evaluate((el) => { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); });
      for (const id of ['#cartridge-card', '#datasette-card'])
        if (await page.locator(`${id}.expanded`).count()) { await click(`${id} .expand-btn`); await sleep(150); }
      await sleep(300);
    } catch {}
    const tde = page.locator('#btn-tde-toggle');
    if (/ON/.test(await tde.textContent().catch(() => '')))
      { await tde.click().catch(() => {}); await sleep(300); }
    await page.setInputFiles('#d64-input', RASTER);
    await sleep(2500);                                 // autoload + RUN hand off to the demo
    await sleep(58000);                                // ~58 s in — "PROJECT" logo over the raster bars
    await shotCropped('overview-running');
  } catch (e) {
    skipped.push('overview-running');
    console.error('  ✗ overview-running —', e.message.split('\n')[0]);
  }
} else {
  // Two different reasons land here; saying which saves a false "missing asset".
  console.log('  skipped —', !want('overview-running') ? 'not in GUIDE_ONLY'
    : RASTER ? `no raster demo d64 at ${RASTER}` : 'no raster demo d64 (pass argv[4])');
}

await browser.close();
console.log(`\nDone. ${done.length} shots → ${OUT}`);
if (skipped.length) console.log('Skipped:', skipped.join(', '));
