// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/crt-params.js — the CRT presets as numbers. The shader in
// webgl-presenter.js takes one flat parameter object; each preset is one such
// object, and CRT_PARAMS describes every field (label, range, step) so a
// control panel can bind straight to it. Pure module, no DOM: the maths that
// the shader mirrors (fades, backing-store size) lives here so Node can test it.

// Every shader parameter. Scanlines is how much darker the gap between two
// lines is than the beam centre (0.28 = 28%). Beam width is the Gaussian width
// of a line in raster lines (the shape between centre and gap); a bright line
// widens toward the gap by a fixed amount (the shader's BLOOM). Softness is
// the width, in emulated
// pixels, of the ramp between neighbouring pixels along the line: 0 is
// pixel-sharp (a one-device-pixel antialiased edge), 1 is a full linear blend.
// There is no vertical counterpart: raster lines are discrete on a tube, and
// the beam profile is the vertical look. Mask type is a choice (`options`),
// not a range: aperture grille, delta (stripes staggered every other row) or
// slot (double-pitch stripes in offset slots). Tone controls match CSS
// filter() semantics (1 = neutral). Black level lifts the darkest output
// (0.01 = 1% grey), so scanline gaps and the vignette never reach pure black
// on an OLED in a dark room. The hum bar crosses once every 7 s.
export const CRT_PARAMS = [
  { key: 'scanDepth',   label: 'Scanlines',       min: 0,    max: 1,   step: 0.01 },
  { key: 'beamWidth',   label: 'Beam width',      min: 0.15, max: 0.6, step: 0.01 },
  { key: 'softness',    label: 'Softness',        min: 0,    max: 1,   step: 0.01 },
  { key: 'mask',        label: 'Mask',           min: 0,    max: 0.5, step: 0.01 },
  { key: 'maskType',    label: 'Mask type',       min: 0,    max: 2,   step: 1, options: ['Grille', 'Delta', 'Slot'] },
  { key: 'brightness',  label: 'Brightness',      min: 0.5,  max: 1.5, step: 0.01 },
  { key: 'contrast',    label: 'Contrast',        min: 0.5,  max: 1.5, step: 0.01 },
  { key: 'saturation',  label: 'Saturation',      min: 0,    max: 2,   step: 0.01 },
  { key: 'vignette',    label: 'Vignette',        min: 0,    max: 1,   step: 0.01 },
  { key: 'black',       label: 'Black level',     min: 0,    max: 0.1, step: 0.005 },
  { key: 'humStrength', label: 'Hum bar',         min: 0,    max: 0.3, step: 0.005 },
];

export const HUM_PERIOD_S = 7;

// Cycle order of the CRT button. 'off' bypasses the shader entirely.
export const CRT_MODES = ['on', 'tube', 'bw', 'arcade', 'hum', 'off'];

const NEUTRAL = {
  scanDepth: 0, beamWidth: 0.3, softness: 0, mask: 0, maskType: 0,
  brightness: 1, contrast: 1, saturation: 1, vignette: 0, black: 0, humStrength: 0,
};

const TUBE = {
  ...NEUTRAL,
  scanDepth: 0.28, beamWidth: 0.30, softness: 0.7,
  mask: 0.10, brightness: 1.03, contrast: 1.04, saturation: 1.05, vignette: 0.45, black: 0.01,
};

export const CRT_PRESETS = {
  on:     { ...NEUTRAL, scanDepth: 0.15, beamWidth: 0.35 },
  tube:   TUBE,
  bw:     { ...TUBE, mask: 0, saturation: 0, contrast: 1.05 },
  arcade: {
    ...NEUTRAL,
    scanDepth: 0.42, beamWidth: 0.25, mask: 0.08,
    brightness: 1.12, contrast: 1.14, saturation: 1.14, vignette: 0.30, black: 0.01,
  },
  hum:    { ...TUBE, brightness: 1.02, humStrength: 0.06 },
};

// The parameter object for a mode: a fresh copy, or null for 'off' (bypass).
export function presetParams(mode) {
  const p = CRT_PRESETS[mode];
  return p ? { ...p } : null;
}

// The user's tuning, kept per preset as { mode: { key: value } } under this
// storage key; only the fields that differ from the preset are stored.
export const CRT_STORAGE_KEY = 'c64emu.crtParams';

