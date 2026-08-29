// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/vibes-btn-fx.js — the small pixel demo inside the VIBES button: ten sine
// patterns of dark dots, painted through a perspective divide so they move in
// depth. Decoration only, switchable from Options ▸ Display, and Cmd+Shift+Z
// (Ctrl+Shift+Z off macOS) blows the whole button up to 10x in a dialog.
//
// Three parts: the field maths, the painter, and the zoom.

// ── Field ────────────────────────────────────────────────────────────────────
// Ten patterns over PIXEL_COUNT dots in a normalised cube — x right, y down,
// z into the screen, every component within ±1. Each is a pure function of
// (index, count, seconds), so the field follows from its timestamp and this part
// needs no DOM.

import { pushEscapeLayer, popEscapeLayer } from './escape-stack.js';

const TAU = Math.PI * 2;

// Open curves fill both ends; closed loops divide by n so the last dot doesn't
// land on the first.
const spread = (i, n) => (n > 1 ? i / (n - 1) : 0.5);
const loop = (i, n) => i / n;

// Lattice patterns. 28 divides evenly (7×4, 4 rings of 7); a ragged last row
// still works.
const GRID_COLS = 7;
const TUNNEL_SPOKES = 7;

// In show order. Each writes x/y/z into the caller's `out`, so sampling never
// allocates.
export const PATTERNS = [
  // Travelling sine wave, held in place along x; a slower cosine adds depth.
  {
    name: 'wave',
    at(out, i, n, t) {
      const u = spread(i, n);
      const a = u * TAU * 1.6 - t * 1.9;
      out.x = u * 2 - 1;
      out.y = Math.sin(a) * 0.72;
      out.z = Math.cos(a * 0.5) * 0.8;
    },
  },

  // Sine bobs: each dot on its own phase, so they bounce independently.
  {
    name: 'bobs',
    at(out, i, n, t) {
      const u = spread(i, n);
      const a = t * 2.3 + u * TAU * 2.2;
      out.x = (u * 2 - 1) * 0.94;
      out.y = Math.sin(a) * 0.8;
      out.z = Math.sin(a * 0.37 + 1.1) * 0.55;
    },
  },

  // Helix about the long axis.
  {
    name: 'helix',
    at(out, i, n, t) {
      const u = spread(i, n);
      const a = u * TAU * 1.5 + t * 1.7;
      out.x = u * 2 - 1;
      out.y = Math.sin(a) * 0.62;
      out.z = Math.cos(a);
    },
  },

  // Two helices half a turn apart.
  {
    name: 'dna',
    at(out, i, n, t) {
      const half = Math.max(1, n >> 1);
      const strand = i >= half ? 1 : 0;
      const k = half > 1 ? (i % half) / (half - 1) : 0.5;
      const a = k * TAU * 1.35 + t * 1.6 + strand * Math.PI;
      out.x = k * 2 - 1;
      out.y = Math.sin(a) * 0.7;
      out.z = Math.cos(a) * 0.95;
    },
  },

  // Ring in the x/z plane, nodded about x and spun about y. Both are rotations,
  // so the 0.92 radius bounds every component.
  {
    name: 'ring',
    at(out, i, n, t) {
      const a = loop(i, n) * TAU;
      const rx = Math.cos(a) * 0.92;
      const rz = Math.sin(a) * 0.92;
      const tilt = 0.55 + 0.35 * Math.sin(t * 0.7);
      const ct = Math.cos(tilt), st = Math.sin(tilt);
      const ty = -rz * st, tz = rz * ct;
      const spin = t * 1.15;
      const cs = Math.cos(spin), ss = Math.sin(spin);
      out.x = rx * cs + tz * ss;
      out.y = ty;
      out.z = tz * cs - rx * ss;
    },
  },

  // Globe: spaced pole to pole, turned by the golden angle so there are no
  // visible seams.
  {
    name: 'globe',
    at(out, i, n, t) {
      const k = (i + 0.5) / n;
      const ry = 1 - 2 * k;
      const r = Math.sqrt(Math.max(0, 1 - ry * ry));
      const a = i * 2.399963 + t * 1.05;
      out.x = Math.cos(a) * r;
      out.y = ry * 0.86;
      out.z = Math.sin(a) * r;
    },
  },

  // Lissajous cloud — three axes drifting at different rates.
  {
    name: 'lissajous',
    at(out, i, n, t) {
      const p = loop(i, n) * TAU;
      out.x = Math.sin(p * 3 + t * 0.9) * 0.95;
      out.y = Math.sin(p * 2 + t * 1.3) * 0.8;
      out.z = Math.sin(p * 4 + t * 0.6);
    },
  },

  // Lattice sheet, two crossing ripples, tilted away from the viewer.
  {
    name: 'grid',
    at(out, i, n, t) {
      const rows = Math.max(1, Math.ceil(n / GRID_COLS));
      const col = i % GRID_COLS;
      const row = (i / GRID_COLS) | 0;
      const gx = GRID_COLS > 1 ? (col / (GRID_COLS - 1)) * 2 - 1 : 0;
      const gz = rows > 1 ? (row / (rows - 1)) * 2 - 1 : 0;
      const h = Math.sin(gx * 2.2 + t * 2.0) * 0.28 + Math.sin(gz * 1.9 - t * 1.4) * 0.24;
      out.x = gx * 0.95;
      out.y = h + gz * 0.3;
      out.z = gz * 0.9;
    },
  },

  // Rings flying at the viewer, widening as they come. The wrap back to the far
  // end reads as a ring leaving past the camera.
  {
    name: 'tunnel',
    at(out, i, n, t) {
      const rings = Math.max(1, Math.ceil(n / TUNNEL_SPOKES));
      const ring = (i / TUNNEL_SPOKES) | 0;
      const spoke = i % TUNNEL_SPOKES;
      const d = (ring / rings + t * 0.22) % 1;
      const a = (spoke / TUNNEL_SPOKES) * TAU + ring * 0.4 + t * 0.55;
      const rad = 0.3 + 0.62 * d;
      out.x = Math.cos(a) * rad;
      out.y = Math.sin(a) * rad * 0.9;
      out.z = 1 - d * 2;
    },
  },

  // Gerono figure-eight, swung ±1 rad about y so it never goes fully edge-on.
  {
    name: 'lemniscate',
    at(out, i, n, t) {
      const p = loop(i, n) * TAU;
      const cp = Math.cos(p), sp = Math.sin(p);
      const fx = cp * 0.98;
      const ang = Math.sin(t * 0.6);
      out.x = fx * Math.cos(ang);
      out.y = sp * cp * 1.55;
      out.z = fx * Math.sin(ang) + Math.sin(p * 3 + t * 1.4) * 0.15;
    },
  },
];

