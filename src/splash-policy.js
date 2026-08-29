// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/splash-policy.js — visibility policy for the first-visit splash overlay.
//
// The decision must be applied BEFORE first paint (so neither new nor
// returning visitors see a flash), which is earlier than any module can run —
// index.html's inline <script> therefore MIRRORS this logic and the two must
// be kept in sync by hand. This module is the canonical, unit-tested form
// (test/splash-spec-test.js); src/splash.js consumes the shared constants.
//
// Inputs are primitives so the node test needs no DOM:
//   query      – the ?SPLASH URL param: '1' forces the splash on (dev/test/
//                re-entry), '0' forces it off, null/absent = no override.
//   defaultOn  – the ship switch (SPLASH_DEFAULT_ON in index.html): false
//                while dark-launched, true once the splash goes live.
//   seen       – localStorage[SPLASH_SEEN_KEY] === '1'; set on either
//                dismissal path, so the splash is first-visit-only.
//   standalone – running as an installed PWA (display-mode: standalone /
//                navigator.standalone); installed users are already sold.
export const SPLASH_SEEN_KEY = 'c64emu.splashSeen';

export function shouldShowSplash({ query = null, defaultOn = false, seen = false, standalone = false } = {}) {
  if (query === '1') return true;
  if (query === '0') return false;
  return defaultOn && !seen && !standalone;
}
