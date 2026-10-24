// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Capture the curated Library and Save States dialogs for the User Guide.
// Each shows the same three named items and real state thumbnails as the guide.
// Media comes from guide-library-* and guide-state-* in external-assets.json.
// Nothing is copied into the public tree except the screenshots.
//
//   node tools/guide-dialog-shots.mjs [baseURL]
//
// Output: public/guide/{library,save-states}-loaded.webp (GUIDE_OUT redirects it).
import { chromium } from 'playwright';
import { createGuideContext } from './guide-context.mjs';
import { assetPath, missingNote } from '../test/external-assets.js';
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
function inputs(items) {
  return items.flatMap(([key, name, days]) => {
    const file = assetPath(key);
    if (!file) { console.log(`# SKIP ${missingNote(key)}`); return []; }
    return [{ file, name, days }];
  });
}
const DISKS = inputs([
  ['guide-library-lunatico', 'Lunatico.d64'],
  ['guide-library-next-level', 'Next Level.d64'],
  ['guide-library-the-hat', 'The Hat.d64'],
]);
const STATES = inputs([
  ['guide-state-plasma', 'Code D1 - Plasma', 21],
  ['guide-state-commando', 'COMMANDO - Title', 28],
  ['guide-state-nine', 'Nine - Hyperscreen', 21],
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (page, sel) => page.locator(sel).first().click({ timeout: 8000 });
async function rowCount(page, listSel) {
  return page.locator(`${listSel} .lib-row`).count().catch(() => 0);
}

const browser = await chromium.launch();
const ctx = await createGuideContext(browser, { colorScheme: 'dark',
  viewport: { width: 1460, height: 1180 },
  deviceScaleFactor: 2,
  reducedMotion: 'reduce',
});
await ctx.addInitScript(() => { try { localStorage.setItem('c64emu.installDismissed', '1'); localStorage.setItem('c64emu.splashSeen', '1'); localStorage.setItem('c64emu.themePickerShown', '1'); } catch {} });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('  page error:', e.message));

console.log(`\nPopulated-dialog shots → ${OUT}\n  base=${BASE}`);
if (!DISKS.length) console.log('# SKIP Library guide inputs unavailable');
if (!STATES.length) console.log('# SKIP Save States guide inputs unavailable');

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
  await page.setInputFiles('#d64-input', { name: disk.name, mimeType: 'application/octet-stream', buffer: fs.readFileSync(disk.file) });
  console.log('  +', disk.name);
  await sleep(1200);                       // let the IndexedDB write settle
}
await sleep(800);

// ── Save-States: import each .c64state (one at a time — handler reads files[0]) ─
if (STATES.length) {
console.log('\n[save-states] importing states');
await click(page, '#btn-load-state');
await page.waitForSelector('#state-modal:not([hidden])', { timeout: 5000 });
for (const st of STATES) {
  const sample = JSON.parse(fs.readFileSync(st.file, 'utf8'));
  sample.name = st.name; sample.savedAt = Date.now() - st.days * 86400000;
  const before = await rowCount(page, '#state-list');
  await page.setInputFiles('#state-import-input', { name: `${st.name}.c64state`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(sample)) });
  // Wait until the list re-renders with the new row (import is async).
  await page.waitForFunction(
    (n) => document.querySelectorAll('#state-list .lib-row').length > n,
    before, { timeout: 8000 },
  ).catch(() => console.error('    (row did not appear:', st.name, ')'));
  console.log('  +', st.name);
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