export const PATTERN_NAMES = PATTERNS.map((p) => p.name);

// Enough to read as a field, few enough to stay subtle behind a label.
export const PIXEL_COUNT = 28;

export const PATTERN_SECS = 4.5;  // one pattern held on its own
export const MORPH_SECS = 1.1;    // blending into the next
export const SLOT_SECS = PATTERN_SECS + MORPH_SECS;
export const CYCLE_SECS = SLOT_SECS * PATTERNS.length;  // 56 s round trip

// Zero slope at both ends, so the blend starts and lands without a kick.
const smoothstep = (e) => e * e * (3 - 2 * e);

// Hoisted: sampleField runs every frame and must not allocate.
const _a = { x: 0, y: 0, z: 0 };
const _b = { x: 0, y: 0, z: 0 };

// Fill caller-owned xs/ys/zs (length >= n) with the field at `t` seconds.
export function sampleField(t, xs, ys, zs, n = PIXEL_COUNT) {
  const tt = t > 0 ? t : 0;
  const slot = Math.floor(tt / SLOT_SECS);
  const local = tt - slot * SLOT_SECS;
  const a = PATTERNS[slot % PATTERNS.length];
  const mix = local <= PATTERN_SECS
    ? 0
    : smoothstep(Math.min(1, (local - PATTERN_SECS) / MORPH_SECS));

  if (mix === 0) {
    for (let i = 0; i < n; i++) {
      a.at(_a, i, n, tt);
      xs[i] = _a.x; ys[i] = _a.y; zs[i] = _a.z;
    }
    return;
  }

  const b = PATTERNS[(slot + 1) % PATTERNS.length];
  for (let i = 0; i < n; i++) {
    a.at(_a, i, n, tt);
    b.at(_b, i, n, tt);
    xs[i] = _a.x + (_b.x - _a.x) * mix;
    ys[i] = _a.y + (_b.y - _a.y) * mix;
    zs[i] = _a.z + (_b.z - _a.z) * mix;
  }
}

