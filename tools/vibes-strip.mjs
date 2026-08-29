// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Stitch the 3 guide shots (hero/wide/low) of each Retro Vibes scene into a
// horizontal strip: 1280x800 panes box-downscaled 2x -> 640x400, 6px gutters.
// Usage: node tools/vibes-strip.mjs <inDir> <outDir> [slug...]
// Naming slugs restitches only those, matching vibes-guide-shots.mjs, so a
// re-shoot of one scene does not need the other four PNGs to be present.
import { PNG } from 'pngjs';
import fs from 'node:fs';
import { saveGuideShot, shotLabel } from './guide-image.mjs';
import { collectionDir } from '../test/external-assets.js';

const inDir = (process.argv[2] || collectionDir('vibes-guide-work')).replace(/\/$/, '');
const outDir = (process.argv[3] || 'public/guide').replace(/\/$/, '');
const SLUGS = ['synthwave', 'starry-plain', 'spotlight', 'ikplus', '80s-bedroom'];
const MODES = ['hero', 'close', 'low'];
const GUT = 6, BG = [11, 11, 18];

const want = process.argv.slice(4);
for (const s of want) {
  if (!SLUGS.includes(s)) { console.error(`unknown scene "${s}" — one of: ${SLUGS.join(', ')}`); process.exit(1); }
}
const PICK = want.length ? want : SLUGS;

const half = (src) => {
  const w = src.width >> 1, h = src.height >> 1;
  const dst = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const di = (y * w + x) * 4;
    for (let k = 0; k < 4; k++) {
      let s = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        s += src.data[(((y * 2 + dy) * src.width) + x * 2 + dx) * 4 + k];
      }
      dst.data[di + k] = s >> 2;
    }
  }
  return dst;
};

for (const slug of PICK) {
  const panes = MODES.map((m) => half(PNG.sync.read(fs.readFileSync(`${inDir}/${slug}-${m}.png`))));
  const w = panes[0].width * 3 + GUT * 2, h = panes[0].height;
  const strip = new PNG({ width: w, height: h });
  for (let i = 0; i < strip.data.length; i += 4) {
    strip.data[i] = BG[0]; strip.data[i + 1] = BG[1]; strip.data[i + 2] = BG[2]; strip.data[i + 3] = 255;
  }
  panes.forEach((p, k) => {
    const x0 = k * (p.width + GUT);
    for (let y = 0; y < p.height; y++) {
      p.data.copy(strip.data, (y * w + x0) * 4, y * p.width * 4, (y + 1) * p.width * 4);
    }
  });
  const name = `retro-vibes-${slug}`;
  console.log('wrote', shotLabel(name, saveGuideShot(PNG.sync.write(strip), outDir, name)), `${w}x${h}`);
}
