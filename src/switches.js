// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/switches.js — experimental / hardware-tuning switches, grouped in one
// place so the defaults are easy to read and change.
//
// Each switch has a plain-boolean DEFAULT that applies everywhere, including the
// Vite browser build (which has no `process`). In node — tests and one-off
// scripts — you can override any switch per run via its env
// var(s): `'1'` forces it on, `'0'` forces it off, anything else keeps the
// default. Resolution happens at call time (see `switchOn`), so a script may set
// `process.env.X` before constructing the machine and still have it take effect.
//
// This module has no imports.

const SWITCHES = {
  // Tint collision participants over the display: graphics green, sprites blue,
  // overlapping participants red. Reload with ?VIC_COLLISION_OVERLAY=1.
  vicCollisionOverlay: {
    default: false,
    env: ['VIC_COLLISION_OVERLAY'],
  },

  // Record new blank tapes as TAP v2 (half-waves) instead of v1 (full waves).
  // v1 is what every tool and preserved tape uses, and the duty cycle inside a
  // pulse is invisible to the C64's read path, so it loses nothing functionally.
  // v2 keeps every edge — twice the entries, half the quantization error, and
  // asymmetric duty cycles survive — which is what you want when the recording
  // is an archival master rather than something to load back. Recording onto an
  // existing tape always follows that tape's own version, whatever this says.
  // Toggle with TAPE_RECORD_HALFWAVE ('1' = record v2).
  tapeRecordHalfwave: {
    default: false,
    env: ['TAPE_RECORD_HALFWAVE'],
  },

  // Present the framebuffer through a WebGL texture instead of
  // ctx.putImageData (src/webgl-presenter.js). With CRT off it keeps the same
  // 384×272 backing store, NEAREST 1:1, opaque context — byte-exact output
  // with CSS doing the scaling; under a CRT preset it also hosts the shader
  // (crtShader below). Saves the per-frame putImageData convert+upload on the
  // main thread (matters most on mobile GPUs). Falls back to the 2D path
  // automatically when WebGL is unavailable. Browser A/B: append
  // ?WEBGL_PRESENTER=0 to the URL to force the legacy 2D path.
  webglPresenter: {
    default: true,
    env: ['WEBGL_PRESENTER'],
  },

  // Draw the CRT presets (scanlines, phosphor mask, beam softness, tone) in the
  // WebGL presenter's fragment shader, at device resolution and locked to the
  // 272 raster lines (src/webgl-presenter.js, src/crt-params.js). OFF keeps
  // the presenter at 1:1 and renders the presets with the CSS overlay fallback,
  // which is also what a browser without WebGL gets. Browser A/B:
  // ?CRT_SHADER=0.
  crtShader: {
    default: true,
    env: ['CRT_SHADER'],
  },

  // Run the CRT shader even on a software WebGL rasteriser (SwiftShader,
  // llvmpipe), where main.js otherwise keeps the CSS presets because a
  // per-pixel shader at device resolution crawls there. For tooling that
  // drives the shader path in a headless browser: ?CRT_SHADER_SOFTWARE=1.
  crtShaderSoftware: {
    default: false,
    env: ['CRT_SHADER_SOFTWARE'],
  },
};

// Resolve a switch by name: env override ('1'/'0') if present, else — in the
// browser, which has no `process` — a URL query param with the same name
// (?WEBGL_PRESENTER=0), else the default. The query hook gives every switch
// a runtime A/B toggle in the browser without a rebuild.
export function switchOn(name) {
  const s = SWITCHES[name];
  if (!s) throw new Error(`unknown switch: ${name}`);
  if (typeof process !== 'undefined' && process?.env) {
    for (const e of s.env) {
      const v = process.env[e];
      if (v === '1') return true;
      if (v === '0') return false;
    }
  }
  if (typeof location !== 'undefined' && typeof URLSearchParams !== 'undefined' && location.search) {
    try {
      const q = new URLSearchParams(location.search);
      for (const e of s.env) {
        const v = q.get(e);
        if (v === '1') return true;
        if (v === '0') return false;
      }
    } catch { /* malformed query — fall through to the default */ }
  }
  return s.default;
}

export { SWITCHES };
