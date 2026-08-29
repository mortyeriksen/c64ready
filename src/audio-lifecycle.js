// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Audio foreground/background policy shared by the browser entrypoint and tests.

export function shouldMuteOnAutoFreeze({ running }) {
  return !!running;
}

export function shouldRestoreForegroundAudio({ running, paused, hidden }) {
  return !!running && !paused && !hidden;
}

// Is there anything for a user gesture to actually restore?
//
// The gesture handler exists for two recoverable states: a context the autoplay
// policy left suspended, and a master gain the background/foreground transition
// pinned to 0 while the context itself kept running. Neither is true during
// ordinary play, and the handler is on keydown — so without this check every
// keystroke re-runs the whole restore path. That is how a resync (which snaps the
// SID event clock back to the oldest queued event) once ended up firing per
// keypress and injecting audio lag into every game.
export function needsForegroundAudioRestore({
  running, paused, hidden, ctxState, gainPinned,
}) {
  if (!shouldRestoreForegroundAudio({ running, paused, hidden })) return false;
  return ctxState !== 'running' || !!gainPinned;
}
