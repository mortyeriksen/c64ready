// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// CRT preset check: shoots every preset in the live app at several picture
// sizes and device pixel ratios and asserts the one rule the presets must obey,
// that the pattern is locked to the raster. Over the solid border, row
// luminance repeats exactly once per raster line (row r equals row r + k·P
// with P device pixels per line), and columns are flat or repeat with the
// phosphor mask's triad: 3 stripes of ceil(P / 3) device pixels, so one triad
// spans about one emulated pixel. OFF must be flat both ways.
//
//   node tools/crt-check.mjs [baseURL]        default http://localhost:5173
//
// Drives the LIVE dev server in headless Chromium via Playwright; ROMs come
// from the registry (test/external-assets.json) and are served to the page
// from there, so nothing is copied into public/. Shots, magnified crops and
// stats.json land in CRT_OUT (default investigation/crt-shots/after).
//
//   CRT_PATHS=shader,css,2d   which render paths to shoot (default all: the
//                             shader, ?CRT_SHADER=0, ?WEBGL_PRESENTER=0)
//   CRT_SIZES=2x,25x,3x       picture sizes (default 2x,25x)
//   CRT_DPRS=1,2              device pixel ratios (default 1,2)
//   CRT_MODES=off,on,...      presets (default all six)
//
// Output is TAP-style so the lines read like the test runner's: one ok / not ok
// per check, # SKIP when the server or the ROMs are missing.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assetPath } from '../test/external-assets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || 'http://localhost:5173';
const OUT = path.resolve(process.env.CRT_OUT || path.join(root, 'investigation', 'crt-shots', 'after'));
const list = (env, dflt) => (process.env[env] || dflt).split(',').map(s => s.trim()).filter(Boolean);
const PATHS = list('CRT_PATHS', 'shader,css,2d');
const SIZES = list('CRT_SIZES', '2x,25x');
const DPRS = list('CRT_DPRS', '1,2').map(Number);
const MODES = list('CRT_MODES', 'off,on,tube,bw,arcade,hum');
// The shader path is forced on even where headless Chromium falls back to
// SwiftShader, so the check measures the shader, not the machine's GPU.
const QUERY = { shader: '&CRT_SHADER_SOFTWARE=1', css: '&CRT_SHADER=0', '2d': '&WEBGL_PRESENTER=0' };
const RASTER_LINES = 272;

