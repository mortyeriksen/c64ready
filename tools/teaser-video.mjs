// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Optimise a screen recording into the splash screen's teaser loop, and cut its
// poster from the same footage so the two can never show different frames.
//
//   node tools/teaser-video.mjs <source> [outDir]
//
// outDir defaults to public/media/, giving c64ready-teaser.mp4 and
// c64ready-teaser-poster.webp. Both are referenced with a ?v= query (index.html
// and src/splash.js) — bump it there when the artwork changes, because /media/*
// is served immutable.
//
// What the encode is for: a muted, looping, autoplaying background video on a
// first-visit page. That dictates the settings.
//   • 16:9 CROP, ANCHORED TO THE BOTTOM. .splash-media is `aspect-ratio: 16/9`
//     with `object-fit: cover` (src/styles-splash.css), so the browser crops to
//     16:9 no matter what it is given; doing it here spends no bytes on rows the
//     page never shows. Taking the crop off the TOP rather than centring it is
//     what keeps the viewer's own chrome out of frame: Retro Vibes puts round
//     buttons in both top corners, and a centred crop cuts them in half at the
//     frame edge. The bottom of the recording — the drag/zoom hint line — stays,
//     as it did in the hand-made teaser this replaced.
//   • NO AUDIO. The element is muted and the sound lives on YouTube, which the
//     frame links out to. An audio track would be downloaded and never heard.
//   • +faststart puts the moov atom first, so playback can begin before the file
//     has arrived — the splash starts the loop the moment it opens.
//   • CRF, not a target bitrate: a dark, slow 3D scene needs far fewer bits than
//     a busy one, and the point is the smallest file at a fixed quality rather
//     than a predictable size. veryslow costs seconds on a clip this short.
//   • yuv420p + High profile is what Safari and iOS will decode, which is the
//     main funnel for the splash.
//
// The defaults are 1280x720 at crf 17, which measured at 1.45 MiB for a 14 s
// clip. 960x540 was the old asset's size and is too few pixels for the PETSCII
// text on the modelled monitor — it goes soft, and the screen is the subject.
// Dropping to crf 20 at the same width more than halves the file (0.89 MiB) if a
// future clip runs long enough to need it.
//
// Overrides, all env: TEASER_WIDTH (default 1280), TEASER_FPS (30), TEASER_CRF
// (17), POSTER_AT (seconds into the clip, default 3), POSTER_WIDTH (0 = the
// source's own width, which is the default).
// Needs `ffmpeg` and `ffprobe` on PATH (brew install ffmpeg), and `cwebp` for the
// poster (brew install webp), as the guide shots do.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { saveShot } from './guide-image.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2];
const OUT_DIR = path.resolve(ROOT, process.argv[3] || 'public/media');

if (!SRC) {
  console.error('usage: node tools/teaser-video.mjs <source> [outDir]');
  process.exit(1);
}
if (!fs.existsSync(SRC)) {
  console.error(`no such file: ${SRC}`);
  process.exit(1);
}

const WIDTH = Number(process.env.TEASER_WIDTH || 1280);
const FPS = Number(process.env.TEASER_FPS || 30);
const CRF = Number(process.env.TEASER_CRF || 17);
const POSTER_AT = Number(process.env.POSTER_AT || 3);
// 0 = the source's own width, i.e. no downscale at all.
const POSTER_WIDTH = Number(process.env.POSTER_WIDTH || 0) || Infinity;
const HEIGHT = Math.round(WIDTH * 9 / 16 / 2) * 2;

const run = (bin, args) => execFileSync(bin, args, { maxBuffer: 32 * 1024 * 1024 }).toString();
for (const bin of ['ffmpeg', 'ffprobe']) {
  try { run(bin, ['-version']); } catch {
    console.error(`${bin} not found on PATH — install it with \`brew install ffmpeg\``);
    process.exit(1);
  }
}

