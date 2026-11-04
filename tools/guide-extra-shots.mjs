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
//   user-port-modem.webp the Hayes Modem controls, ready with its speaker on
//   iec-printer.webp     IEC Printer connected at address 4 with a captured job
//   user-port-bbs.webp    animated: CCGMS on the built-in Modem calling a
//                        real C64 BBS (The Oasis BBS) through the dev server's
//                        relay, from the dial to its title screen. Needs the
//                        'ccgms' asset, img2webp, the network and the BBS's one
//                        line free. GUIDE_BBS=host:port picks another board.
//   achievements-chat.webp the CHAT tab of the Achievements window, docked beside Commando Arcade running,
//                        two guests talking with the player, who mentions the
//                        game with @. The three sign up with passkeys on the
//                        dev server's own chat (/chat, /api) and are deleted
//                        afterwards; never the production one.
//   achievements-game.webp / -games.webp / -activity.webp  the Achievements
//                        window docked beside Commando Arcade running: its GAME tab
//                        (progress, the high scores, Trophy Hunters, the
//                        achievements), then GAMES, then ACTIVITY. Five players
//                        sign up on the dev server, post unlocks and scores
//                        through the games API, and are deleted afterwards.
//                        Run it against a dev server with accounts in memory
//                        (VITE_ACCOUNTS_IN_MEMORY=1) so no real player shows.
//   vibes-toast.webp     Retro Vibes' IK+ Sunset with Commando Arcade on the TV and a new first
//                        place toast at its peak: turned to gold, stamped #1,
//                        confetti flying. The toast is the app's own
//                        (src/achievements/toast.js), shown where vibes puts it.
//   vibes-hud.webp       Retro Vibes with Commando Arcade in play, the trophy HUD
//                        as its full bar (src/achievements/hud.js) and an unlock
//                        toast landing. The guide's Commando Arcade players sign up
//                        and post results, so run it against a dev server with
//                        accounts in memory (VITE_ACCOUNTS_IN_MEMORY=1).
//
// Drives the LIVE dev server (start your Vite first). Shots land in public/guide/
// as 1920-capped WebP (guide-image.mjs).
//   node tools/guide-extra-shots.mjs [baseURL] [drive8D64]
// drive8D64 defaults to the 'raster-time-demo' asset (test/external-assets.json).
// Set GUIDE_ONLY=update-toast (comma-separated) to regenerate only some shots.
import { chromium } from 'playwright';
import { deleteAccounts as deleteAccountsAt, signUpWith, seedPlayers, signedIn, applySignIn, COMMANDO_ARCADE_PLAYERS, COMMANDO_ARCADE_ME } from './guide-achievements.mjs';
import { createGuideContext } from './guide-context.mjs';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { assetPath, missingNote } from '../test/external-assets.js';
import { saveGuideShot, shotLabel } from './guide-image.mjs';
import { launchShotBrowser, reportRenderer } from './shot-browser.mjs';
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

