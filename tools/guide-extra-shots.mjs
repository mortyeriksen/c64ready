// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Companion to guide-shots.mjs for User-Guide screenshots that need setup the
// main single-pass desktop harness can't reproduce or that share one disk:
//   update-toast.webp     the PWA "New version available" toast (only appears on a
//                        waiting SW — we inject its DOM and crop to it)
//   drive8-loaded.webp    disk drive 8 with a disk loaded + its directory expanded
//   directory-zoom.webp   the Directory zoom viewer over that SAME drive-8 disk
//   tape-scope.webp       the tape-signal scope with a tape actually running past
//                        the head (a stopped deck draws a flat line, so the shot
//                        has to be taken mid-load)
//   tape-listing.webp     the datasette's listing over a tape built in memory
//                        ("80s mixtape" — both formats, one file the tape lost
//                        part of, so the struck-through row is a real reading)
//   cartridge-freezer.webp a freezer cartridge (Action Replay) loaded so the card
//                        shows its RESET + FREEZE buttons; builds a minimal AR CRT
//                        header in memory (no cartridge ROM shipped or required)
//   touch-joystick.webp   the on-screen touch joystick over the display, in a
//                        LANDSCAPE phone viewport, fullscreen (needs touch/mobile
//                        emulation, which guide-shots' desktop pass isn't)
//   panel-hide.webp       a side-panel card held over the Hide square — a real
//                        pointer drag, held open for the shot
//   panel-restore.webp    the "Show hidden panels" picker the + button opens
//
// Drives the LIVE dev server (start your Vite first). Shots land in public/guide/
// as 1920-capped WebP (guide-image.mjs).
//   node tools/guide-extra-shots.mjs [baseURL] [drive8D64]
// drive8D64 defaults to the 'raster-time-demo' asset (test/external-assets.json).
// Set GUIDE_ONLY=update-toast (comma-separated) to regenerate only some shots.
import { chromium } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { assetPath } from '../test/external-assets.js';
import { saveGuideShot, shotLabel } from './guide-image.mjs';
import { buildMixtape } from './mixtape.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.GUIDE_OUT ? path.resolve(process.env.GUIDE_OUT) : path.join(root, 'public', 'guide');
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.argv[2] || 'http://localhost:5173';
const DISK8 = process.argv[3] || assetPath('raster-time-demo') || '';
const GAME = process.argv[4] || assetPath('commando') || '';   // title screen behind the touch joystick
const ONLY = (process.env.GUIDE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (name) => ONLY.length === 0 || ONLY.includes(name);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = [], skipped = [];

// A minimal Action Replay image (.crt hardware type 1 = freezer): a valid 64-byte
// header + four empty 8K CHIP banks. The cartridge card reveals its RESET + FREEZE
// buttons purely from the header's hardware type, so the banks are left zero — no
// copyrighted cartridge ROM is shipped or needed.
function buildFreezerCRT() {
  const wA = (b, o, s, pad = 0) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); for (let i = s.length; i < pad; i++) b[o + i] = 0; };
  const w16 = (b, o, v) => { b[o] = v >> 8; b[o + 1] = v; };
  const w32 = (b, o, v) => { b[o] = v >>> 24; b[o + 1] = v >>> 16; b[o + 2] = v >>> 8; b[o + 3] = v; };
  const buf = new Uint8Array(0x40 + 4 * (16 + 8192));
  wA(buf, 0, 'C64 CARTRIDGE   ');
  w32(buf, 0x10, 0x40);            // header length
  w16(buf, 0x14, 0x0100);          // format version
  w16(buf, 0x16, 1);               // hardware type 1 = Action Replay (freezer)
  wA(buf, 0x20, 'ACTION REPLAY VI', 32);
  let off = 0x40;
  for (let bank = 0; bank < 4; bank++) {
    wA(buf, off, 'CHIP');
    w32(buf, off + 4, 16 + 8192);  // packet length (header + 8K)
    w16(buf, off + 8, 0);          // chip type ROM
    w16(buf, off + 10, bank);      // bank number
    w16(buf, off + 12, 0x8000);    // load address
    w16(buf, off + 14, 8192);      // rom size
    off += 16 + 8192;
  }
  return buf;
}

async function bootPage(ctx) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('  page error:', e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#btn-power:not([disabled])', { timeout: 20000 });
  try {
    if (await page.locator('#setup-modal:not([hidden])').isVisible())
      await page.locator('#btn-setup-later').first().click();
  } catch {}
  await page.locator('#btn-power').first().click();
  await page.waitForSelector('body.powered-on', { timeout: 8000 }).catch(() => {});
  await sleep(4200);                                    // blue screen settles to READY.
  return page;
}

const browser = await chromium.launch();

