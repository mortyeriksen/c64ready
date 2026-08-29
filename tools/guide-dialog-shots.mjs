// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Capture the POPULATED Library + Save-States dialogs for the User Guide.
//
// The plain guide-shots.mjs grabs those two modals right after boot, so they're
// empty (just the placeholder text + a lone IMPORT button) and show none of the
// list-row functionality. This harness populates both first, then screenshots
// them:
//   • Library     — loads every .d64 in <demoDir> into drive 8; loading a file
//                    caches it in the library (no need to run the demo).
//   • Save-States — imports every .c64state in <statesDir> (real thumbnails),
//                    exactly as the IMPORT button does.
// No power-on / demo run is needed — both dialogs read from browser storage.
//
//   node tools/guide-dialog-shots.mjs [baseURL] <demoDir> <statesDir>
//
// A dialog whose source dir holds no matching files is SKIPPED, not shot — its
// existing shot is left alone. That matters because both dialogs are captured in
// one run: populating one and not the other used to overwrite the other's good
// screenshot with an empty list. Pass one dir (or an empty one) to refresh a
// single dialog.
//
// baseURL defaults to http://localhost:5173 (the live dev server). demoDir /
// statesDir are directories you supply — their .d64 / .c64state contents are
// NOT part of the repo (each under its own copyright), so bring your own.
// Outputs land in public/guide/ (tracked, served at /guide/):
//   library-loaded.webp, save-states-loaded.webp
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { saveGuideShot, shotLabel } from './guide-image.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Output dir — defaults to the tracked public/guide/; set GUIDE_OUT to redirect
// (e.g. a scratch dir for a test run).
const OUT = process.env.GUIDE_OUT ? path.resolve(process.env.GUIDE_OUT) : path.join(root, 'public', 'guide');
fs.mkdirSync(OUT, { recursive: true });

const BASE = process.argv[2] || 'http://localhost:5173';
const DEMO_DIR = process.argv[3];
const STATES_DIR = process.argv[4];
if (!DEMO_DIR && !STATES_DIR) {
  console.error('usage: node tools/guide-dialog-shots.mjs [baseURL] <demoDir> <statesDir>');
  console.error('  (either dir may be empty or omitted — that dialog is then skipped)');
  process.exit(1);
}

// Library disks — every .d64 in demoDir, loaded in sorted order. The library
// lists newest-first, so they appear top-to-bottom in reverse of load order;
// the row label is the filename, so name the files for how they should read.
const listFiles = (dir, ext) => (fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(ext)).sort().map((f) => path.join(dir, f))
  : []);
const DISKS = listFiles(DEMO_DIR, '.d64');

// Save-state files — every .c64state in statesDir. Imported in sorted order;
// the list sorts by each state's own savedAt, so display order follows saves.
const STATES = listFiles(STATES_DIR, '.c64state');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (page, sel) => page.locator(sel).first().click({ timeout: 8000 });
async function rowCount(page, listSel) {
  return page.locator(`${listSel} .lib-row`).count().catch(() => 0);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1460, height: 1180 },
  deviceScaleFactor: 2,
  reducedMotion: 'reduce',
});
await ctx.addInitScript(() => { try { localStorage.setItem('c64emu.installDismissed', '1'); localStorage.setItem('c64emu.splashSeen', '1'); } catch {} });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('  page error:', e.message));

console.log(`\nPopulated-dialog shots → ${OUT}\n  base=${BASE}`);
if (!DISKS.length) console.log(`  library skipped — no .d64 files in ${DEMO_DIR || '(no dir given)'}`);
if (!STATES.length) console.log(`  save-states skipped — no .c64state files in ${STATES_DIR || '(no dir given)'}`);

await page.goto(BASE, { waitUntil: 'networkidle' });
// ROMs auto-load from /roms/ → the media buttons + inputs go live.
await page.waitForSelector('#btn-power:not([disabled])', { timeout: 20000 });
try {
  if (await page.locator('#setup-modal:not([hidden])').isVisible())
    await click(page, '#btn-setup-later');
} catch {}
await sleep(300);

// ── Library: load each disk (caches it) ─────────────────────────────────────
console.log('\n[library] caching disks');
for (const disk of DISKS) {
  if (!fs.existsSync(disk)) continue;
  await page.setInputFiles('#d64-input', disk);
  console.log('  +', path.basename(disk));
  await sleep(1200);                       // let the IndexedDB write settle
}
await sleep(800);

// ── Save-States: import each .c64state (one at a time — handler reads files[0]) ─
if (STATES.length) {
console.log('\n[save-states] importing states');
await click(page, '#btn-load-state');
await page.waitForSelector('#state-modal:not([hidden])', { timeout: 5000 });
for (const st of STATES) {
  if (!fs.existsSync(st)) continue;
  const before = await rowCount(page, '#state-list');
  await page.setInputFiles('#state-import-input', st);
  // Wait until the list re-renders with the new row (import is async).
  await page.waitForFunction(
    (n) => document.querySelectorAll('#state-list .lib-row').length > n,
    before, { timeout: 8000 },
  ).catch(() => console.error('    (row did not appear:', path.basename(st), ')'));
  console.log('  +', path.basename(st));
}
await sleep(400);
}

// ── Screenshot the Save-States dialog ───────────────────────────────────────
// Close + reopen so the transient "Imported …" status line clears (reopening
// calls _setStateImportStatus('')); move the pointer off the rows so no hover
// highlight bakes into the shot.
console.log('\n[shots]');
if (STATES.length) {
try { await page.keyboard.press('Escape'); } catch {}
await sleep(300);
await click(page, '#btn-load-state');
await page.waitForSelector('#state-modal:not([hidden])', { timeout: 5000 });
await page.mouse.move(0, 0);
await sleep(400);
console.log(`  state rows = ${await rowCount(page, '#state-list')}`);
console.log('  ✓', shotLabel('save-states-loaded', saveGuideShot(
  await page.locator('#state-modal .modal-card').first().screenshot(),
  OUT, 'save-states-loaded')));
try { await page.keyboard.press('Escape'); } catch {}
await sleep(300);
}

// ── Screenshot the Library dialog ───────────────────────────────────────────
if (DISKS.length) {
await click(page, '#btn-library');
await page.waitForSelector('#library-modal:not([hidden])', { timeout: 5000 });
await page.mouse.move(0, 0);
await sleep(500);
console.log(`  library rows = ${await rowCount(page, '#library-list')}`);
console.log('  ✓', shotLabel('library-loaded', saveGuideShot(
  await page.locator('#library-modal .modal-card').first().screenshot(),
  OUT, 'library-loaded')));
}

await browser.close();
console.log('\nDone.');
