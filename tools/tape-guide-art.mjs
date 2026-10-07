// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Draws the diagrams of the Tape restoration guide (docs/TAPE-RESTORATION.md)
// as SVG files in public/guide/ (tape-*.svg). Each sits on its own dark panel,
// like the guide's screenshots, so it reads on the docs' light and dark pages.
//
// The numbers drawn are the decoder's own: the KERNAL's three pulse widths
// (384, 528 and 688 cycles), the 0.25 gate a crossing must clear
// (HYSTERESIS in src/media/wav-tape.js), and the mend's rule that two
// readings must agree byte for byte (src/media/wav-tape.js, mendTurbo).
//
//   node tools/tape-guide-art.mjs            writes public/guide/tape-*.svg,
//                                            and tape-pipeline.webp (needs cwebp)
//   GUIDE_OUT=dir node tools/tape-guide-art.mjs   writes them elsewhere
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchShotBrowser } from './shot-browser.mjs';
import { saveGuideShot, shotLabel } from './guide-image.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.GUIDE_OUT || path.join(ROOT, 'public/guide');

// The guide's dark palette: Classic's own colours.
const C = {
  bg: '#0b0e24', panel: '#11142e', line: '#2c2f63', text: '#ccd0ec', dim: '#8a8aa8',
  bright: '#ffffff', accent: '#9f9df2', green: '#8fe985', red: '#e8777c', amber: '#e6dd6b',
  wave: '#7fd4ff', wave2: '#c79bff',
};
const FONT = `font-family="ui-monospace, 'SF Mono', Menlo, Consolas, monospace"`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x, y, s, { size = 14, fill = C.text, anchor = 'start', weight = 400 } = {}) =>
  `<text x="${x}" y="${y}" ${FONT} font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
const rect = (x, y, w, h, { fill = C.panel, stroke = C.line, r = 8, sw = 1 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
const line = (x1, y1, x2, y2, { stroke = C.line, sw = 1, dash = '' } = {}) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const pathD = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
const arrow = (x1, y1, x2, y2, stroke = C.accent) => {
  const a = Math.atan2(y2 - y1, x2 - x1), h = 7;
  const p1 = [x2 - h * Math.cos(a - 0.45), y2 - h * Math.sin(a - 0.45)], p2 = [x2 - h * Math.cos(a + 0.45), y2 - h * Math.sin(a + 0.45)];
  return `${line(x1, y1, x2, y2, { stroke, sw: 1.6 })}<path d="M${x2},${y2} L${p1[0].toFixed(1)},${p1[1].toFixed(1)} L${p2[0].toFixed(1)},${p2[1].toFixed(1)} Z" fill="${stroke}"/>`;
};
function svg(w, h, title, desc, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<rect width="${w}" height="${h}" rx="12" fill="${C.bg}"/>
${body}
</svg>
`;
}
// A worn tape's signal: the head differentiates the written square wave, so a
// pulse reads back as a rounded swing, and hiss rides on it. One full swing,
// down and back up, is one pulse.
function tapeWave(widths, { x0, y0, amp, scale, noise = 0.06, seed = 7, fade = null }) {
  let s = seed; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  const pts = []; let x = x0;
  widths.forEach((w, i) => {
    const px = w * scale, n = Math.max(12, Math.round(px / 2));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const a = amp * (fade ? fade(i) : 1);
      const v = Math.sin(2 * Math.PI * t) * (0.85 + 0.15 * Math.sin(6 * Math.PI * t)) * a + rnd() * noise * amp;
      pts.push([x + t * px, y0 - v]);
    }
    x += px;
  });
  return { d: pathD(pts), end: x };
}

const files = {};