// ── desktop: update toast + drive 8 (loaded, directory expanded) + dir zoom +
//    the datasette's tape listing ───────────────────────────────────────────────
if (want('update-toast') || want('drive8-loaded') || want('directory-zoom') || want('tape-listing')
    || want('tape-scope')) {
  const ctx = await browser.newContext({
    viewport: { width: 1460, height: 1180 }, deviceScaleFactor: 2, reducedMotion: 'reduce',
  });
  await ctx.addInitScript(() => { try { localStorage.setItem('c64emu.installDismissed', '1'); localStorage.setItem('c64emu.splashSeen', '1'); } catch {} });
  const page = await bootPage(ctx);

  if (want('update-toast')) {
    try {
      // Inject the exact DOM main.js builds (message + Reload + "Later…"), tagged
      // pwa-toast-update (the ~50% enlarge), and crop to just the toast.
      await page.evaluate(async () => {
        document.querySelectorAll('.pwa-toast').forEach((t) => t.remove());
        const el = document.createElement('div');
        el.className = 'pwa-toast pwa-toast-update';
        el.id = '__guide_toast';
        const span = document.createElement('span'); span.textContent = 'New version available.';
        const reload = document.createElement('button'); reload.className = 'pwa-toast-action'; reload.textContent = 'Reload';
        const later = document.createElement('button'); later.className = 'pwa-toast-later'; later.textContent = 'Later…';
        el.append(span, reload, later);
        document.body.appendChild(el);
        try { await document.fonts.load('1.2rem "Share Tech Mono"'); await document.fonts.ready; } catch {}
      });
      await sleep(300);
      saveGuideShot(await page.locator('#__guide_toast').screenshot(), OUT, 'update-toast');
      await page.evaluate(() => document.getElementById('__guide_toast')?.remove());
      done.push('update-toast'); console.log('  ✓ update-toast');
    } catch (e) { skipped.push('update-toast'); console.error('  ✗ update-toast —', e.message.split('\n')[0]); }
  }

  // Drive 8: load a disk + expand its directory (drive8-loaded), then open the
  // magnifier's Directory zoom viewer over the SAME disk (directory-zoom).
  if (want('drive8-loaded') || want('directory-zoom')) {
    try {
      if (!(DISK8 && fs.existsSync(DISK8))) throw new Error(`no drive-8 d64 (${DISK8 || 'unset'})`);
      await page.setInputFiles('#d64-input', DISK8);
      await page.waitForSelector('#drive-loaded:not([hidden])', { timeout: 6000 });
      await sleep(500);
      if (!(await page.locator('#d64-dir').isVisible().catch(() => false)))
        await page.locator('#drive-dir-toggle').first().click().catch(() => {});
      await sleep(400);
      if (want('drive8-loaded')) {
        const info = saveGuideShot(await page.locator('#diskdrive-card').screenshot(), OUT, 'drive8-loaded');
        done.push('drive8-loaded');
        console.log('  ✓', shotLabel('drive8-loaded', info), '(directory expanded)');
      }
      if (want('directory-zoom')) {
        await page.locator('#drive-dir-zoom').first().click();
        await page.waitForSelector('#dirzoom-modal:not([hidden])', { timeout: 5000 });
        await sleep(500);
        saveGuideShot(await page.locator('#dirzoom-modal .modal-card').screenshot(), OUT, 'directory-zoom');
        await page.keyboard.press('Escape').catch(() => {});
        done.push('directory-zoom'); console.log('  ✓ directory-zoom');
      }
    } catch (e) {
      if (want('drive8-loaded')) skipped.push('drive8-loaded');
      if (want('directory-zoom')) skipped.push('directory-zoom');
      console.error('  ✗ drive8 / directory-zoom —', e.message.split('\n')[0]);
    }
  }

  // The datasette's listing, over a tape written here rather than shipped: both
  // formats on one tape, and one file with a hole in it, so the struck-through
  // row in the guide is the real reader's own verdict.
  if (want('tape-listing')) {
    try {
      await page.setInputFiles('#tap-input', {
        name: '80s mixtape.tap', mimeType: 'application/octet-stream', buffer: Buffer.from(buildMixtape()),
      });
      await page.waitForSelector('#tape-dir-zoom:not([hidden])', { timeout: 8000 });
      await sleep(900);
      await page.locator('#tape-dir-zoom').first().click();
      await page.waitForSelector('#tapedir-modal:not([hidden])', { timeout: 5000 });
      await page.mouse.move(0, 0);            // no hover highlight in the shot
      await sleep(500);
      const rows = await page.locator('#tapedir-list .lib-row').count();
      const struck = await page.locator('#tapedir-list .lib-row.is-damaged').count();
      if (!rows) throw new Error('the tape listed nothing');
      const info = saveGuideShot(await page.locator('#tapedir-modal .modal-card').screenshot(), OUT, 'tape-listing');
      await page.keyboard.press('Escape').catch(() => {});
      done.push('tape-listing');
      console.log('  ✓', shotLabel('tape-listing', info), `(${rows} files, ${struck} damaged)`);
    } catch (e) {
      skipped.push('tape-listing');
      console.error('  ✗ tape-listing —', e.message.split('\n')[0]);
    }
  }
  // The tape scope, with a tape actually moving: the trace is the signal under
  // the head, and a stopped deck draws a flat line — so this one is taken during
  // a load, not from a parked tape.
  if (want('tape-scope')) {
    try {
      await page.setInputFiles('#tap-input', {
        name: '80s mixtape.tap', mimeType: 'application/octet-stream', buffer: Buffer.from(buildMixtape()),
      });
      await page.waitForSelector('#tape-dir-zoom:not([hidden])', { timeout: 8000 });
      await sleep(600);
      await page.locator('#btn-tape-scope').first().click();
      await page.waitForSelector('#tapescope-modal:not([hidden])', { timeout: 5000 });
      // AUTORUN types LOAD and presses PLAY for us. Wait for the head to reach
      // the file's data: a lead-in is one width repeated, and a scope showing a
      // single width says nothing about what the format looks like.
      await page.waitForFunction(() => {
        const state = document.getElementById('tapescope-state')?.textContent.trim();
        const m = /(\d+)[–-](\d+) cycles/.exec(document.getElementById('tapescope-detail')?.textContent || '');
        return state === 'playing' && m && Number(m[2]) - Number(m[1]) > 200;
      }, null, { timeout: 40000, polling: 100 });
      await page.mouse.move(0, 0);
      const info = saveGuideShot(await page.locator('#tapescope-modal .modal-card').screenshot(), OUT, 'tape-scope');
      const detail = await page.evaluate(() => document.getElementById('tapescope-detail')?.textContent || '');
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(200);
      done.push('tape-scope');
      console.log('  ✓', shotLabel('tape-scope', info), `(${detail})`);
    } catch (e) {
      skipped.push('tape-scope');
      console.error('  ✗ tape-scope —', e.message.split('\n')[0]);
    }
  }
  await ctx.close();
}