// One ffprobe for everything the log line needs.
const probe = (file) => {
  const out = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,codec_name',
    '-show_entries', 'format=duration,size', '-of', 'json', file]);
  const j = JSON.parse(out);
  const s = j.streams?.[0] || {};
  const [num, den] = (s.r_frame_rate || '0/1').split('/').map(Number);
  return {
    width: s.width, height: s.height, codec: s.codec_name,
    fps: den ? num / den : 0,
    duration: Number(j.format?.duration || 0),
    bytes: Number(j.format?.size || 0),
  };
};
const mib = (b) => `${(b / 1024 / 1024).toFixed(2)} MiB`;
const describe = (p) => `${p.width}x${p.height} ${p.codec} ${p.fps.toFixed(0)}fps ` +
                        `${p.duration.toFixed(1)}s ${mib(p.bytes)}`;

const src = probe(SRC);
console.log(`source  ${describe(src)}`);

// The 16:9 window, computed from the probed size rather than in ffmpeg's own
// expression language — the arithmetic has a condition in it and is worth being
// able to read. Both dimensions come out even, which yuv420p requires.
//
// TRIM_TOP is the fraction of the source's height that MUST fall away above the
// window. A 16:9 window's height is pinned by its width, so clearing the round
// chrome buttons in the top corners costs a little width: the tool takes the
// widest window whose top edge is low enough, and anchors it to the bottom of the
// frame so the hint line survives. At the default 0.14 that is about 1% of the
// width on a 1670x1078 recording — invisible, and no half-buttons.
const TRIM_TOP = Number(process.env.TRIM_TOP ?? 0.14);
const crop = (() => {
  const iw = src.width, ih = src.height;
  const minTrim = Math.round(ih * TRIM_TOP);
  let h = Math.floor((ih - minTrim) / 2) * 2;
  let w = Math.floor(h * 16 / 9 / 2) * 2;
  if (w > iw) {                       // source is narrower than the trimmed window
    w = Math.floor(iw / 2) * 2;
    h = Math.floor(w * 9 / 16 / 2) * 2;
  }
  return { w, h, x: Math.floor((iw - w) / 2), y: ih - h };
})();
const CROP = `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`;
const CHAIN = `${CROP},scale=${WIDTH}:${HEIGHT}:flags=lanczos,fps=${FPS}`;
console.log(`crop    ${crop.w}x${crop.h} +${crop.x}+${crop.y}  (${crop.y} rows off the top)`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const mp4 = path.join(OUT_DIR, 'c64ready-teaser.mp4');
const posterBase = path.join(OUT_DIR, 'c64ready-teaser-poster');

run('ffmpeg', ['-v', 'error', '-y', '-i', SRC,
  '-an',                                    // muted element: an audio track is dead weight
  '-vf', CHAIN,
  '-c:v', 'libx264', '-preset', 'veryslow', '-crf', String(CRF),
  '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart',
  mp4]);

// The poster comes out of the ORIGINAL recording, not the encode above, so it
// carries none of the video's compression — it is the one still frame a visitor
// looks at before the loop starts, and on a reduced-motion visit it is all they
// ever see. Same crop, so it lines up with the loop's own framing, but no scale:
// at the source's native width it stays sharp on a 2x display, where the 1280
// video cannot be. PNG out of ffmpeg on a pipe, then through the repo's own WebP
// encoder, which tries lossless and lossy and keeps whichever is smaller.
const at = Math.min(POSTER_AT, Math.max(0, src.duration - 0.1));
const framePng = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', SRC,
  '-frames:v', '1', '-vf', CROP, '-c:v', 'png', '-f', 'image2pipe', '-'],
  { maxBuffer: 64 * 1024 * 1024 });
const poster = saveShot(framePng, posterBase, POSTER_WIDTH);

const out = probe(mp4);
const saved = src.bytes ? Math.round((1 - out.bytes / src.bytes) * 100) : 0;
console.log(`teaser  ${describe(out)}  (${saved}% smaller, crf ${CRF})`);
console.log(`poster  ${poster.width}px webp ${poster.mode} ` +
            `${Math.round(poster.bytes / 1024)} KiB  @ ${at}s`);
console.log(`\nBump the ?v= on both in index.html and src/splash.js — /media/* is immutable.`);