// ── Painter ──────────────────────────────────────────────────────────────────
// The canvas is built here, not in index.html: it means nothing to a reader or a
// screen reader. z-index -1 puts it above the button's gradient and below the
// label; .btn-vibes needs `isolation: isolate` for that to resolve against the
// button rather than an ancestor.


// f = FOV / (FOV + z), z within ±1: near dots reach ~1.6x, far ones ~0.72x. A
// smaller FOV deepens it, but throws near dots past the button's edge.
const FOV = 2.6;
const F_MIN = FOV / (FOV + 1);
const F_MAX = FOV / (FOV - 1);

// Fraction of half the button's width/height the field spans. Tighter
// vertically: in ~30 px the dots must stay a band clear of the border.
const FIELD_W = 0.8;
const FIELD_H = 0.54;

// Near-black violet, darker than both the idle gradient (#2a1145 → #12233f) and
// the lighter hover one. Depth drives the alpha.
const DOT_INK = 'rgb(9, 2, 20)';
const ALPHA_FAR = 0.34;
const ALPHA_NEAR = 0.9;

// A dot is one CSS pixel across at the back and two up close, sized continuously
// between: a threshold would pop, and magnified 10x that pop is ten pixels wide.
// Whole device pixels only, so the dots stay crisp squares.
const DOT_FAR_CSS = 1;
const DOT_NEAR_CSS = 2;

// 30 fps in the button, where its size hides the cadence and the emulator wants
// the rest of the budget.
const FPS = 30;
const MAX_DPR = 2;

// Which frame prefers-reduced-motion gets: into the opening wave, not flat t=0.
const STILL_T = 1.2;