// 1. The pipeline: what the "Reading tape" dialog walks through, with the
// worn recording going in and clean pulses coming out. 16:9, since it is also
// the guide's share picture (a WebP copy, written below).
{
  const W = 1200, H = 675;
  const stages = [
    ['Read', 'the recording'], ['Measure', 'the signal'], ['Find', 'the pulses'], ['Line up', 'the channels'],
    ['Compare', 'the readings'], ['Mend', 'damaged files'], ['Read', 'the directory'],
  ];
  let body = text(W / 2, 78, 'From a worn cassette to a tape that loads', { size: 34, fill: C.bright, anchor: 'middle', weight: 600 });
  body += text(W / 2, 116, 'Seven passes, the same in the C64 READY. emulator and in c64rdy wav2tap', { size: 17, fill: C.dim, anchor: 'middle' });
  const bw = 136, gap = 22, x0 = (W - (stages.length * bw + (stages.length - 1) * gap)) / 2, y = 168;
  stages.forEach(([a, b], i) => {
    const x = x0 + i * (bw + gap);
    body += rect(x, y, bw, 96, { stroke: i === 5 ? C.green : C.line, sw: i === 5 ? 2 : 1.2, r: 10 });
    body += text(x + bw / 2, y + 30, `${i + 1}`, { size: 14, fill: C.dim, anchor: 'middle' });
    body += text(x + bw / 2, y + 58, a, { size: 19, fill: C.bright, anchor: 'middle', weight: 600 });
    body += text(x + bw / 2, y + 80, b, { size: 13, fill: C.text, anchor: 'middle' });
    if (i < stages.length - 1) body += arrow(x + bw + 3, y + 48, x + bw + gap - 3, y + 48);
  });
  // Before: a worn recording, hiss and a dropout. After: the clean pulses.
  const py = 318, ph = 230, pw = 500, lx = 60, rx = W - 60 - pw;
  body += rect(lx, py, pw, ph, { r: 12 }) + rect(rx, py, pw, ph, { r: 12, stroke: C.green, sw: 1.4 });
  body += text(lx + 24, py + 38, 'In: the worn recording', { size: 18, fill: C.wave, weight: 600 });
  body += text(lx + 24, py + 62, '.wav, mono or stereo, any sample rate  ·  or a DC2N .dmp', { size: 13, fill: C.dim });
  body += text(rx + 24, py + 38, 'Out: a .tap that loads', { size: 18, fill: C.green, weight: 600 });
  body += text(rx + 24, py + 62, 'clean pulses, at the widths the loader expects', { size: 13, fill: C.dim });
  const widths = [384, 528, 384, 688, 528, 384, 528, 384, 528, 384];
  const sc = 452 / widths.reduce((a, b) => a + b, 0), wy = py + 150;
  const worn = tapeWave(widths, { x0: lx + 24, y0: wy, amp: 50, scale: sc, noise: 0.22, seed: 5,
    fade: (i) => (i === 5 || i === 6 ? 0.25 : i === 4 || i === 7 ? 0.6 : 1) });
  body += line(lx + 24, wy, lx + 476, wy, { stroke: C.line, dash: '4 4' });
  body += `<path d="${worn.d}" fill="none" stroke="${C.wave}" stroke-width="2"/>`;
  body += text(lx + 24 + (widths.slice(0, 5).reduce((a, b) => a + b, 0) + 300) * sc, wy + 66, 'dropout', { size: 12, fill: C.red, anchor: 'middle' });
  // Clean square pulses: each one high for half its width, then low.
  const sq = []; let x = rx + 24; const top = wy - 44, bot = wy + 44;
  sq.push([x, bot]);
  for (const w of widths) { const px = w * sc; sq.push([x, top], [x + px / 2, top], [x + px / 2, bot], [x + px, bot]); x += px; }
  body += `<path d="${pathD(sq)}" fill="none" stroke="${C.green}" stroke-width="2.4"/>`;
  body += arrow(lx + pw + 14, py + ph / 2, rx - 14, py + ph / 2, C.green);
  // Verdicts, and the name.
  body += text(W / 2, H - 70, 'Every file gets a verdict:  readable  ·  mended  ·  unconfirmed  ·  damaged', { size: 16, fill: C.text, anchor: 'middle' });
  body += text(W / 2, H - 38, 'C64 READY.  ·  Tape restoration', { size: 14, fill: C.accent, anchor: 'middle', weight: 600 });
  files['tape-pipeline.svg'] = svg(W, H, 'From a worn cassette to a tape that loads', 'Seven stages in a row: read the recording, measure the signal, find the pulses, line up the channels, compare the readings, mend damaged files, read the directory. Below, a noisy recording with a dropout goes in on the left, and clean square pulses come out on the right as a .tap. Every file gets a verdict: readable, mended, unconfirmed or damaged.', body);
}