const roms = {};
for (const [file, asset] of Object.entries({ 'kernal.bin': 'kernal', 'basic.bin': 'basic', 'chargen.bin': 'chargen', '1541.bin': 'drive1541' })) {
  const p = assetPath(asset);
  if (!p || !fs.existsSync(p)) { console.log(`# SKIP ROM ${asset} not in the registry`); process.exit(0); }
  roms['/roms/' + file] = fs.readFileSync(p);
}
try { await fetch(BASE); } catch { console.log(`# SKIP dev server not running at ${BASE}`); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const results = [];
let failed = 0;
const report = (ok, text) => { console.log(`${ok ? 'ok  ' : 'not ok'} - ${text}`); if (!ok) failed++; };

for (const renderPath of PATHS) for (const dpr of DPRS) for (const size of SIZES) for (const mode of MODES) {
  const name = `${mode}-${size}-dpr${dpr}-${renderPath}`;
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: dpr, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (roms[url.pathname]) return route.fulfill({ body: roms[url.pathname], contentType: 'application/octet-stream' });
    if (url.origin === new URL(BASE).origin) return route.continue();
    return route.abort();
  });
  await page.addInitScript(([mode, size]) => {
    localStorage.setItem('c64emu.splashSeen', '1');
    localStorage.setItem('c64emu.installDismissed', '1');
    localStorage.setItem('c64emu.pauseDemo', 'off');
    localStorage.setItem('c64emu.tde', 'off');
    localStorage.setItem('c64emu.crtMode', mode);
    localStorage.setItem('c64emu.sizeMode', size);
  }, [mode, size]);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e).split('\n')[0]));
  await page.goto(`${BASE}/?SPLASH=0${QUERY[renderPath]}`, { waitUntil: 'networkidle' });
  await page.keyboard.press('Escape');
  await page.waitForSelector('#btn-power:not([disabled])', { timeout: 20000 });
  await page.click('#btn-power');
  await page.waitForTimeout(4000);

  const bezel = page.locator('.crt-bezel');
  const png = await bezel.screenshot({ path: path.join(OUT, `${name}.png`) });
  const info = await page.evaluate(() => ({
    body: document.body.className,
    canvas: `${document.getElementById('screen').width}x${document.getElementById('screen').height}`,
  }));

  // Border strip: left 1%-5% of the width, rows 20%-60% of the height (solid
  // light blue), read back from the PNG in the page for its image decoder.
  const stats = await page.evaluate(async ({ png }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + png;
    await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const lum = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const x0 = Math.floor(c.width * 0.01), x1 = Math.floor(c.width * 0.05);
    const y0 = Math.floor(c.height * 0.20), y1 = Math.floor(c.height * 0.60);
    const rows = [];
    for (let y = y0; y < y1; y++) { let s = 0; for (let x = x0; x < x1; x++) s += lum((y * c.width + x) * 4); rows.push(s / (x1 - x0)); }
    const cols = [];
    for (let x = x0; x < x1; x++) { let s = 0; for (let y = y0; y < y1; y++) s += lum((y * c.width + x) * 4); cols.push(s / (y1 - y0)); }
    const summary = a => { const mn = Math.min(...a), mx = Math.max(...a), mean = a.reduce((p, q) => p + q, 0) / a.length; return { min: +mn.toFixed(1), max: +mx.toFixed(1), mean: +mean.toFixed(1), spread: +(mx - mn).toFixed(1) }; };
    return { w: c.width, h: c.height, rows, cols, rowStats: summary(rows), colStats: summary(cols) };
  }, { png: png.toString('base64') });

  // A 140x70 CSS-px crop at the READY text, magnified 5x (nearest) for viewing.
  const crop = await page.evaluate(async ({ png, dpr }) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + png; await img.decode();
    const sx = Math.floor(img.width * 0.06), sy = Math.floor(img.height * 0.20), sw = 140 * dpr, sh = 70 * dpr;
    const c = document.createElement('canvas'); c.width = sw * 5 / dpr; c.height = sh * 5 / dpr;
    const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
    g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c.toDataURL('image/png').split(',')[1];
  }, { png: png.toString('base64'), dpr });
  fs.writeFileSync(path.join(OUT, `${name}-crop.png`), Buffer.from(crop, 'base64'));
  await context.close();

  // The spec: device pixels per raster line P (a whole or half number here);
  // rows repeat every k·P device pixels once k·P is whole.
  const P = Math.round(stats.h / RASTER_LINES * 2) / 2;
  const period = Number.isInteger(P) ? P : Math.round(P * 2);
  const maxDiff = (a, per) => { let m = 0; for (let i = 0; i + per < a.length; i++) m = Math.max(m, Math.abs(a[i] - a[i + per])); return +m.toFixed(1); };
  const rowRepeat = maxDiff(stats.rows, period);
  const triad = 3 * Math.max(1, Math.ceil(P / 3 - 0.001));
  const colRepeat3 = maxDiff(stats.cols, triad);
  const flatTol = 1.5, repeatTol = 2.5;
  const label = `${mode} ${size} dpr${dpr} ${renderPath}`;
  report(errors.length === 0, `${label}: no page errors${errors.length ? ` (${errors[0]})` : ''}`);
  // A black strip would pass every periodicity check; the border is light blue.
  report(stats.rowStats.mean > 40, `${label}: the border shows the picture (mean ${stats.rowStats.mean})`);
  if (mode === 'off') {
    report(stats.rowStats.spread <= flatTol && stats.colStats.spread <= flatTol,
      `${label}: OFF border is flat (row spread ${stats.rowStats.spread}, col spread ${stats.colStats.spread})`);
  } else {
    report(rowRepeat <= repeatTol, `${label}: rows repeat every ${period} px = ${period / P} raster line(s) (max diff ${rowRepeat}, spread ${stats.rowStats.spread})`);
    report(stats.colStats.spread <= flatTol || colRepeat3 <= repeatTol,
      `${label}: columns flat or a ${triad} px mask triad (spread ${stats.colStats.spread}, repeat diff ${colRepeat3})`);
  }
  results.push({ name, ...info, w: stats.w, h: stats.h, P, rows: stats.rowStats, cols: stats.colStats, rowRepeat, colRepeat3, errors });
}
fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify(results, null, 1));
await browser.close();
console.log(`# ${results.length} shots → ${OUT}${failed ? `, ${failed} check(s) failed` : ''}`);
process.exit(failed ? 1 : 0);