// Attach to a button-shaped host; null if there is nothing to draw on.
//
// Default (gated) mode starts itself and parks the loop when nobody can see it.
// { manual: true } leaves that to the caller — the zoom clone, which runs only
// while its dialog is open. fps: 0 paints every animation frame; timeScale
// stretches the show's clock, keeping rate and speed independent.
export function attachVibesButtonFx(btn, { manual = false, fps = FPS, timeScale = 1 } = {}) {
  if (!btn || typeof document === 'undefined') return null;

  // 0 makes the throttle test below always false: every frame paints.
  const frameMs = fps > 0 ? 1000 / fps : 0;

  const canvas = document.createElement('canvas');
  canvas.className = 'vibes-fx';
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return null;
  btn.prepend(canvas);

  const xs = new Float32Array(PIXEL_COUNT);
  const ys = new Float32Array(PIXEL_COUNT);
  const zs = new Float32Array(PIXEL_COUNT);

  const reduced = typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  // Full-page covers still count as "visible" to an IntersectionObserver, so
  // they are checked directly.
  const overlay = manual ? null : document.getElementById('model-viewer-overlay');

  let dpr = 1, unit = 1, res = 1;   // unit = device px per CSS px, incl. res
  let raf = 0, last = -Infinity, t0 = -1;
  let enabled = true, onScreen = true;
  let wanted = false;   // whether anyone currently wants the field running

  const covered = () =>
    document.body.classList.contains('splash-open') || (overlay ? !overlay.hidden : false);

  const shouldRun = () =>
    wanted && enabled && !document.hidden && (manual || (onScreen && !covered()));

  // Backing store = the canvas's painted box in device pixels. Two sources,
  // because a host can magnify in either of two ways and each hides a different
  // number. Under `zoom` the painted box IS the magnified one while clientWidth
  // reports the authored size, so only the rect is honest. Under a transform the
  // layout box is the authored size and the rect carries whatever the flight is
  // part-way through, so it is the layout box times `res` that we want.
  // False while the button has no layout; the observer retries.
  function measure() {
    dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    let pw, ph;
    if (btn.style.zoom) {
      const r = canvas.getBoundingClientRect();
      pw = r.width; ph = r.height;
    } else {
      pw = btn.clientWidth * res; ph = btn.clientHeight * res;
    }
    if (!pw || !ph) return false;
    const cw = Math.max(1, Math.round(pw * dpr));
    const ch = Math.max(1, Math.round(ph * dpr));
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    unit = dpr * res;   // res changes the position grid, not the on-screen dot size
    return true;
  }

  function paint(t) {
    const w = canvas.width, h = canvas.height;
    if (!w || !h) return;
    sampleField(t, xs, ys, zs, PIXEL_COUNT);
    ctx.clearRect(0, 0, w, h);
    const midX = w * 0.5, midY = h * 0.5;
    const spanX = midX * FIELD_W, spanY = midY * FIELD_H;
    // One fillStyle, depth on globalAlpha: no colour strings built per frame.
    ctx.fillStyle = DOT_INK;
    for (let i = 0; i < PIXEL_COUNT; i++) {
      const f = FOV / (FOV + zs[i]);
      const near = f <= F_MIN ? 0 : f >= F_MAX ? 1 : (f - F_MIN) / (F_MAX - F_MIN);
      const size = Math.max(1,
        Math.round(unit * (DOT_FAR_CSS + (DOT_NEAR_CSS - DOT_FAR_CSS) * near)));
      ctx.globalAlpha = ALPHA_FAR + (ALPHA_NEAR - ALPHA_FAR) * near;
      ctx.fillRect(
        Math.round(midX + xs[i] * spanX * f - size * 0.5),
        Math.round(midY + ys[i] * spanY * f - size * 0.5),
        size,
        size,
      );
    }
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    raf = 0;
    // Throttle first. shouldRun reads the DOM, and at 30 fps on a 120 Hz screen
    // three of every four callbacks would pay for that only to return.
    if (now - last < frameMs) {
      raf = requestAnimationFrame(frame);
      return;
    }
    if (!shouldRun()) return;      // idle until a wake path calls start() again
    raf = requestAnimationFrame(frame);
    last = now;
    if (t0 < 0) t0 = now;   // the show opens on the wave, not mid-cycle
    paint(((now - t0) / 1000) * timeScale);
  }

  // Every wake path ends here and may fire freely; the checks decide.
  function resume() {
    if (raf || !shouldRun() || !measure()) return;
    if (reduced && reduced.matches) { paint(STILL_T); return; }
    last = -Infinity;
    raf = requestAnimationFrame(frame);
  }

  function pause() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function start() { wanted = true; resume(); }
  function stop() { wanted = false; pause(); }

  function clear() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function setEnabled(on) {
    enabled = !!on;
    canvas.hidden = !enabled;
    if (enabled) resume();
    else { pause(); clear(); }
  }

  // Re-read the painted box. Needed when the host resizes the canvas without
  // touching its layout box — the zoom settling onto `zoom` does exactly that,
  // and no observer reports it. Repaints a still frame itself, since no loop
  // will when the field is parked.
  function remeasure() {
    if (!measure() || !enabled) return;
    if (!raf) paint(t0 < 0 ? STILL_T : ((performance.now() - t0) / 1000) * timeScale);
  }

  // Re-grid after a host's CSS scale changes.
  function setResolution(factor) {
    const next = Math.max(1, factor || 1);
    if (next === res) return;
    res = next;
    remeasure();
  }

  // The button's box moves with the panel width, size modes and fullscreen. Also
  // the retry that starts the loop once it has a layout at all.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (!enabled) return;
      if (reduced && reduced.matches) { if (measure()) paint(STILL_T); return; }
      if (raf) measure();      // running: the next frame repaints at the new size
      else resume();
    }).observe(btn);
  }

  // Wake paths: tab returning, button scrolling in, splash dismissed, Retro Vibes
  // overlay closing (its only signal is `hidden`). A manual host needs none.
  document.addEventListener('visibilitychange', () => resume());
  if (!manual) {
    window.addEventListener('c64-splash-dismissed', () => resume());
    if (typeof IntersectionObserver === 'function') {
      new IntersectionObserver((entries) => {
        onScreen = entries[entries.length - 1].isIntersecting;
        if (onScreen) resume(); else pause();
      }).observe(btn);
    }
    if (overlay && typeof MutationObserver === 'function') {
      new MutationObserver(() => resume()).observe(overlay, { attributeFilter: ['hidden'] });
    }
  }
  if (reduced && reduced.addEventListener) {
    reduced.addEventListener('change', () => {
      pause();
      if (!enabled) return;
      if (reduced.matches) { clear(); if (measure()) paint(STILL_T); }
      else resume();
    });
  }

  if (!manual) start();
  return { start, stop, setEnabled, setResolution, remeasure };
}