// 2. Anatomy of a pulse: crossings, the gate, and the KERNAL's three widths.
{
  const W = 960, H = 420;
  const widths = [384, 384, 528, 688, 528, 384, 528, 384];   // S S M L M S M S: a byte marker (L M), then bits
  const scale = 0.19, x0 = 70, y0 = 200, amp = 80;
  const { d, end } = tapeWave(widths, { x0, y0, amp, scale });
  let body = text(W / 2, 40, 'What a pulse is', { size: 22, fill: C.bright, anchor: 'middle', weight: 600 });
  body += text(W / 2, 66, 'A C64 tape stores data as the time between edges. One full swing, up and back down, is one pulse.', { size: 13, fill: C.dim, anchor: 'middle' });
  // The gate: a crossing counts only once the swing passes 0.25 of the level.
  const g = amp * 0.25;
  body += `<rect x="${x0}" y="${y0 - g}" width="${end - x0}" height="${2 * g}" fill="${C.accent}" opacity="0.10"/>`;
  body += line(x0, y0, end, y0, { stroke: C.accent, dash: '4 4' });
  body += text(end + 8, y0 + 4, 'centre', { size: 11, fill: C.accent });
  body += text(end + 8, y0 - g + 4, 'gate ±0.25', { size: 11, fill: C.accent });
  body += `<path d="${d}" fill="none" stroke="${C.wave}" stroke-width="2"/>`;
  // Crossings at each pulse boundary and mid-pulse; pulses bracketed below.
  let x = x0;
  const name = { 384: ['S', 'short'], 528: ['M', 'medium'], 688: ['L', 'long'] };
  const col = { 384: C.green, 528: C.amber, 688: C.red };
  widths.forEach((w) => {
    const px = w * scale;
    body += `<circle cx="${x}" cy="${y0}" r="3.5" fill="${C.bright}"/>`;
    body += `<circle cx="${x + px / 2}" cy="${y0}" r="2.5" fill="${C.dim}"/>`;
    const yb = y0 + amp + 34;
    body += line(x + 2, yb, x + px - 2, yb, { stroke: col[w], sw: 3 });
    body += line(x + 2, yb - 6, x + 2, yb + 6, { stroke: col[w], sw: 1.5 });
    body += line(x + px - 2, yb - 6, x + px - 2, yb + 6, { stroke: col[w], sw: 1.5 });
    body += text(x + px / 2, yb + 22, name[w][0], { size: 15, fill: col[w], anchor: 'middle', weight: 600 });
    body += text(x + px / 2, yb + 40, `${w}`, { size: 11, fill: C.dim, anchor: 'middle' });
    x += px;
  });
  body += `<circle cx="${x}" cy="${y0}" r="3.5" fill="${C.bright}"/>`;
  // Legend.
  const ly = H - 34;
  body += text(x0, ly, '● a pulse starts and ends where the wave crosses the centre going the same way', { size: 12, fill: C.text });
  body += text(x0, ly + 18, 'KERNAL widths, approx. CPU cycles:', { size: 12, fill: C.dim });
  body += text(x0 + 262, ly + 18, 'S 384', { size: 12, fill: C.green }) + text(x0 + 322, ly + 18, 'M 528', { size: 12, fill: C.amber }) + text(x0 + 382, ly + 18, 'L 688', { size: 12, fill: C.red });
  body += text(x0 + 448, ly + 18, '· a bit is a pair: S M = 0, M S = 1 · L M marks a byte', { size: 12, fill: C.dim });
  files['tape-pulses.svg'] = svg(W, H, 'What a pulse is', 'A noisy tape waveform swinging about a dashed centre line, with a shaded gate band at plus and minus a quarter of the level. Dots mark the centre crossings. Brackets under the wave measure each pulse, one full swing, and label it S 384, M 528 or L 688 cycles: the KERNAL tape format\'s short, medium and long pulses.', body);
}

