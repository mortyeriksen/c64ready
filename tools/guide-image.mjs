// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Shared output step for the guide/ screenshots (guide-shots.mjs and friends).
//
// Playwright captures at deviceScaleFactor 2 for crisp text, which is far more
// pixels than a doc page ever displays, so every shot is capped at 1920 px wide
// (downscaled from the 2× grab, never enlarged) and encoded as WebP. Both WebP
// modes are tried and the smaller file wins: flat UI panels compress best
// lossless, while the 3D Retro Vibes scenes and downscaled overviews are
// photographic and want lossy.
//
// Playwright only ever hands back PNG or JPEG, so a PNG capture is unavoidable —
// but it stays in memory: cwebp reads it on stdin and returns the WebP on stdout,
// so the only file written is the shot itself.
//
// Needs the `cwebp` binary on PATH (brew install webp).
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export const MAX_WIDTH = 1920;
const QUALITY = 90;


let checked = false;
function requireCwebp() {
  if (checked) return;
  try {
    execFileSync('cwebp', ['-version'], { stdio: 'ignore' });
  } catch {
    throw new Error('cwebp not found on PATH — install it with `brew install webp`');
  }
  checked = true;
}

const pngWidth = (buf) => buf.readUInt32BE(16);

// '--' then '-' is cwebp's read-stdin form; '-o -' writes the result to stdout.
// The lossless pass of a full-page 3D shot is ~1 MB, over execFileSync's default
// stdout cap.
const encode = (pngBuffer, resize, extra) =>
  execFileSync('cwebp', ['-quiet', ...extra, ...resize, '-o', '-', '--', '-'], {
    input: pngBuffer,
    maxBuffer: 64 * 1024 * 1024,
  });

// Write a captured PNG buffer as <outBase>.webp (path WITHOUT an extension).
// `maxWidth` caps the result, downscaling from the 2× grab, never enlarging — the
// guide's own 1920 by default, lower for an asset with a fixed display size.
// Returns what was written, for logging.
export function saveShot(pngBuffer, outBase, maxWidth = MAX_WIDTH) {
  requireCwebp();
  const width = pngWidth(pngBuffer);
  const resize = width > maxWidth ? ['-resize', String(maxWidth), '0'] : [];
  const lossless = encode(pngBuffer, resize, ['-lossless', '-z', '9']);
  const lossy = encode(pngBuffer, resize, ['-q', String(QUALITY), '-m', '6']);
  const best = lossless.length <= lossy.length ? lossless : lossy;
  const out = `${outBase}.webp`;
  fs.writeFileSync(out, best);
  return {
    path: out,
    bytes: best.length,
    mode: best === lossless ? 'lossless' : `q${QUALITY}`,
    width: Math.min(width, maxWidth),
  };
}

// Write a shot into a guide output dir by name, plus its screens/ mirror if it
// has one. Mirroring is skipped unless the tool is writing the tracked
// public/guide — a GUIDE_OUT scratch run must not touch public/.
export function saveGuideShot(pngBuffer, outDir, name) {
  const info = saveShot(pngBuffer, path.join(outDir, name));
  return info;
}

// One-line summary for a tool's per-shot log: "✓ overview  1920px q90 63 KiB".
export const shotLabel = (name, info) =>
  `${name}  ${info.width}px ${info.mode} ${Math.round(info.bytes / 1024)} KiB`;