// ── Zoom (Cmd+Shift+Z) ─────────────────────────────────────────────────────────────
// The live button is cloned and magnified; it stays a working button. 10x is
// capped to what the viewport holds.
//
// How it magnifies depends on the engine, because the two ways of scaling a box
// are not interchangeable:
//
//   `transform` is a post-layout VISUAL scale. It animates without relayout, so
//   it is what the flight out and home is made of. Blink re-rasterises the
//   subtree at the composited scale, so it stays sharp at any size.
//
//   `zoom` is a LAYOUT scale: padding, font-size, borders and the canvas's box
//   are all computed at the magnified size and painted natively. It cannot be
//   animated without relaying out every frame.
//
// WebKit rasterises a transformed subtree once at its unscaled size and
// stretches the result, which softens the label and the dot field alike — a
// transform simply cannot be left sitting there. So WebKit skips the flight and
// pops straight out at `zoom`, and everyone else keeps the animation and the
// transform that makes it possible. Popping is the honest trade: the animation
// is the part WebKit cannot render sharply, and sharp matters more than moving.
//
// The clone's field renders at the scale rather than being stretched from a
// button-sized bitmap, which would peg every dot to a 10-pixel grid and make the
// motion stall and hop. It also runs uncapped, being big enough for 30 fps to show.

// An ENGINE test, not a brand one: every browser on iOS is WebKit and needs the
// same treatment, so sniffing for "Safari" would miss most of them.
const WEBKIT = typeof navigator !== 'undefined' && navigator.vendor === 'Apple Computer, Inc.';

const ZOOM = 10;
const VIEWPORT_MARGIN = 48;   // px of breathing room kept around the zoom
const FLIGHT_MS = 340;        // must match the transition in styles-dialogs.css
// How far the pop overshoots before easing back (the ease itself is .is-pop in
// styles-dialogs.css). Kept modest: this is the one transform WebKit still has
// to stretch, so at 1.1 it costs 10% of softness for the moment it is at full
// overshoot and lands on `none`, fully sharp.
const POP_OVERSHOOT = 1.1;

// Painting every frame, at 10x the screen distance per step, reads as faster than
// the button's 30 fps. This dial brings the pace back down; it is not a frame
// rate.
const ZOOM_SPEED = 0.7;

