// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Capture the brand media that carries the app header (logo + tagline): the
// social-preview image and the two large screenshots used by the README and the
// splash page. These were hand-captured before, which is why a tagline change
// left them stale.
//
// Drives the LIVE dev server (http://localhost:5173) in headless Chromium via
// Playwright, exactly like tools/guide-shots.mjs — same localStorage seeding, so
// the splash and PWA card stay out of frame and Retro Vibes uses the lighter
// model that software WebGL can render.
//
//   node tools/brand-shots.mjs [baseURL] [outSuffix]
//
// outSuffix is appended before the extension, because a cached image must change
// filename to be refetched — Facebook keeps the old bytes under the old og: URL
// indefinitely, and GitHub's camo proxy does the same to a README shot. It only
// applies to shots that don't pin their own `suffix`, which by now is none of
// them: each asset is bumped when its own picture goes stale, so they sit at
// different versions (see the SHOTS table).
//
// BRAND_ONLY=og,vibes (env, comma-separated) captures a subset.
// HERO=az,el,dist (env, degrees + distance multiplier) overrides the camera pose
// while dialling a new one in; SCENE=n does the same for the Retro Vibes scene.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { saveShot } from './guide-image.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || 'http://localhost:5173';
const SUFFIX = process.argv[3] || '-v2';
const ONLY = (process.env.BRAND_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const want = n => ONLY.length === 0 || ONLY.includes(n);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Retro Vibes hero pose, as an orbit around the viewer's own target (the monitor
// screen). The app's default view is a raised 3/4 angle; these shots want it low,
// down at desk height, with the room behind the setup. The camera looks from +Z,
// so the azimuth SIGN picks which way the backdrop swings. It decided the lockup's
// legibility while these two shots were the bedroom — at +az the window's blinds
// sat behind the tagline and swallowed it — and on Spotlight's black backdrop it
// only chooses which side the drive and joystick fall. distMul scales the app's
// framing distance (<1 = closer).
const HERO = (() => {
  const [az, el, distMul] = (process.env.HERO || '-24,10,0.97').split(',').map(Number);
  return { az, el, distMul };
})();

// The wordmark + tagline is composited into the frame — the viewer itself carries
// no branding. Same asset the site header uses, so it can never drift from it.
const LOGO = { src: '/logos/c64ready-logo-tagline.png', width: '53%', top: '2.4%', right: '0.9%' };

// Retro Vibes scene index (src/retrovibes.js SCENES): 0 Synthwave, 1 Starry
// Plain, 2 Spotlight, 3 IK+ Sunset, 4 80s Bedroom. Per-shot `scene` overrides it.
const SCENE = Number(process.env.SCENE ?? 4);

// name → { out, width, height, scale, vibes, hero?, logo?, scene?, suffix?, webp?, bare? }
// Widths/heights are the CSS pixels that, at the given scale, reproduce each
// asset's existing pixel dimensions. hero / logo override HERO / LOGO per shot,
// suffix overrides SUFFIX — only the social card has to change filename to be
// re-scraped, so the others keep theirs and stay wired up as they are. `webp`
// encodes through guide-image.mjs at that width instead of writing the raw PNG,
// and `bare` drops both the lockup and the viewer's own chrome, for art that
// sits inside someone else's layout rather than standing alone.
const SHOTS = {
  // The social card is far wider than the screenshots and gets scaled down to a
  // few hundred pixels, so it stands the camera off a little further and carries a
  // wider lockup, which keeps the wordmark readable at feed size.
  og:       { out: 'c64rdy-3d-vibes-sm',        width: 1200, height: 630,  scale: 1, vibes: true,
              suffix: '-v4', scene: 2,
              hero: { distMul: 1.0 },
              logo: { width: '57%', top: '1.4%', right: '2.4%' } },
  // WebP, unlike the social card: this one is read by GitHub's markdown renderer
  // and by our own docs page, both of which decode it, so a 2000px shot need not
  // be a multi-megabyte PNG.
  vibes:    { out: 'screens/c64rdy-3d-vibes',   width: 1000, height: 628,  scale: 2, vibes: true,
              suffix: '-v4', scene: 2, webp: 2000 },
  emulator: { out: 'screens/c64rdy-emulator',   width: 1512, height: 803,  scale: 2, vibes: false,
              suffix: '-v4' },
  // Splash card art: it sits in the landing page's own card, captioned there, so
  // it carries no lockup and no viewer chrome — and it moves in close, because at
  // card size the whole desk would read as clutter around a tiny screen. Nearly
  // square-on (-4) rather than the others' angled -24, so the READY screen reads
  // straight and the room — lamp, window, posters — frames it either side.
  splash:   { out: 'screens/splash-vibes',      width: 800,  height: 450,  scale: 2, vibes: true,
              suffix: '', webp: 800, bare: true,
              hero: { az: -4, el: 10, distMul: 0.65 } },
};

const browser = await chromium.launch();
const done = [];

for (const [name, s] of Object.entries(SHOTS)) {
  if (!want(name)) continue;
  const ctx = await browser.newContext({
    viewport: { width: s.width, height: s.height },
    deviceScaleFactor: s.scale,
  });
  await ctx.addInitScript((scene) => {
    try {
      localStorage.setItem('c64emu.installDismissed', '1');
      localStorage.setItem('c64emu.splashSeen', '1');
      localStorage.setItem('c64emu.vibesModel', 'small');
      localStorage.setItem('c64emu.sizeMode', '15x');               // bigger picture than the 1X default
      localStorage.setItem('c64emu.modelViewerScene', scene);
      localStorage.setItem('c64emu.modelViewerAutoRotate', '0');   // a drifting spin would pick a random azimuth
      localStorage.removeItem('c64emu.modelViewerCamera');         // ignore any saved hand-posed view
    } catch {}
  }, String(process.env.SCENE != null ? SCENE : (s.scene ?? SCENE)));
  const page = await ctx.newPage();
  page.on('pageerror', e => console.error('  page error:', e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#screen', { timeout: 20000 });
  // Power on: these shots are of a running machine, not a dark screen.
  await page.waitForSelector('#btn-power:not([disabled])', { timeout: 20000 });
  await page.click('#btn-power');
  await page.waitForSelector('body.powered-on', { timeout: 8000 }).catch(() => {});
  await sleep(3500);                                     // boot to READY and settle

  if (s.vibes) {
    await page.click('#btn-vibes');
    await page.waitForFunction(() => {
      const l = document.querySelector('.model-viewer-loading');
      return !l || getComputedStyle(l).display === 'none';
    }, { timeout: 60000 });
    await sleep(4000);                                   // scene render + first frames

    // Pose the camera. Orbit maths inline rather than through THREE, which the
    // page does not expose globally.
    const posed = await page.evaluate(({ az, el, distMul }) => {
      const mv = window.modelViewer;
      if (!mv?.camera || !mv?.controls) return null;
      const cam = mv.camera, t = mv.controls.target;
      const d = cam.position.distanceTo(t) * distMul;
      const a = az * Math.PI / 180, e = el * Math.PI / 180;
      cam.position.set(
        t.x + d * Math.sin(a) * Math.cos(e),
        t.y + d * Math.sin(e),
        t.z + d * Math.cos(a) * Math.cos(e),
      );
      cam.lookAt(t);
      mv.controls.autoRotate = false;
      mv.controls.minDistance = Math.min(mv.controls.minDistance, d * 0.95);
      mv.controls.maxDistance = Math.max(mv.controls.maxDistance, d * 1.05);
      mv.controls.update();
      return { d: +d.toFixed(2) };
    }, { ...HERO, ...(s.hero || {}) });
    if (!posed) console.error('  ! window.modelViewer unavailable — camera left at the default angle');
    await sleep(1200);                                   // damping settles, sun bands advance

    if (s.bare) await page.evaluate(() => {
      for (const sel of ['.model-viewer-hint', '.model-viewer-credit', '.model-viewer-scene',
                         '.model-viewer-fullscreen', '.model-viewer-vr', '.model-viewer-close']) {
        const el = document.querySelector(sel);
        if (el) el.style.display = 'none';
      }
    });

    // Composite the brand lockup, which the viewer chrome does not provide.
    if (!s.bare) await page.evaluate(async (L) => {
      const host = document.querySelector('.model-viewer-overlay');
      const img = document.createElement('img');
      img.src = L.src;
      img.alt = '';
      img.style.cssText = `position:absolute;top:${L.top};right:${L.right};width:${L.width};` +
                          'height:auto;z-index:50;pointer-events:none';
      host.appendChild(img);
      await img.decode();
      // Nearest-neighbour keeps the pixel font crisp when the lockup lands at or
      // above its native width; below it, nearest-neighbour would drop whole
      // stems, so let the browser resample.
      img.style.imageRendering = img.getBoundingClientRect().width >= img.naturalWidth
        ? 'pixelated' : 'auto';
    }, { ...LOGO, ...(s.logo || {}) });
    await sleep(150);
  }

  const base = path.join(ROOT, `public/${s.out}${s.suffix ?? SUFFIX}`);
  fs.mkdirSync(path.dirname(base), { recursive: true });
  // The 80s Bedroom (two 2048² shadow maps + bloom) renders a frame slowly
  // enough under software WebGL that the 30s default can expire mid-capture.
  const png = await page.screenshot({ timeout: 180000 });
  let rel, kb, size;
  if (s.webp) {
    const info = saveShot(png, base, s.webp);
    rel = path.relative(ROOT, info.path);
    kb = Math.round(info.bytes / 1024);
    size = `${info.width}x${Math.round(info.width * s.height / s.width)}`;
  } else {
    rel = `public/${s.out}${s.suffix ?? SUFFIX}.png`;
    fs.writeFileSync(path.join(ROOT, rel), png);
    kb = Math.round(png.length / 1024);
    size = `${s.width * s.scale}x${s.height * s.scale}`;
  }
  console.log(`  ✓ ${name.padEnd(9)} ${size}  ${String(kb).padStart(5)} KB  → ${rel}`);
  done.push(rel);
  await ctx.close();
}

await browser.close();
console.log(`\n${done.length} captured. Wire the new filenames into index.html / README.md once the look is approved.`);