// Commando Arcade from its loading picture into a game: fire (J, Joy 2's key
// joystick) past the picture, the menu, the trainer options and the title,
// until $0410, the men left, goes from the title's 0 to a game's 5.
async function intoCommandoArcade(page) {
  const men = () => page.evaluate(() => window.c64.ram()[0x0410]);
  let title = false;
  for (let i = 0; i < 8; i++) {
    const m = await men();
    if (m === 0) title = true;
    else if (title && m === 5) break;
    await page.locator('#screen').focus().catch(() => {});
    await page.keyboard.down('j'); await sleep(160); await page.keyboard.up('j');
    await sleep(3000);
  }
  await sleep(2500);   // Super Joe out of the truck
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
  const ctx = await createGuideContext(browser, { colorScheme: 'dark',
    viewport: { width: 1460, height: 1180 }, deviceScaleFactor: 2, reducedMotion: 'reduce',
  });
  await ctx.addInitScript(() => { try { localStorage.setItem('c64emu.equipmentHintShown', '1'); localStorage.setItem('c64emu.panelHidden', '[]'); localStorage.setItem('c64emu.installDismissed', '1'); localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1'); } catch {} });
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
  const ctx = await createGuideContext(browser, { colorScheme: 'dark',
    viewport: { width: 1460, height: 1180 }, deviceScaleFactor: 2, reducedMotion: 'reduce',
  });
  await ctx.addInitScript(() => { try { localStorage.setItem('c64emu.equipmentHintShown', '1'); localStorage.setItem('c64emu.panelHidden', '[]'); localStorage.setItem('c64emu.installDismissed', '1'); localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1'); } catch {} });
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
  const ctx = await createGuideContext(browser, { colorScheme: 'dark',
    // Much shorter than the other desktop shots: the panel ends well above 1180
    // and the target sits in the corner of the VIEWPORT, so spare height lands
    // as a band of empty page between the two things the shot is about.
    viewport: { width: 1460, height: 780 }, deviceScaleFactor: 2, reducedMotion: 'reduce',
  });
  await ctx.addInitScript(() => { try { localStorage.setItem('c64emu.equipmentHintShown', '1'); localStorage.setItem('c64emu.panelHidden', '[]'); localStorage.setItem('c64emu.installDismissed', '1'); localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1'); } catch {} });

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
    const mctx = await createGuideContext(browser, { colorScheme: 'dark',
      viewport: { width: 844, height: 390 }, deviceScaleFactor: 3,
      isMobile: true, hasTouch: true, reducedMotion: 'reduce',
    });
    await mctx.addInitScript(() => {
      try {
        localStorage.setItem('c64emu.equipmentHintShown', '1'); localStorage.setItem('c64emu.panelHidden', '[]'); localStorage.setItem('c64emu.installDismissed', '1');
        localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1');
        // Port 2 = Touch Joystick so the overlay shows once the machine is running.
        localStorage.setItem('c64emu.controlPorts', JSON.stringify({ 1: 'none', 2: 'touchJoystick' }));
      } catch {}
    });
    const mpage = await bootPage(mctx);
    // Load a game so the joystick sits over a title screen, not the READY prompt.
    if (GAME && fs.existsSync(GAME)) {
      await mpage.setInputFiles('#prg-input', GAME);
      // A .prg with TDE on is offered the faster load; take it, so the dialog is
      // gone and the game is up in time.
      const offer = mpage.locator('#confirm-modal:not([hidden])');
      if (await offer.waitFor({ timeout: 3000 }).then(() => true, () => false)) await mpage.locator('#btn-confirm-ok').click();
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

// ── the user port: CCGMS on the Modem, calling a BBS ─────────────────────
// An animated WebP of a whole call at 9600 baud, CCGMS set to its UP9600 driver
// first: the dial typed at a person's pace, CONNECT, the board asking for
// RETURN and whether the terminal shows Commodore graphics, then its title
// screen drawing in. The Oasis is a real C64 on one line, so a call fails while
// someone else is on, or for a few minutes after a call while it resets. The film ends as the title's "press any key" shows,
// or once the screen has been still for BBS_STILL.
const BBS_STEP = 200;                                    // ms between frames
const BBS_HOLD = 3000;                                   // the finished title, before the loop
const BBS_STILL = 3000;
// Prompt, then the key. Keys go into the keyboard buffer as PETSCII, where
// unshifted letters are ASCII capitals.
const BBS_ANSWERS = [['hit return', '\r'], ['(y/n)', 'Y']];
// Runs in the page (Playwright sends the source, so the word is an argument).
const screenHas = (word) => {
  const ram = window.machine.mem.ram;
  let text = '';
  for (let i = 0x0400; i < 0x07e8; i++) {
    const c = ram[i] & 0x7f;
    text += c >= 1 && c <= 26 ? String.fromCharCode(c + 96) : String.fromCharCode(c);
  }
  return text.toLowerCase().includes(word);
};
if (want('user-port-modem')) {
  const roms = {};
  for (const [slot, asset] of Object.entries({ kernal: 'kernal', basic: 'basic', charRom: 'chargen' })) {
    const file = assetPath(asset);
    if (file) roms[`c64emu.rom.${slot}`] = fs.readFileSync(file).toString('base64');
  }
  if (Object.keys(roms).length !== 3) {
    skipped.push('user-port-modem');
    console.log('  # SKIP user-port-modem: local C64 ROMs are required');
  } else {
    const ctx = await createGuideContext(browser, { colorScheme: 'dark',
      viewport: { width: 1460, height: 1180 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    try {
      await ctx.addInitScript(cache => {
        for (const [key, value] of Object.entries(cache)) localStorage.setItem(key, value);
        localStorage.setItem('c64emu.equipmentHintShown', '1'); localStorage.setItem('c64emu.panelHidden', '[]'); localStorage.setItem('c64emu.installDismissed', '1');
        localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1');
        localStorage.setItem('c64emu.userport', 'on');
        localStorage.setItem('c64emu.userport.device', 'builtin.wifi-modem');
        localStorage.setItem('c64emu.userport.dev.builtin.wifi-modem.speaker', 'true');
      }, roms);
      const page = await bootPage(ctx);
      await page.locator('#userport-panel button[aria-label="Modem speaker"]').waitFor();
      await page.evaluate(() => document.fonts.ready);
      const card = page.locator('#userport-card');
      await card.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await sleep(400);
      console.log(`  ✓ ${shotLabel('user-port-modem', saveGuideShot(await card.screenshot(), OUT, 'user-port-modem'))}`);
      done.push('user-port-modem');
    } finally { await ctx.close(); }
  }
}

if (want('iec-printer')) {
  const roms = {};
  for (const [slot, asset] of Object.entries({ kernal: 'kernal', basic: 'basic', charRom: 'chargen' })) {
    const file = assetPath(asset);
    if (file) roms[`c64emu.rom.${slot}`] = fs.readFileSync(file).toString('base64');
  }
  if (Object.keys(roms).length !== 3) {
    skipped.push('iec-printer');
    console.log('  # SKIP iec-printer: local C64 ROMs are required');
  } else {
    const ctx = await createGuideContext(browser, { colorScheme: 'dark',
      viewport: { width: 1460, height: 1180 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    try {
      await ctx.addInitScript(cache => {
        for (const [key, value] of Object.entries(cache)) localStorage.setItem(key, value);
        localStorage.setItem('c64emu.equipmentHintShown', '1'); localStorage.setItem('c64emu.panelHidden', '[]'); localStorage.setItem('c64emu.installDismissed', '1');
        localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1');
      }, roms);
      const page = await bootPage(ctx);
      await page.locator('#iec-card .panel-card-header h2').click();
      await page.click('#btn-iec-url');
      await page.selectOption('#iec-plugin-choice', 'printer');
      await page.locator('#iec-modal-actions').getByRole('button', { name: 'FETCH', exact: true }).click();
      await page.check('#iec-install-trust');
      await page.locator('#iec-modal-actions').getByRole('button', { name: 'INSTALL', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#iec-device').value === 'c64ready.iec-printer');
      await page.selectOption('#iec-address', '4');
      await page.click('#btn-iec-connect');
      await page.waitForFunction(() => window.machine?.iec?.devices.has(4));
      await page.evaluate(() => {
        const command = 'OPEN1,4:PRINT#1,"HELLO WORLD":CLOSE1\r';
        let at = 0;
        for (let frame = 0; frame < 180; frame++) {
          at += window.machine.bufferKeyboardText(command.slice(at));
          window.machine.runFrame();
        }
      });
      await page.waitForFunction(() => /^Idle · [1-9]\d* bytes received$/.test(
        document.querySelector('.iec-connected[data-address="4"] .iec-device-status').textContent), null, { timeout: 15000 });
      await page.evaluate(() => document.fonts.ready);
      const card = page.locator('#iec-card');
      await card.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await sleep(400);
      console.log(`  ✓ ${shotLabel('iec-printer', saveGuideShot(await card.screenshot(), OUT, 'iec-printer'))}`);
      done.push('iec-printer');
    } finally { await ctx.close(); }
  }
}

if (want('user-port-bbs')) {
  const ccgms = assetPath('ccgms');
  const bbs = process.env.GUIDE_BBS || 'oasisbbs.hopto.org:6400';
  let encoder = true;
  try { execFileSync('img2webp', ['-version'], { stdio: 'ignore' }); } catch { encoder = false; }
  if (!ccgms || !encoder) {
    skipped.push('user-port-bbs');
    console.log(`  # SKIP user-port-bbs — ${!ccgms ? missingNote('ccgms') : 'img2webp not found (brew install webp)'}`);
  } else {
    // At 1x the 384x272 screen is drawn at twice its pixels, crisp and small.
    const ctx = await createGuideContext(browser, { colorScheme: 'dark',
      viewport: { width: 1460, height: 1180 }, deviceScaleFactor: 1, reducedMotion: 'reduce',
    });
    // ROMs into the browser's cache, as the setup dialog keeps them.
    const roms = {};
    for (const [slot, asset] of Object.entries({ kernal: 'kernal', basic: 'basic', charRom: 'chargen' })) {
      const file = assetPath(asset);
      if (file) roms[`c64emu.rom.${slot}`] = fs.readFileSync(file).toString('base64');
    }
    await ctx.addInitScript((cache) => {
      try {
        for (const [key, value] of Object.entries(cache)) localStorage.setItem(key, value);
        localStorage.setItem('c64emu.equipmentHintShown', '1'); localStorage.setItem('c64emu.panelHidden', '[]'); localStorage.setItem('c64emu.installDismissed', '1');
        localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1');
        localStorage.setItem('c64emu.userport', 'on');
        localStorage.setItem('c64emu.userport.device', 'builtin.wifi-modem');
      } catch {}
    }, roms);
    const page = await bootPage(ctx);
    const type = async (text, gap = 160) => {
      for (const ch of text) {
        await page.evaluate((c) => window.machine.bufferKeyboardText(c), ch);
        await sleep(gap);
      }
    };
    const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'bbs-frames-'));
    let capturing = false, n = 0, filming = null;
    const capture = async () => {
      const t0 = Date.now();
      while (capturing) {
        const wait = n * BBS_STEP - (Date.now() - t0);
        if (wait > 0) await sleep(wait);
        await page.locator('#screen').screenshot({ path: path.join(frames, `f${String(n).padStart(4, '0')}.png`) });
        n++;
      }
    };
    try {
      await page.evaluate((bytes) => window.machine.loadPRG(new Uint8Array(bytes)), Array.from(fs.readFileSync(ccgms)));
      await type('RUN\r', 60);
      await page.waitForFunction(screenHas, 'mode ready', { timeout: 20000, polling: 250 });
      await sleep(1500);
      // F7 opens the parameters: M steps the modem type, B the baud rate.
      await type('\x88', 400);
      for (const [key, want] of [['M', 'up9600'], ['B', 'rate   - 9600']]) {
        for (let i = 0; i < 8 && !(await page.evaluate(screenHas, want)); i++) await type(key, 500);
        if (!(await page.evaluate(screenHas, want))) throw new Error(`CCGMS setting not found: ${want}`);
      }
      await type('\r', 400);
      await page.waitForFunction(screenHas, 'mode ready', { timeout: 20000, polling: 250 });
      await sleep(1000);
      capturing = true;
      filming = capture();
      await sleep(1000);
      await type(`ATDT"${bbs.toUpperCase()}"\r`);
      for (const [prompt, key] of BBS_ANSWERS) {
        await page.waitForFunction(screenHas, prompt, { timeout: 45000, polling: 250 });
        await sleep(1200);
        await type(key);
      }
      // Screen and colour RAM, sampled until they stop changing.
      const look = () => page.evaluate(() => {
        const m = window.machine;
        let h = 0;
        for (let i = 0x0400; i < 0x07e8; i++) h = (h * 31 + m.mem.ram[i]) | 0;
        for (let i = 0; i < 1000; i++) h = (h * 31 + m.mem.colorRam[i]) | 0;
        return h;
      });
      let last = await look(), lastFrame = n, changedAt = Date.now(), drawn = false;
      const end = Date.now() + 90000;
      let titleAt = 0;
      while (Date.now() < end && !(drawn && Date.now() - changedAt > BBS_STILL)) {
        await sleep(250);
        const h = await look();
        if (h !== last) { last = h; lastFrame = n; changedAt = Date.now(); drawn = true; }
        if (!titleAt && await page.evaluate(screenHas, 'press any key')) titleAt = Date.now();
        if (titleAt && Date.now() - titleAt > 500) { lastFrame = n; break; }
      }
      if (!drawn) throw new Error('nothing came after the last answer');
      capturing = false;
      await filming;
      const files = fs.readdirSync(frames).filter((f) => f.endsWith('.png')).sort()
        .slice(0, lastFrame + 2).map((f) => path.join(frames, f));
      const out = path.join(OUT, 'user-port-bbs.webp');
      execFileSync('img2webp', ['-loop', '0', '-lossy', '-q', '85', '-m', '6',
        '-d', String(BBS_STEP), ...files.slice(0, -1), '-d', String(BBS_HOLD), files[files.length - 1], '-o', out], { stdio: 'ignore' });
      done.push('user-port-bbs');
      console.log(`  ✓ user-port-bbs (${bbs}, ${files.length} frames, ${(fs.statSync(out).size / 1024).toFixed(0)} KiB)`);
    } catch (e) {
      capturing = false;
      await filming?.catch(() => {});
      skipped.push('user-port-bbs');
      const status = await page.textContent('#userport-status').catch(() => '?');
      console.error('  ✗ user-port-bbs —', e.message.split('\n')[0], `(user port: ${status})`);
      const shown = await page.evaluate(() => {
        const ram = window.machine.mem.ram, rows = [];
        for (let r = 0; r < 25; r++) {
          let line = '';
          for (let c = 0; c < 40; c++) { const v = ram[0x0400 + r * 40 + c] & 0x7f; line += v >= 1 && v <= 26 ? String.fromCharCode(v + 96) : String.fromCharCode(v); }
          if (line.trim()) rows.push(`    ${line.trimEnd()}`);
        }
        return rows.slice(-8).join('\n');
      }).catch(() => '');
      if (shown) console.error(shown);
    }
    fs.rmSync(frames, { recursive: true, force: true });
    await ctx.close();
  }
}

// Accounts made with a virtual passkey, and deleted again afterwards (tools/guide-achievements.mjs).
const deleteAccounts = (tokens) => deleteAccountsAt(BASE, tokens);

// ── desktop: the chat, docked beside a game, the player mentioning it ───────────────
if (want('achievements-chat')) {
  const guests = [], tokens = [];
  const signUp = (ctx, page, name) => signUpWith(tokens, ctx, page, name);
  try {
    const chatUrl = `${BASE.replace(/^http/, 'ws')}/chat`;
    const { PROTOCOL } = await import('../server/protocol.mjs');
    const ctx = await createGuideContext(browser, { colorScheme: 'dark',
      viewport: { width: 1460, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce',
    });
    await ctx.addInitScript((url) => {
      try {
        localStorage.setItem('c64emu.equipmentHintShown', '1'); localStorage.setItem('c64emu.panelHidden', '[]'); localStorage.setItem('c64emu.installDismissed', '1');
        localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1');
        localStorage.setItem('c64emu.chat.server', url);
        localStorage.removeItem('c64emu.online.rect');
      } catch {}
    }, chatUrl);
    const page = await bootPage(ctx);
    await signUp(ctx, page, 'Pixel');
    await page.reload({ waitUntil: 'networkidle' });   // the app picks up the stored session
    await page.waitForSelector('#btn-power:not([disabled])', { timeout: 20000 });
    const ARCADE = assetPath('commando-arcade-crt') || '';
    if (!(ARCADE && fs.existsSync(ARCADE))) throw new Error(`no game to talk about (${missingNote('commando-arcade-crt')})`);
    await page.setInputFiles('#prg-input', ARCADE);
    const offer = page.locator('#confirm-modal:not([hidden])');
    if (await offer.waitFor({ timeout: 3000 }).then(() => true, () => false)) await page.locator('#btn-confirm-ok').click();
    await sleep(9000);   // the loading picture
    await intoCommandoArcade(page);
    if (await page.locator('#online-window').isHidden()) await page.locator('#btn-online').click();
    await page.locator('#online-tab-chat').click();
    await page.locator('.chat-view-channel').waitFor({ state: 'visible', timeout: 10000 });

    // Two guests sign up the same way, then talk over the chat socket.
    const guest = async (name) => {
      const gctx = await browser.newContext();
      const gpage = await gctx.newPage();
      await gpage.goto(BASE, { waitUntil: 'domcontentloaded' });
      const { token } = await signUp(gctx, gpage, name);
      await gctx.close();
      return new Promise((resolve, reject) => {
        const w = new WebSocket(chatUrl, { headers: { origin: new URL(BASE).origin } });
        guests.push(w);
        let id = 0;
        w.onopen = () => w.send(JSON.stringify({ t: 'hello', v: PROTOCOL, account: token }));
        w.onmessage = (e) => {
          const d = JSON.parse(e.data);
          if (d.t === 'welcome') d.room ? resolve((text) => w.send(JSON.stringify({ id: ++id, t: 'say', text }))) : reject(new Error(`${name} was kept out of the chat`));
          else if (d.t === 'err' && !d.id) reject(new Error(`${name}: ${d.code}`));
        };
        w.onerror = () => reject(new Error(`${name} could not connect to ${chatUrl}`));
      });
    };
    const zak = await guest('Zak');
    const ruby = await guest('Ruby');
    // The player's lines are typed, so '@comm' and a click pick Commando Arcade from the list.
    const me = async (text) => {
      const input = page.locator('.chat-compose .chat-input');
      await input.click();
      for (const part of text.split(/(@\w+)/)) {
        if (!part) continue;
        await input.pressSequentially(part);
        if (part.startsWith('@')) {
          await page.locator('.chat-mentions').waitFor({ timeout: 5000 });
          const pick = page.locator('.chat-mentions li', { hasText: 'Commando Arcade' });
          if (await pick.count()) await pick.first().click(); else await input.press('Enter');
        }
      }
      await input.press('Enter');
    };
    for (const say of [
      () => me('Anyone else still stuck at the first gate in @comm'),
      () => zak('Stay left and lob grenades over the sandbags'),
      () => ruby('That worked for me. The music still slaps after 40 years'),
      () => me('Rob Hubbard at his best'),
      () => zak('Turn it up!'),
    ]) { await say(); await sleep(1100); }
    await page.mouse.move(10, 890);   // no hover highlight in the shot
    await sleep(500);
    const info = saveGuideShot(await page.screenshot(), OUT, 'achievements-chat');
    done.push('achievements-chat'); console.log('  ✓', shotLabel('achievements-chat', info));
    await ctx.close();
  } catch (e) { skipped.push('achievements-chat'); console.error('  ✗ achievements-chat —', e.message.split('\n')[0]); }
  for (const w of guests) w.close();
  await deleteAccounts(tokens);
}

// ── desktop: the Achievements window over Commando Arcade, then GAMES docked, then ACTIVITY ──
if (want('achievements')) {
  const tokens = [];
  const ARCADE = assetPath('commando-arcade-crt') || '';
  try {
    if (!(ARCADE && fs.existsSync(ARCADE))) throw new Error(`no Commando Arcade cartridge (${missingNote('commando-arcade-crt')})`);
    const set = JSON.parse(fs.readFileSync(path.join(root, 'server/sets/commando-arcade.json'), 'utf8'));
    const hash = set.hashes[0].hash;
    const ctx = await createGuideContext(browser, { colorScheme: 'dark',
      viewport: { width: 1460, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce',
    });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('c64emu.equipmentHintShown', '1'); localStorage.setItem('c64emu.panelHidden', '[]'); localStorage.setItem('c64emu.installDismissed', '1');
        localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1');
        localStorage.removeItem('c64emu.online.rect'); localStorage.removeItem('c64emu.online.dock'); localStorage.removeItem('c64emu.achievements');
      } catch {}
    });
    const page = await bootPage(ctx);
    const { token: mine } = await signUpWith(tokens, ctx, page, 'Pixel');
    // Other players, each with their own unlocks and best score, so the
    // high-score screen, the activity and the cards have people in them.
    // A post over the server's limit (ten at once, then one each 2 seconds) waits and tries again.
    const post = async (token, url, body) => {
      for (;;) {
        const r = await fetch(`${BASE}/api${url}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: new URL(BASE).origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (r.status === 429) { await sleep(2100); continue; }
        if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
        return;
      }
    };
    const play = async (token, ids, score) => {
      for (const id of ids) await post(token, `/games/${hash}/unlocks`, { achievementId: id, hardcore: true });
      if (score) await post(token, `/games/${hash}/leaderboards/1/entries`, { value: score, hardcore: true });
    };
    for (const [name, ids, score] of [
      ['Zak', [1, 2, 3, 9, 11, 12], 41200],
      ['Ruby', [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13], 96350],
      ['Nova', [1, 9, 11], 18750],
      ['Hubbard', [1, 2, 3, 4, 9, 11, 12, 13], 63900],
    ]) {
      const gctx = await browser.newContext();
      const gpage = await gctx.newPage();
      await gpage.goto(BASE, { waitUntil: 'domcontentloaded' });
      const { token } = await signUpWith(tokens, gctx, gpage, name);
      await gctx.close();
      await play(token, ids, score);
    }
    await play(mine, [1, 2, 9, 11], 34600);
    await page.reload({ waitUntil: 'networkidle' });   // the app picks up the stored session
    await page.waitForSelector('#btn-power:not([disabled])', { timeout: 20000 });
    await page.setInputFiles('#prg-input', ARCADE);
    const offer = page.locator('#confirm-modal:not([hidden])');
    if (await offer.waitFor({ timeout: 3000 }).then(() => true, () => false)) await page.locator('#btn-confirm-ok').click();
    // A game with a set opens the window on its GAME tab.
    await page.locator('#online-window .ach-screen').first().waitFor({ timeout: 20000 });
    await sleep(9000);   // the loading picture
    await intoCommandoArcade(page);
    await page.mouse.move(10, 890);
    await sleep(400);
    let info = saveGuideShot(await page.screenshot(), OUT, 'achievements-game');
    done.push('achievements-game'); console.log('  ✓', shotLabel('achievements-game', info));

    await page.locator('#online-tab-games').click();
    if (!(await page.evaluate(() => document.body.classList.contains('has-docked-window')))) await page.locator('#btn-online-dock').click();
    await page.locator('.ach-card').first().waitFor({ timeout: 10000 });
    await page.mouse.move(10, 890);
    await sleep(600);
    info = saveGuideShot(await page.screenshot(), OUT, 'achievements-games');
    done.push('achievements-games'); console.log('  ✓', shotLabel('achievements-games', info));

    await page.locator('#online-tab-activity').click();
    await page.locator('#achievements-activity li').first().waitFor({ timeout: 10000 });
    await page.mouse.move(10, 890);
    await sleep(600);
    info = saveGuideShot(await page.screenshot(), OUT, 'achievements-activity');
    done.push('achievements-activity'); console.log('  ✓', shotLabel('achievements-activity', info));
    await ctx.close();
  } catch (e) { skipped.push('achievements'); console.error('  ✗ achievements —', e.message.split('\n')[0]); }
  await deleteAccounts(tokens);
}

// ── Retro Vibes: a new first place toast mid-celebration ──
if (want('vibes-toast')) {
  const ARCADE = assetPath('commando-arcade-crt') || '';
  const gpu = await launchShotBrowser();   // the 3D scene on the GPU when there is one
  try {
    if (!(ARCADE && fs.existsSync(ARCADE))) throw new Error(`no Commando Arcade cartridge (${missingNote('commando-arcade-crt')})`);
    const ctx = await createGuideContext(gpu, { colorScheme: 'dark', viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('c64emu.installDismissed', '1'); localStorage.setItem('c64emu.splashSeen', '1');
        localStorage.setItem('c64emu.vibesModel', 'small'); localStorage.setItem('c64emu.modelViewerScene', 'IK+ Sunset');
        localStorage.setItem('c64emu.achievements', 'off');   // only the staged toast shows
        localStorage.removeItem('c64emu.achToastVibesPlace'); localStorage.removeItem('c64emu.achToastVibesSize');
      } catch {}
    });
    const page = await bootPage(ctx);
    await reportRenderer(page);
    await page.setInputFiles('#prg-input', ARCADE);
    const offer = page.locator('#confirm-modal:not([hidden])');
    if (await offer.waitFor({ timeout: 3000 }).then(() => true, () => false)) await page.locator('#btn-confirm-ok').click();
    await sleep(9000);   // the loading picture
    await intoCommandoArcade(page);
    await page.locator('#btn-vibes').click({ force: true });
    await page.waitForFunction(() => !document.getElementById('model-viewer-overlay').hidden, null, { timeout: 60000 });
    await page.waitForFunction(() => { const l = document.querySelector('.model-viewer-loading'); return !l || getComputedStyle(l).display === 'none'; }, null, { timeout: 60000 });
    await sleep(6000);
    await page.mouse.move(800, 880);
    // A new first place on Commando Arcade's board, from rank 3, where vibes shows toasts.
    await page.evaluate(async () => {
      const { createAchToasts } = await import('/src/achievements/toast.js');
      const view = document.getElementById('model-viewer-overlay');
      createAchToasts({ host: () => view, ms: 60000 }).show({
        kind: 'score', title: 'High Score', text: '',
        score: { value: 124550, outcome: 'top', from: 98200, rankFrom: 3, format: (v) => v.toLocaleString('en-US') },
      });
    });
    await page.waitForSelector('.model-viewer-overlay > .ach-toast', { timeout: 5000 });
    // Timed from the #1 stamp, past the flash, with the confetti at its height.
    await page.waitForSelector('.model-viewer-overlay > .ach-toast .ach-toast-stamp', { timeout: 60000 });
    await sleep(Number(process.env.GUIDE_TOAST_AFTER) || 420);
    const info = saveGuideShot(await page.screenshot(), OUT, 'vibes-toast');
    done.push('vibes-toast'); console.log('  ✓', shotLabel('vibes-toast', info));
    await ctx.close();
  } catch (e) { skipped.push('vibes-toast'); console.error('  ✗ vibes-toast —', e.message.split('\n')[0]); }
  await gpu.close();
}

// ── Retro Vibes: the trophy HUD as its full bar, with an unlock toast landing ──
if (want('vibes-hud')) {
  const tokens = [];
  const ARCADE = assetPath('commando-arcade-crt') || '';
  const gpu = await launchShotBrowser();
  try {
    if (!(ARCADE && fs.existsSync(ARCADE))) throw new Error(`no Commando Arcade cartridge (${missingNote('commando-arcade-crt')})`);
    const set = JSON.parse(fs.readFileSync(path.join(root, 'server/sets/commando-arcade.json'), 'utf8'));
    const me = await seedPlayers(browser, BASE, set.hashes[0].hash, COMMANDO_ARCADE_PLAYERS, COMMANDO_ARCADE_ME, tokens);
    const ctx = await createGuideContext(gpu, { colorScheme: 'dark', viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('c64emu.installDismissed', '1'); localStorage.setItem('c64emu.splashSeen', '1');
        localStorage.setItem('c64emu.vibesModel', 'small'); localStorage.setItem('c64emu.modelViewerScene', 'IK+ Sunset');
        localStorage.removeItem('c64emu.achievements');   // on, so the HUD has its game
        localStorage.removeItem('c64emu.achHud');          // the HUD where it starts: the full bar at the foot
        localStorage.removeItem('c64emu.achToastVibesPlace'); localStorage.removeItem('c64emu.achToastVibesSize');
      } catch {}
    });
    await ctx.addInitScript(applySignIn, signedIn(me));
    const page = await bootPage(ctx);
    await reportRenderer(page);
    await page.setInputFiles('#prg-input', ARCADE);
    const offer = page.locator('#confirm-modal:not([hidden])');
    if (await offer.waitFor({ timeout: 3000 }).then(() => true, () => false)) await page.locator('#btn-confirm-ok').click();
    await sleep(9000);   // the loading picture
    await intoCommandoArcade(page);
    await page.locator('#btn-vibes').click({ force: true });
    await page.waitForFunction(() => !document.getElementById('model-viewer-overlay').hidden, null, { timeout: 60000 });
    await page.waitForFunction(() => { const l = document.querySelector('.model-viewer-loading'); return !l || getComputedStyle(l).display === 'none'; }, null, { timeout: 60000 });
    await page.waitForSelector('.model-viewer-overlay > .ach-hud:not([hidden])', { timeout: 20000 });
    await sleep(6000);
    await page.mouse.move(800, 60);
    // An unlock the player has yet to make, landing where vibes shows toasts.
    const next = set.achievements.find((a) => a.id === 3);
    await page.evaluate(async (a) => {
      const { createAchToasts } = await import('/src/achievements/toast.js');
      const view = document.getElementById('model-viewer-overlay');
      createAchToasts({ host: () => view, ms: 60000 }).show({ kind: 'unlock', title: a.title, text: a.description, points: a.points });
    }, { title: next.title, description: next.description, points: next.points });
    await page.waitForSelector('.model-viewer-overlay > .ach-toast .ach-toast-points.ach-toast-pop', { timeout: 10000 });
    await sleep(Number(process.env.GUIDE_TOAST_AFTER) || 300);
    const info = saveGuideShot(await page.screenshot(), OUT, 'vibes-hud');
    done.push('vibes-hud'); console.log('  ✓', shotLabel('vibes-hud', info));
    await ctx.close();
  } catch (e) { skipped.push('vibes-hud'); console.error('  ✗ vibes-hud —', e.message.split('\n')[0]); }
  await gpu.close();
  await deleteAccounts(tokens);
}

await browser.close();
console.log(`\nDone. ${done.length} shots → ${OUT}`);
if (skipped.length) console.log('Skipped:', skipped.join(', '));
