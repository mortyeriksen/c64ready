// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// One-off: capture the raster demo once per second for 10 s starting at the
// current overview-running position (~44 s in), so a human can pick the best
// frame for public/guide/overview-running.webp. Writes the frames + a labelled
// contact sheet to <outDir> (use a scratch dir, NOT the repo).
//
//   node tools/pick-frames.mjs <rasterDemoD64> <outDir> [baseSec] [nFrames]
//
// rasterDemoD64 is required and NOT part of the repo — bring your own .d64.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const RASTER = process.argv[2];
const OUT = process.argv[3];
if (!RASTER || !fs.existsSync(RASTER)) { console.error('usage: node tools/pick-frames.mjs <rasterDemoD64> <outDir> [baseSec] [nFrames] — .d64 not found:', RASTER || '(none given)'); process.exit(1); }
if (!OUT) { console.error('usage: node tools/pick-frames.mjs <rasterDemoD64> <outDir> [baseSec] [nFrames] — <outDir> required'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const BASE_SEC = +(process.argv[4] || 44);   // first second to capture
const N = +(process.argv[5] || 20);          // how many 1-second frames
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1460, height: 1180 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
await ctx.addInitScript(() => { try { localStorage.setItem('c64emu.installDismissed', '1'); localStorage.setItem('c64emu.vibesModel', 'small'); } catch {} });
const p = await ctx.newPage();
await p.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await p.waitForSelector('#btn-power:not([disabled])', { timeout: 20000 });
await p.locator('#btn-power').click();
await p.waitForSelector('body.powered-on').catch(() => {});
await sleep(3500);
const tde = p.locator('#btn-tde-toggle');
if (/ON/.test(await tde.textContent().catch(() => ''))) { await tde.click().catch(() => {}); await sleep(300); }
await p.setInputFiles('#d64-input', RASTER);
await sleep(2500);            // autoload + RUN hand off to the demo
await sleep(BASE_SEC * 1000); // reach the current position

async function cropOverview(file) {
  const bottom = await p.evaluate(() => { const mw = document.querySelector('.main-wrap'); return mw ? Math.ceil(mw.getBoundingClientRect().bottom) : 0; });
  const height = Math.min(1180, (bottom || 1180) + 24);
  await p.screenshot({ path: file, clip: { x: 0, y: 0, width: 1460, height } });
}

const t0 = Date.now();       // == demo ~BASE_SEC; align captures to real seconds
const secs = [];
for (let i = 0; i < N; i++) {
  const wait = i * 1000 - (Date.now() - t0);
  if (wait > 0) await sleep(wait);
  const sec = BASE_SEC + i;
  secs.push(sec);
  await p.locator('.crt-bezel').screenshot({ path: path.join(OUT, `screen-${sec}.png`) });
  await cropOverview(path.join(OUT, `run-${sec}.png`));
  console.log('  captured', sec + 's');
}

// Labelled contact sheet of the screen crops.
const cells = secs.map((s) => {
  const b64 = fs.readFileSync(path.join(OUT, `screen-${s}.png`)).toString('base64');
  return `<figure><figcaption>${s}s</figcaption><img src="data:image/png;base64,${b64}"></figure>`;
}).join('');
const html = `<!doctype html><meta charset=utf-8><style>
body{margin:0;background:#05060f;font-family:monospace;padding:18px}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
figure{margin:0;background:#0b0e24;border:1px solid #2c2f63;border-radius:8px;padding:8px}
figcaption{color:#8fe985;font-size:26px;margin-bottom:6px;font-weight:bold}
img{width:100%;height:auto;display:block}
</style><div class="grid">${cells}</div>`;
await p.setContent(html, { waitUntil: 'networkidle' });
await p.screenshot({ path: path.join(OUT, 'contact.png'), fullPage: true });
await b.close();
console.log('contact sheet →', path.join(OUT, 'contact.png'));