// ── freezer cartridge card (LOAD / EJECT / RESET / FREEZE, 2×2 rows) ──────────
// A freezer cart (Action Replay, hardware type 1) adds RESET + FREEZE to the
// cartridge card. Isolated context: applying a cart cold-boots the machine, so it
// must not share a page with the other shots.
if (want('cartridge-freezer')) {
  const ctx = await browser.newContext({
    viewport: { width: 1460, height: 1180 }, deviceScaleFactor: 2, reducedMotion: 'reduce',
  });
  await ctx.addInitScript(() => { try { localStorage.setItem('c64emu.installDismissed', '1'); localStorage.setItem('c64emu.splashSeen', '1'); } catch {} });
  const page = await bootPage(ctx);
  try {
    const tmp = path.join(os.tmpdir(), 'guide-freezer.crt');
    fs.writeFileSync(tmp, buildFreezerCRT());
    await page.setInputFiles('#crt-input', tmp);
    // RESET + FREEZE appear once a freezer cart is applied.
    await page.waitForSelector('#btn-crt-freeze:visible', { timeout: 6000 }).catch(() => {});
    // The cartridge card starts collapsed — expand it to reveal the controls.
    if (!(await page.locator('#cartridge-card.expanded').count()))
      await page.locator('#cartridge-card .expand-btn').first().click().catch(() => {});
    await sleep(400);
    saveGuideShot(await page.locator('#cartridge-card').screenshot(), OUT, 'cartridge-freezer');
    try { fs.unlinkSync(tmp); } catch {}
    done.push('cartridge-freezer'); console.log('  ✓ cartridge-freezer (RESET + FREEZE)');
  } catch (e) { skipped.push('cartridge-freezer'); console.error('  ✗ cartridge-freezer —', e.message.split('\n')[0]); }
  await ctx.close();
}

