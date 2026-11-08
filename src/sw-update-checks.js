// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/sw-update-checks.js — when the app asks the browser for a newer service
// worker: once at start, on a timer, and each time the app comes back to the
// front. A macOS Safari web app in the Dock checks for none by itself at launch,
// pauses timers in the background and stays "visible" when another app is in
// front, so start-up, focus and pageshow are its only cues. A check that finds
// nothing new costs one revalidated request, and close ones are run as one.

/**
 * @param {{ update: () => unknown }} registration  the service worker's registration
 * @param {object} [o]
 * @param {number} [o.every]   ms between timed checks
 * @param {number} [o.gap]     ms a check is skipped for after the last one
 * @param {Window} [o.win]
 * @param {Document} [o.doc]
 * @param {() => number} [o.now]
 * @param {() => boolean} [o.online]
 * @returns {() => void} a check, as the cues run it
 */
export function watchForUpdates(registration, {
  every = 10 * 60_000, gap = 60_000, win = globalThis.window, doc = globalThis.document,
  now = () => Date.now(), online = () => globalThis.navigator?.onLine !== false,
} = {}) {
  let last = -Infinity;
  const check = () => {
    if (!online() || now() - last < gap) return;
    last = now();
    try { Promise.resolve(registration.update()).catch(() => {}); } catch { /* offline, or the worker is gone */ }
  };
  check();
  win?.setInterval?.(check, every);
  win?.addEventListener?.('focus', check);
  win?.addEventListener?.('pageshow', check);
  win?.addEventListener?.('online', check);
  doc?.addEventListener?.('visibilitychange', () => { if (doc.visibilityState === 'visible') check(); });
  return check;
}