// 3. Two channels: the head's azimuth lag, a plain average, and the lined-up one.
{
  const W = 960, H = 470;
  const widths = [384, 528, 384, 688, 528, 384, 384, 528];
  const scale = 0.17, x0 = 210, amp = 34, lag = 0.47;   // the right channel trails by about half a pulse
  const rows = [
    ['Left channel', 'one reading', C.wave, 0, 1],
    ['Right channel', 'the same tape, a little late', C.wave2, lag, 1],
    ['Plain average', 'out of step: swings cancel', C.red, 'avg', 1],
    ['Lined up, averaged', 'lag measured and removed', C.green, 0, 1.0],
  ];
  let body = text(W / 2, 40, 'Two channels are two readings', { size: 22, fill: C.bright, anchor: 'middle', weight: 600 });
  body += text(W / 2, 66, 'A stereo transfer reads the same track twice. A tilted head (azimuth) puts one channel a little behind the other.', { size: 13, fill: C.dim, anchor: 'middle' });
  rows.forEach(([a, b, col, shift, k], i) => {
    const yc = 128 + i * 88;
    body += text(30, yc - 4, a, { size: 14, fill: C.bright, weight: 600 }) + text(30, yc + 14, b, { size: 11, fill: C.dim });
    body += line(x0 - 10, yc, W - 30, yc, { stroke: C.line });
    let d;
    if (shift === 'avg') {
      // Left and lagged right summed: where they disagree the swing shrinks.
      const pts = []; let x = x0; const total = widths.reduce((s, w) => s + w * scale, 0);
      const L = (t) => { let acc = 0; for (const w of widths) { const px = w * scale; if (t < acc + px) return Math.sin(2 * Math.PI * (t - acc) / px); acc += px; } return 0; };
      for (let t = 0; t <= total; t += 1.5) {
        const r = L(t - lag * 384 * scale);
        pts.push([x0 + t, yc - amp * 0.5 * (L(t) + (t - lag * 384 * scale >= 0 ? r : 0))]);
      }
      d = pathD(pts);
    } else {
      const off = (shift || 0) * 384 * scale;
      const wv = tapeWave(widths, { x0: x0 + off, y0: yc, amp: amp * k, scale, noise: i === 3 ? 0.03 : 0.08, seed: 11 + i });
      d = wv.d;
    }
    body += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2"/>`;
  });
  // The lag, marked between the first two rows.
  const lx = x0 + lag * 384 * scale;
  body += line(x0, 104, x0, 236, { stroke: C.amber, dash: '3 3' }) + line(lx, 104, lx, 236, { stroke: C.amber, dash: '3 3' });
  body += text((x0 + lx) / 2, 98, 'lag', { size: 11, fill: C.amber, anchor: 'middle' });
  body += text(W / 2, H - 18, 'The decoder tries left, right, the plain average and the lined-up average, and keeps whichever reads the most files.', { size: 12, fill: C.text, anchor: 'middle' });
  files['tape-channels.svg'] = svg(W, H, 'Two channels are two readings', 'Four waveforms. The left and right channels of a stereo transfer show the same pulses, the right one a little late. Their plain average is shrunken and garbled where the two disagree. Averaging after lining the right channel up on the left gives a clean, strong wave. The decoder keeps whichever reading reads the most files.', body);
}

// 4. Mending a turbo block: readings, agreement, splice, clean rewrite.
{
  const W = 960, H = 548;
  let body = text(W / 2, 40, 'Mending a damaged turbo block', { size: 22, fill: C.bright, anchor: 'middle', weight: 600 });
  body += text(W / 2, 66, 'A turbo file is written once, so the only second chance is reading the same stretch of recording again, differently.', { size: 13, fill: C.dim, anchor: 'middle' });
  const x0 = 260, x1 = W - 40, bw = x1 - x0;
  const readings = [
    ['as recorded', [[0.42, 0.55]], false],
    ['other channel', [[0.18, 0.26], [0.70, 0.74]], false],
    ['treble lift 1.5', [[0.46, 0.52]], false],
    ['treble lift 2.5', [], true],
    ['treble lift 3.5', [], true],
    ['treble lift 5', [[0.88, 0.93]], false],
  ];
  readings.forEach(([label, faults, ok], i) => {
    const y = 104 + i * 40;
    body += text(30, y + 17, label, { size: 13, fill: C.text });
    body += rect(x0, y, bw, 24, { fill: '#16193a', stroke: C.line, r: 4 });
    for (const [a, b] of faults) body += `<rect x="${x0 + a * bw}" y="${y}" width="${(b - a) * bw}" height="24" fill="${C.red}" opacity="0.85"/>`;
    body += text(x0 - 14, y + 17, ok ? '✓' : '✗', { size: 15, fill: ok ? C.green : C.red, anchor: 'end', weight: 600 });
    if (ok) body += text(x1 - 8, y + 17, 'checksum passes', { size: 11, fill: C.green, anchor: 'end' });
  });
  // The two agreeing readings bracketed.
  body += `<path d="M${x0 - 34},${104 + 3 * 40 + 4} C${x0 - 52},${104 + 3 * 40 + 24} ${x0 - 52},${104 + 4 * 40 + 4} ${x0 - 34},${104 + 4 * 40 + 20}" fill="none" stroke="${C.green}" stroke-width="1.6"/>`;
  const ya = 104 + 6 * 40 + 18;
  body += rect(30, ya, W - 70, 96, { stroke: C.green, sw: 1.4 });
  body += text(50, ya + 28, 'Two readings agree byte for byte → the block is confirmed, and written back clean', { size: 14, fill: C.bright, weight: 600 });
  body += text(50, ya + 50, 'at the two pulse widths the tape uses elsewhere, so the original loader reads it as if new.', { size: 12, fill: C.text });
  body += text(50, ya + 72, 'One reading alone: put back, but marked unconfirmed. Two that disagree: left as it was.', { size: 12, fill: C.amber });
  // Splice note.
  const ys = ya + 118;
  body += text(30, ys, 'No whole reading passes?', { size: 13, fill: C.bright, weight: 600 });
  body += text(30, ys + 20, 'Each reading is trusted except around its faults, and the clean stretches are spliced together,', { size: 12, fill: C.text });
  body += text(30, ys + 38, 'cut 30, 10, then 1.5 ms short of a fault. The checksum judges the result, and a splice is always unconfirmed.', { size: 12, fill: C.dim });
  files['tape-turbo-mend.svg'] = svg(W, H, 'Mending a damaged turbo block', 'Six readings of one damaged turbo block, each a bar with red marks where its pulses could not be read: as recorded, the other channel, and treble lifts of 1.5, 2.5, 3.5 and 5. The lifts of 2.5 and 3.5 read cleanly and agree, so the block is confirmed and written back clean. A note explains that one reading alone is marked unconfirmed, two that disagree leave the block alone, and that clean stretches of several readings can be spliced, always marked unconfirmed.', body);
}