// ── arranging the side panel: drop-to-hide + the picker that brings one back ──
// Both states only exist mid-interaction, which is why they can't come from the
// single-pass harness: one needs a pointer held down, the other needs a card
// already hidden. Own context so the pre-hidden cards can't leak into any other
// shot's panel.
if (want('panel-hide') || want('panel-restore')) {
  const ctx = await browser.newContext({
    // Much shorter than the other desktop shots: the panel ends well above 1180
    // and the target sits in the corner of the VIEWPORT, so spare height lands
    // as a band of empty page between the two things the shot is about.
    viewport: { width: 1460, height: 780 }, deviceScaleFactor: 2, reducedMotion: 'reduce',
  });
  await ctx.addInitScript(() => { try { localStorage.setItem('c64emu.installDismissed', '1'); localStorage.setItem('c64emu.splashSeen', '1'); } catch {} });

  if (want('panel-hide')) {
    const page = await bootPage(ctx);
    try {
      // The Datasette card sits far enough down its column that the lifted ghost
      // and the corner target are both in frame.
      const grip = await page.locator('.panel-card[data-panel="datasette"] .panel-drag-handle')
        .first().boundingBox();
      const box = await page.locator('.panel-hide-target').boundingBox();  // laid out while invisible
      // Where the column ends: the drag is routed down past it before turning
      // into the corner, which is how a user reaches the target. Jumping
      // straight there instead freezes the opened slot mid-column, leaving a gap
      // that a real drag would already have closed up behind the card.
      const col = await page.locator('.panel-card[data-panel="datasette"]')
        .first().evaluate((el) => el.closest('.panel-col').getBoundingClientRect().bottom);
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      // Crossing the 4 px threshold lifts the ghost; down the column closes the
      // space behind it; then into the target, which lights up. Aim just inside
      // its top-left — the ghost keeps the card's full width, so the centre
      // would push most of it past the right edge of the frame.
      await page.mouse.move(grip.x + grip.width / 2 + 30, grip.y + 40, { steps: 6 });
      await page.mouse.move(grip.x + grip.width / 2, col - 8, { steps: 14 });
      await page.mouse.move(box.x + 16, box.y + 16, { steps: 12 });
      await sleep(350);
      saveGuideShot(await page.screenshot(), OUT, 'panel-hide');
      await page.mouse.up();
      done.push('panel-hide'); console.log('  ✓ panel-hide (card over the Hide square)');
    } catch (e) { skipped.push('panel-hide'); console.error('  ✗ panel-hide —', e.message.split('\n')[0]); }
    await page.close();
  }

  if (want('panel-restore')) {
    // Hide two cards first, then open the picker the way a user does — the +
    // only exists because something is hidden.
    await ctx.addInitScript(() => {
      try { localStorage.setItem('c64emu.panelHidden', '["datasette","cartridge"]'); } catch {}
    });
    const page = await bootPage(ctx);
    try {
      await page.locator('.panel-restore-btn').click();
      await sleep(300);
      saveGuideShot(await page.locator('.panel-restore-modal .modal-card').screenshot(), OUT, 'panel-restore');
      done.push('panel-restore'); console.log('  ✓ panel-restore (the + picker)');
    } catch (e) { skipped.push('panel-restore'); console.error('  ✗ panel-restore —', e.message.split('\n')[0]); }
    await page.close();
  }
  await ctx.close();
}

// ── touch joystick over the display, landscape phone ──────────────────────────
if (want('touch-joystick')) {
  try {
    const mctx = await browser.newContext({
      viewport: { width: 844, height: 390 }, deviceScaleFactor: 3,
      isMobile: true, hasTouch: true, reducedMotion: 'reduce',
    });
    await mctx.addInitScript(() => {
      try {
        localStorage.setItem('c64emu.installDismissed', '1');
        localStorage.setItem('c64emu.splashSeen', '1');
        // Port 2 = Touch Joystick so the overlay shows once the machine is running.
        localStorage.setItem('c64emu.controlPorts', JSON.stringify({ 1: 'none', 2: 'touchJoystick' }));
      } catch {}
    });
    const mpage = await bootPage(mctx);
    // Load a game so the joystick sits over a title screen, not the READY prompt.
    if (GAME && fs.existsSync(GAME)) {
      await mpage.setInputFiles('#prg-input', GAME);
      await sleep(8000);   // load + autorun → the game's title screen
    }
    try { await mpage.selectOption('#cp-device-p2', 'touchJoystick'); } catch {}
    await mpage.waitForSelector('#touch-controls:not([hidden])', { timeout: 5000 });
    // Fullscreen so the display fills the landscape viewport and the stick + A/B
    // sit at the corners over the game — how the touch joystick is actually used.
    try { await mpage.locator('#btn-fullscreen').first().click(); await sleep(900); } catch {}
    await sleep(400);
    saveGuideShot(await mpage.screenshot(), OUT, 'touch-joystick');   // viewport = landscape phone
    await mctx.close();
    done.push('touch-joystick'); console.log('  ✓ touch-joystick (landscape)');
  } catch (e) { skipped.push('touch-joystick'); console.error('  ✗ touch-joystick —', e.message.split('\n')[0]); }
}

await browser.close();
console.log(`\nDone. ${done.length} shots → ${OUT}`);
if (skipped.length) console.log('Skipped:', skipped.join(', '));