// Parse stored overrides, keeping only known presets and parameters, each
// value a finite number clamped to its control range. Anything else is
// dropped, so a stale or hand-edited entry cannot put the shader in a state the
// panel cannot show.
export function readOverrides(json) {
  let raw;
  try { raw = JSON.parse(json || '{}'); } catch { return {}; }
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [mode, fields] of Object.entries(raw)) {
    if (!CRT_PRESETS[mode] || !fields || typeof fields !== 'object') continue;
    const kept = {};
    for (const spec of CRT_PARAMS) {
      const v = fields[spec.key];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      kept[spec.key] = Math.min(spec.max, Math.max(spec.min, v));
    }
    if (Object.keys(kept).length) out[mode] = kept;
  }
  return out;
}

// The preset with the user's overrides for that mode laid over it; null for 'off'.
export function resolveParams(mode, overrides) {
  const p = presetParams(mode);
  if (!p) return null;
  return { ...p, ...(overrides && overrides[mode]) };
}

// How the header logo follows the panel: the CSS custom properties that scale
// the logo's own per-look values (styles-header.css), plus two switches.
// `vars` holds only the properties that differ from untouched, so a look left
// alone sets nothing; `tuned` asks for the tone filter ON has no rule for, and
// `hum` for the hum band in a look that has none by default.
//
// Each slider is taken relative to the look's default. Where that default is 0
// a ratio means nothing: the hum bar then scales from HUM's own strength, and
// B&W's saturation eases the logo's greyscale. OFF has no parameters.
export const LOGO_TUNING_VARS = ['--logo-scan-k', '--logo-bright-k', '--logo-contrast-k', '--logo-sat-k', '--logo-hum-k', '--logo-gray'];

export function logoTuning(mode, overrides) {
  const p = resolveParams(mode, overrides), base = presetParams(mode);
  const vars = {};
  if (!p || !base) return { vars, tuned: false, hum: false };
  const ratio = (key) => (base[key] ? p[key] / base[key] : 1);
  const values = {
    '--logo-scan-k': [ratio('scanDepth'), 1],
    '--logo-bright-k': [ratio('brightness'), 1],
    '--logo-contrast-k': [ratio('contrast'), 1],
    '--logo-sat-k': [ratio('saturation'), 1],
    '--logo-hum-k': [base.humStrength ? ratio('humStrength') : p.humStrength / CRT_PRESETS.hum.humStrength, base.humStrength ? 1 : 0],
    '--logo-gray': [base.saturation ? 1 : Math.max(0, 1 - p.saturation), 1],
  };
  for (const [name, [v, untouched]] of Object.entries(values)) {
    if (Math.abs(v - untouched) >= 1e-6) vars[name] = Math.round(v * 1000) / 1000;
  }
  return { vars, tuned: mode === 'on' && Object.keys(vars).length > 0, hum: !base.humStrength && p.humStrength > 0 };
}

// Both patterns need two device pixels per emulated line/column to show a
// beam and a gap; under that the pattern would alias, so it fades out.
// Mirrors smoothstep(1, 2, x) in the shader.
export function patternFade(devicePixelsPerUnit) {
  const t = Math.min(1, Math.max(0, devicePixelsPerUnit - 1));
  return t * t * (3 - 2 * t);
}

// Device-pixel backing store for a canvas shown at cssW×cssH CSS pixels,
// capped per axis at `max` (the GL drawing-buffer limit).
export function backingSize(cssW, cssH, dpr, max = Infinity) {
  const w = Math.min(max, Math.max(1, Math.round(cssW * dpr)));
  const h = Math.min(max, Math.max(1, Math.round(cssH * dpr)));
  return { w, h };
}

// A colour pushed past 1.0 by the tone controls is scaled down as a whole so
// its hue holds (per-channel clipping turns the C64's light blue pink).
export function clipPreservingHue(rgb) {
  const mx = Math.max(rgb[0], rgb[1], rgb[2]);
  if (mx <= 1) return rgb.map(v => Math.max(0, v));
  return rgb.map(v => Math.max(0, v) / mx);
}

// Hum-bar phase (0..1) at time t (ms) for a bar that crosses once per period.
export function humPhase(tMs, periodS) {
  const p = (tMs / 1000) / periodS;
  return p - Math.floor(p);
}
