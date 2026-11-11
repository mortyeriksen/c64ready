// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/vibes/vibes-quality.js – how much the Retro Vibes view draws.
//
// Pure rules, apart from retrovibes.js so they can be tested without a GPU:
// the pixel ratio a view of a given size gets, the steps a view that cannot
// keep up takes, and the guard that decides when to take one.

import { GUARD, frameRateVerdict } from './frame-rate-guard.js';

// The most pixels the view draws: a 4K picture. Every post-processing buffer
// is this size, several of them in half-float, so the cost of a frame and the
// memory behind it follow it directly. Laptop screens and 4K monitors at
// ratio 2 fit inside it and are left alone; a 5K screen would be nearly twice
// it, a 6K one more than twice.
export const PIXEL_BUDGET = 3840 * 2160;

// The pixel ratio for a view `width` x `height` CSS pixels on a display of
// ratio `dpr`: the display's own, up to `cap`, and no more than the budget
// allows.
export function viewPixelRatio(width, height, dpr, cap, budget = PIXEL_BUDGET) {
  const ratio = Math.min(dpr || 1, cap);
  const area = width * height;
  return area > 0 ? Math.min(ratio, Math.sqrt(budget / area)) : ratio;
}

// What a view draws, from everything down to the plain picture: `ratio` caps
// the pixel ratio, `bloom` is the glow pass, `extras` are the smoke and the
// contact shadows. Sharpness goes first, since it buys the most frame time for
// the least loss, then the glow, then the extras.
const STEPS = [
  { ratio: 2, bloom: true, extras: true },
  { ratio: 1.5, bloom: true, extras: true },
  { ratio: 1, bloom: true, extras: true },
  { ratio: 1, bloom: false, extras: true },
  { ratio: 1, bloom: false, extras: false },
];
const LOW_POWER_RATIO = 1.5;

// The steps for this kind of device, the first being where it starts. A
// low-power device (a phone, a tablet, a small laptop) starts without bloom
// and extras at ratio 1.5, so what is left for it to give up is sharpness.
export function qualitySteps(lowPower) {
  const steps = [];
  for (const s of STEPS) {
    const step = lowPower ? { ratio: Math.min(s.ratio, LOW_POWER_RATIO), bloom: false, extras: false } : { ...s };
    const last = steps[steps.length - 1];
    if (!last || last.ratio !== step.ratio || last.bloom !== step.bloom || last.extras !== step.extras) steps.push(step);
  }
  return steps;
}

// A view may run at 30 frames a second, on a 30 Hz display or a phone saving
// power, and be keeping up: it is slow only well below that.
const VIEW_GUARD = { ...GUARD, MS: 40 };
// A gap this long is the tab coming back, not a frame.
const GAP_MS = 250;

// Watches the view's frame times and says when to take the next step. It
// watches until the view has kept up for a full run, or the last step is
// reached. reset() watches again, for a scene of another cost.
export class QualityGuard {
  constructor(steps) {
    this.steps = steps;
    this.level = 0;
    this.settled = steps <= 1;
    this.frames = [];
  }

  // One frame took `ms`. True when the level moved.
  frame(ms) {
    if (this.settled || ms > GAP_MS) return false;
    this.frames.push(ms);
    const verdict = frameRateVerdict(this.frames, VIEW_GUARD);
    if (verdict === 'wait') return false;
    this.frames.length = 0;
    if (verdict === 'ok') { this.settled = true; return false; }
    this.level++;
    if (this.level >= this.steps - 1) this.settled = true;
    return true;
  }

  reset() {
    this.frames.length = 0;
    this.settled = this.level >= this.steps - 1;
  }
}
