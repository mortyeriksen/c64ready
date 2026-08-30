// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/frame-rate-guard.js – decides whether a render loop is keeping up.
//
// A pure function over frame times, split out of pausedemo.js so it can be
// tested without a DOM or a GPU. pausedemo.js owns the loop and what to do
// about the answer; this file only answers "is this fast enough to be worth
// running?".
//
// Why measure at all: a renderer string can only catch "no GPU at all", and the
// case that actually hurts is a real but weak GPU — integrated graphics on a
// desktop CPU — which every static heuristic (core count, memory, pointer type)
// waves through. Measuring is the only thing that sees it.

export const GUARD = {
  WARMUP: 12,     // frames to ignore: shader compile, first paint, layout settling
  EARLY: 16,      // a hopeless machine is called this early, rather than made to wait
  SAMPLES: 48,    // frames to judge on, ~0.8s at 60fps
  MS: 32,         // sustained frame time meaning "give up" (~31fps)
  MS_EARLY: 60,   // the early-out threshold (~17fps)
};

/**
 * @param {number[]} frames  frame times in ms, oldest first, including warm-up
 * @returns {'wait'|'ok'|'slow'}  'wait' = not enough frames yet; 'ok' = passed
 *   the full run and need never be asked again; 'slow' = give up.
 */
export function frameRateVerdict(frames, guard = GUARD) {
  const n = frames.length - guard.WARMUP;
  if (n < guard.EARLY) return 'wait';
  // Judge at exactly two checkpoints: the early one, and the full run.
  const full = n >= guard.SAMPLES;
  if (!full && n !== guard.EARLY) return 'wait';

  // The median, not the mean: one 200ms hitch from a background tab or a GC
  // pause should not condemn a machine that is otherwise fine.
  const sorted = frames.slice(guard.WARMUP).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];

  // An absolute threshold, not one relative to the display's own cadence: a
  // ratio against the fastest frame reads a 120Hz panel rendering a comfortable
  // 60fps as "missing every other frame". The cost is that a genuine 30Hz output
  // falls back to the static banner — which is the right outcome there anyway.
  if (median > (full ? guard.MS : guard.MS_EARLY)) return 'slow';
  return full ? 'ok' : 'wait';
}
