// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Build a looping animation of JUST the Datasette control card while a .tap
// loads (motor running, progress bar filling, timer ticking) for the guide's
// Datasette section. Captures the #datasette-card element only — not the
// emulator screen — over ~10 s, then encodes an animated WebP.
//
//   node tools/datasette-anim.mjs [tapPath] [outWebp]
//
// The tape resolves from test/external-assets.json ('demo-tape', or the
// C64_DEMO_TAP env var) — like every other guide tool, run it with no args; a path
// argument overrides. The tape is NOT part of the repo. Use a few-minute one: the
// bar is drawn against the whole tape, so a short tape jumps across the ~10 s
// capture. outWebp defaults to public/guide/datasette-loading.webp. Needs the
// `img2webp` binary on PATH (brew install webp), which also spares a GIF encoder
// dependency: a palette-free animation is ~30x smaller than the dithered GIF.
import { chromium } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { assetPath } from '../test/external-assets.js';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// Argument first, else the registry — same resolution order as the other guide tools.
const TAP = process.argv[2] || assetPath('demo-tape') || '';
const OUT = process.argv[3] || path.join(REPO, 'public/guide/datasette-loading.webp');
const FRAMES = path.join(os.tmpdir(), 'ds-frames');
fs.mkdirSync(FRAMES, { recursive: true });
if (!TAP || !fs.existsSync(TAP)) {
  console.error('usage: node tools/datasette-anim.mjs [tapPath] [outWebp]');
  console.error(`no .tap: ${TAP || "registry entry 'demo-tape' resolved to nothing"}`);
  process.exit(1);
}
console.log(`tape: ${TAP}`);

const N = 50;                     // frames
const INTERVAL = 200;             // ms between frames → ~10 s of loading
const OUT_W = 760;                // downscale target width
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1460, height: 1180 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
// splashSeen too: the splash covers the page and its teaser video swallows the
// POWER click.
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('c64emu.installDismissed', '1');
    localStorage.setItem('c64emu.splashSeen', '1');
  } catch {}
});
const p = await ctx.newPage();
await p.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await p.waitForSelector('#btn-power:not([disabled])', { timeout: 20000 });
await p.locator('#btn-power').click();
await p.waitForSelector('body.powered-on').catch(() => {});
await sleep(3500);                // boot to READY.

// Expand the Datasette card so the transport + bar are visible.
if (await p.locator('#datasette-card:not(.expanded)').count()) { await p.locator('#datasette-card .expand-btn').click(); await sleep(400); }
const card = p.locator('#datasette-card');

// Insert the tape — running + AUTORUN auto-runs LOAD + PLAY (_autoLoadTape),
// so the motor spins and the bar starts filling on its own.
await p.setInputFiles('#tap-input', TAP);

const t0 = Date.now();            // align captures to a steady grid
for (let i = 0; i < N; i++) {
  const wait = i * INTERVAL - (Date.now() - t0);
  if (wait > 0) await sleep(wait);
  await card.screenshot({ path: path.join(FRAMES, `f${String(i).padStart(3, '0')}.png`) });
}
await b.close();
console.log(`captured ${N} frames`);

// ── encode ──────────────────────────────────────────────────────────────
function resize(src, sw, sh, dw, dh) {
  const dst = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) * sh / dh - 0.5;
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(sh - 1, y0 + 1), fy = sy - Math.floor(sy);
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * sw / dw - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(sw - 1, x0 + 1), fx = sx - Math.floor(sx);
      const di = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = src[(y0 * sw + x0) * 4 + c], p01 = src[(y0 * sw + x1) * 4 + c];
        const p10 = src[(y1 * sw + x0) * 4 + c], p11 = src[(y1 * sw + x1) * 4 + c];
        const top = p00 + (p01 - p00) * fx, bot = p10 + (p11 - p10) * fx;
        dst[di + c] = Math.round(top + (bot - top) * fy);
      }
    }
  }
  return dst;
}
const files = fs.readdirSync(FRAMES).filter((f) => f.endsWith('.png')).sort();
const first = PNG.sync.read(fs.readFileSync(path.join(FRAMES, files[0])));
const W = Math.min(OUT_W, first.width), H = Math.round(first.height * W / first.width);
console.log(`card ${first.width}x${first.height} → ${W}x${H}, ${files.length} frames`);
// img2webp encodes the frames as given, so scale them here first.
const SCALED = path.join(os.tmpdir(), 'ds-frames-scaled');
fs.rmSync(SCALED, { recursive: true, force: true });
fs.mkdirSync(SCALED, { recursive: true });
const scaled = files.map((f) => {
  const png = PNG.sync.read(fs.readFileSync(path.join(FRAMES, f)));
  const out = path.join(SCALED, f);
  if (W === png.width) { fs.copyFileSync(path.join(FRAMES, f), out); return out; }
  const dst = new PNG({ width: W, height: H });
  Buffer.from(resize(png.data, png.width, png.height, W, H)).copy(dst.data);
  fs.writeFileSync(out, PNG.sync.write(dst));
  return out;
});
execFileSync('img2webp', ['-loop', '0', '-d', String(INTERVAL), '-q', '82', '-m', '6', ...scaled, '-o', OUT], { stdio: 'ignore' });
fs.rmSync(SCALED, { recursive: true, force: true });
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KiB)`);
