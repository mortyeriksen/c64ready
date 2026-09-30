// Spec test for src/crt-params.js and the CSS fallback: the CRT presets are
// locked to the raster (272 lines), every preset is complete and in range, and
// the shared maths the shader mirrors behaves at its boundaries.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  CRT_PARAMS, CRT_MODES, CRT_PRESETS, presetParams, patternFade, backingSize,
  clipPreservingHue, humPhase, readOverrides, resolveParams, HUM_PERIOD_S,
} from '../src/crt-params.js';

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// Modes and presets.
expect(CRT_MODES.length === 6 && CRT_MODES[CRT_MODES.length - 1] === 'off', 'six modes, off last in the cycle');
expect(presetParams('off') === null, 'off has no parameters: the shader is bypassed');
for (const mode of CRT_MODES.filter(m => m !== 'off')) {
  const p = presetParams(mode);
  expect(p && typeof p === 'object', `${mode} has a parameter object`);
  expect(p !== CRT_PRESETS[mode], `${mode} is handed out as a copy`);
  for (const { key, min, max } of CRT_PARAMS) {
    expect(typeof p[key] === 'number', `${mode}.${key} is set`);
    expect(p[key] >= min && p[key] <= max, `${mode}.${key}=${p[key]} lies within its control range ${min}..${max}`);
  }
  expect(Object.keys(p).length === CRT_PARAMS.length, `${mode} has no parameter the panel cannot show`);
}
for (const { key, min, max, step, options } of CRT_PARAMS) {
  expect(min < max && step > 0 && step <= max - min, `${key} has a usable control range`);
  if (options) expect(step === 1 && min === 0 && options.length === max + 1, `${key} options cover its whole range`);
}
expect(CRT_PARAMS.find(p => p.key === 'maskType').options.length === 3, 'three mask geometries: grille, delta, slot');
expect(!CRT_PARAMS.some(p => /softnessV|humPeriod|beamBloom/.test(p.key)), 'no vertical softness, hum period or beam bloom control: lines are discrete, the bar keeps one pace, bright lines widen by a fixed amount');
expect(HUM_PERIOD_S === 7, 'the hum bar crosses once every 7 s');
// Every remaining control is set differently by at least one preset, so none is
// dead weight (mask type excepted: a choice offered to the user, every preset a grille).
for (const { key } of CRT_PARAMS) {
  if (key === 'maskType') continue;
  const values = new Set(Object.values(CRT_PRESETS).map(p => p[key]));
  expect(values.size > 1, `${key} distinguishes at least one preset`);
}

// Stored tuning: only known presets and parameters survive, clamped to range.
expect(JSON.stringify(readOverrides(null)) === '{}' && JSON.stringify(readOverrides('nonsense')) === '{}', 'no or broken storage means no overrides');
const ov = readOverrides(JSON.stringify({
  tube: { scanDepth: 0.5, mask: 9, bogus: 1, brightness: 'x' },
  nosuch: { scanDepth: 0.1 },
  arcade: {},
}));
expect(ov.tube.scanDepth === 0.5, 'a valid override is kept');
expect(ov.tube.mask === 0.5, 'an out-of-range override clamps to the control range');
expect(!('bogus' in ov.tube) && !('brightness' in ov.tube), 'unknown keys and non-numbers are dropped');
expect(!('nosuch' in ov) && !('arcade' in ov), 'unknown presets and empty entries are dropped');
const merged = resolveParams('tube', ov);
expect(merged.scanDepth === 0.5 && merged.mask === 0.5 && merged.beamWidth === CRT_PRESETS.tube.beamWidth, 'resolveParams lays the overrides over the preset');
expect(CRT_PRESETS.tube.scanDepth !== 0.5, 'the preset itself is untouched');
expect(resolveParams('off', ov) === null, 'off stays a bypass whatever is stored');
expect(resolveParams('on', ov).scanDepth === CRT_PRESETS.on.scanDepth, 'a preset without overrides is its defaults');
expect(CRT_PRESETS.bw.mask === 0, 'a monochrome tube has a single phosphor: no mask');
expect(CRT_PRESETS.bw.saturation === 0, 'B&W is fully desaturated');
expect(CRT_PRESETS.hum.humStrength > 0, 'HUM shows a hum bar');
for (const mode of ['on', 'tube', 'bw', 'arcade']) {
  expect(CRT_PRESETS[mode].humStrength === 0, `${mode} has no hum bar`);
}
expect(CRT_PRESETS.on.mask === 0 && CRT_PRESETS.on.vignette === 0, 'ON is scanlines only');

// Pattern fade: nothing under one device pixel per unit, full at two.
expect(patternFade(0.5) === 0 && patternFade(1) === 0, 'no pattern at or under 1 px per line/column');
expect(patternFade(2) === 1 && patternFade(3) === 1, 'full pattern from 2 px per line/column');
expect(near(patternFade(1.5), 0.5), 'the fade is centred between 1 and 2');
let prev = -1;
for (let x = 0; x <= 3; x += 0.05) { const f = patternFade(x); expect(f >= prev, 'the fade never reverses'); prev = f; }

// Backing store.
let b = backingSize(768, 544, 2);
expect(b.w === 1536 && b.h === 1088, '2X at DPR 2 backs at 1536×1088');
b = backingSize(383.6, 271.7, 1);
expect(b.w === 384 && b.h === 272, 'a fractional CSS box rounds to whole device pixels');
b = backingSize(3000, 2000, 4, 4096);
expect(b.w === 4096 && b.h === 4096, 'each axis is capped at the GL limit');
b = backingSize(0, 0, 2);
expect(b.w === 1 && b.h === 1, 'never a zero-sized store');

// Hue-preserving clip.
let c = clipPreservingHue([1.2, 0.6, 0.3]);
expect(near(c[0], 1) && near(c[1], 0.5) && near(c[2], 0.25), 'an over-range colour is scaled as a whole');
c = clipPreservingHue([0.9, 0.5, 0.1]);
expect(c[0] === 0.9 && c[1] === 0.5 && c[2] === 0.1, 'an in-range colour is untouched');
c = clipPreservingHue([-0.1, 0.5, 0.2]);
expect(c[0] === 0, 'negative channels clamp to black');

// Hum phase.
expect(humPhase(0, HUM_PERIOD_S) === 0 && near(humPhase(7000, HUM_PERIOD_S), 0) && near(humPhase(3500, HUM_PERIOD_S), 0.5), 'one crossing per period');

// The CSS fallback is locked to the raster too: one band per line, and none of
// the old picture-fraction periods that beat against it.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'src', 'styles-display.css'), 'utf8');
expect(css.includes('calc(100% / 272)'), 'CSS scanlines repeat once per raster line');
for (const n of [222, 296, 394]) {
  expect(!css.includes(`/ ${n})`), `no ${n}-period overlay survives`);
}
expect(!/\.crt-bezel[^{]*::before/.test(css), 'the CSS path has no phosphor mask (it cannot sit on the device grid)');

console.log('crt params spec: PASS');