export function createVibesZoom(btn, modal, stage, closeBtn) {
  if (!btn || !modal || !stage) return null;

  // Stable identity for push/pop. `closing` is excluded from isOpen so a flight
  // home already under way isn't treated as a live layer.
  const _escapeLayer = { close: () => close(), isOpen: () => isOpen() && !closing };

  let clone = null;      // the magnified button
  let field = null;      // its dot field
  let lastFocus = null;  // what to hand focus back to on close
  let scale = ZOOM;      // the zoom actually in use (viewport-capped)
  let closing = false;   // mid-flight home; a second Cmd+Shift+Z turns it around
  let fx = true;         // mirrors Options ▸ Display, so the zoom shows the
                         // same button the panel does

  // Sits above this dialog: opening underneath it would hide the demo and give
  // Esc the wrong target.
  const viewer = document.getElementById('model-viewer-overlay');

  const isOpen = () => !modal.hidden;
  const still = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // A copy that still works like a button: hover, focus, and a click handed to
  // the real one. Only the id goes (it would duplicate #btn-vibes), and NOT
  // `disabled` — that kills hover and dims it to 35% via .btn:disabled.
  function build() {
    clone = btn.cloneNode(true);
    clone.removeAttribute('id');
    clone.addEventListener('click', () => { close(); btn.click(); });
    // The glyph defines gradient/mask ids; rename them to keep ids unique.
    clone.innerHTML = clone.innerHTML.replace(/vibesSun/g, 'vibesSunZoom');
    // Swap the cloned dead bitmap for a live field.
    const dead = clone.querySelector('canvas.vibes-fx');
    if (dead) dead.remove();
    stage.appendChild(clone);
    field = attachVibesButtonFx(clone, { manual: true, fps: 0, timeScale: ZOOM_SPEED });
    field?.setEnabled(fx);
  }

  // The stage carries the magnified footprint. On WebKit the clone is really laid
  // out at that size (`zoom`); elsewhere it keeps its authored size and the
  // transform does the magnifying, which leaves layout alone — so the stage is
  // the only thing that knows how big the zoom is.
  function layout() {
    const w = btn.offsetWidth, h = btn.offsetHeight;
    if (!w || !h) return false;
    const fitW = (window.innerWidth - VIEWPORT_MARGIN * 2) / w;
    const fitH = (window.innerHeight - VIEWPORT_MARGIN * 2) / h;
    scale = Math.max(1, Math.min(ZOOM, fitW, fitH));
    clone.style.width = `${w}px`;
    clone.style.height = `${h}px`;
    stage.style.width = `${w * scale}px`;
    stage.style.height = `${h * scale}px`;
    if (WEBKIT) clone.style.zoom = scale;
    field?.setResolution(scale);   // the dots magnify with the button, either way
    field?.remeasure();            // `zoom` changes the painted box unobserved
    return true;
  }

  // WebKit's way in: already at full size via `zoom`, so there is nothing to fly.
  // A small overshoot easing back gives it some life without asking the engine to
  // stretch a rasterisation by more than 10%.
  function pop() {
    clone.classList.add('is-pop');
    clone.style.transformOrigin = 'center';
    clone.classList.add('is-instant');
    clone.style.transform = `scale(${POP_OVERSHOOT})`;
    void clone.offsetWidth;
    clone.classList.remove('is-instant');
    requestAnimationFrame(() => { clone.style.transform = 'none'; });
  }

  // transform-origin is the clone's top-left, so the translate lands that corner
  // on the live button's and the scale grows from there.
  const homePose = () => {
    const b = btn.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    return `translate(${b.left - s.left}px, ${b.top - s.top}px) scale(1)`;
  };
  const zoomPose = () => `translate(0px, 0px) scale(${scale})`;

  function open() {
    if (isOpen() && !closing) return;
    if (viewer && !viewer.hidden) return;
    if (!clone) build();
    if (!field) return;                  // no 2D canvas — nothing to zoom
    pushEscapeLayer(_escapeLayer);
    closing = false;                     // turns a flight home back around
    if (!isOpen()) lastFocus = document.activeElement;
    modal.style.opacity = '0';
    if (WEBKIT) modal.classList.add('is-nofade');   // the pop arrives at once
    modal.hidden = false;                // measurable from here on
    if (!layout()) { modal.hidden = true; return; }
    field.start();

    if (still()) {
      modal.classList.add('is-instant');
      modal.style.opacity = '1';
      clone.style.transform = WEBKIT ? 'none' : zoomPose();
    } else {
      modal.classList.remove('is-instant');
      modal.style.opacity = '1';
      if (WEBKIT) {
        pop();
      } else {
        // Sit on the live button, flushed so the growth animates.
        clone.classList.add('is-instant');
        clone.style.transform = homePose();
        void clone.offsetWidth;
        clone.classList.remove('is-instant');
        requestAnimationFrame(() => { clone.style.transform = zoomPose(); });
      }
    }
    if (closeBtn) closeBtn.focus();
  }

  // The timer is the only end signal; transitionend goes missing on an
  // interrupted flight or a hidden tab.
  function close() {
    if (!isOpen() || closing) return;
    closing = true;
    popEscapeLayer(_escapeLayer);
    const land = () => {
      if (!closing) return;              // re-opened mid-flight; leave it alone
      closing = false;
      modal.hidden = true;
      modal.style.opacity = '';
      field?.stop();
      // Usually the screen, which must keep the keys.
      if (lastFocus && lastFocus.focus) lastFocus.focus();
      lastFocus = null;
    };
    // WebKit never flew out, so there is nothing to fly home: no fade, no
    // shrink, it just goes. Everyone else fades and flies back to the button.
    if (still() || WEBKIT) { land(); return; }
    modal.style.opacity = '0';
    clone.style.transform = homePose();
    setTimeout(land, FLIGHT_MS + 60);
  }

  const toggle = () => (isOpen() && !closing ? close() : open());

  // With the demo switched off the zoom is a plain 10x button, like the small one.
  const setFxEnabled = (on) => { fx = !!on; field?.setEnabled(fx); };

  closeBtn?.addEventListener('click', close);
  // Click-away: the backdrop closes, the zoom itself does not.
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  // Escape closes, through the shared stack. It used to be a listener of its own
  // calling stopPropagation, which does not stop sibling listeners on the same
  // node — so it never actually claimed the key from the dialogs after it.
  window.addEventListener('resize', () => { if (isOpen()) layout(); });

  return { open, close, toggle, isOpen, setFxEnabled };
}