// 5. A KERNAL file's two copies.
{
  const W = 960, H = 460;
  let body = text(W / 2, 40, 'A KERNAL file is saved twice', { size: 22, fill: C.bright, anchor: 'middle', weight: 600 });
  body += text(W / 2, 66, 'Every block goes onto the tape, then again: a countdown $89…$81 before the first copy, $09…$01 before the repeat.', { size: 13, fill: C.dim, anchor: 'middle' });
  const cells = 16, cw = 34, x0 = 210;
  const drawRow = (y, label, sub, bad, col) => {
    let s = text(30, y + 18, label, { size: 14, fill: C.bright, weight: 600 }) + text(30, y + 36, sub, { size: 11, fill: C.dim });
    for (let i = 0; i < cells; i++) {
      const isBad = bad.includes(i);
      s += rect(x0 + i * (cw + 4), y, cw, 34, { fill: isBad ? '#3a1820' : '#16193a', stroke: isBad ? C.red : (col || C.line), r: 3 });
      s += text(x0 + i * (cw + 4) + cw / 2, y + 22, isBad ? '?' : ['A9', '00', '8D', '20', 'D0', '8D', '21', 'D0', '60', '4C', '00', '08', 'EA', 'A2', '05', 'CA'][i], { size: 11, fill: isBad ? C.red : C.text, anchor: 'middle' });
    }
    return s;
  };
  // Case 1: the repeat is damaged and rebuilt from the first copy.
  body += text(30, 104, '1 · The repeat is damaged', { size: 13, fill: C.amber, weight: 600 });
  body += drawRow(118, 'First copy', 'checksum ok', [], C.green);
  body += drawRow(160, 'Repeat', 'damaged', [11, 12, 13, 14, 15]);
  body += text(x0, 214, '→ the repeat is written again from the first copy, at full length, so nothing after it moves', { size: 12, fill: C.text });
  // Case 2: both damaged, merged.
  body += text(30, 252, '2 · Both copies are damaged', { size: 13, fill: C.amber, weight: 600 });
  body += drawRow(266, 'First copy', 'damaged', [3, 4]);
  body += drawRow(308, 'Repeat', 'damaged', [9, 10]);
  body += drawRow(356, 'Merged', 'checksum ok', [], C.green);
  body += text(x0, 414, '→ the copies are lined up, and each lost byte is taken from the other copy.', { size: 12, fill: C.text });
  body += text(x0, 432, '  The block\'s checksum decides whether the merge is the file.', { size: 12, fill: C.text });
  files['tape-kernal-copies.svg'] = svg(W, H, 'A KERNAL file is saved twice', 'Two cases drawn as rows of byte cells. First, a good first copy and a repeat with its last bytes lost: the repeat is written again from the first copy. Second, two copies each with different bytes lost: lined up and merged into one whole block whose checksum passes.', body);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, content] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, name), content);
  console.log(`wrote ${path.relative(ROOT, path.join(OUT, name))} (${(content.length / 1024).toFixed(1)} KB)`);
}

// Link previews take no SVG, so the pipeline, the guide's share picture, also
// goes out as a WebP of the same name (the docs build uses it for og:image).
const SHARE = 'tape-pipeline';
const browser = await launchShotBrowser();
const page = await browser.newPage({ viewport: { width: 1200, height: 675 } });
await page.setContent(`<body style="margin:0;background:#0b0e24">${files[`${SHARE}.svg`]}</body>`);
const info = saveGuideShot(await page.locator('svg').screenshot(), OUT, SHARE);
await browser.close();
console.log(`wrote ${path.relative(ROOT, info.path)}: ${shotLabel(SHARE, info)}`);
