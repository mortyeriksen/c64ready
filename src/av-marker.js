// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/av-marker.js – A/V sync clapper for measuring recorded audio lateness.
//
// Off by default. Enable from the console, for this session only:
//
//   c64Trace.avMarkerOn()
//   c64Trace.avMarkerOff()
//
// Or ?avmarker=1 on the URL, read once at load.
//
// Stores nothing — no localStorage, no cookie, no window flag. A debug tap that
// survives a reload comes back on a later visit as an unexplained flash and pip.
//
// Every N seconds it flashes the viewport white for one presented frame AND fires
// a SID blip on the same rAF tick, so the distance between them in a recording IS
// the end-to-end audio lateness. Measuring the file: docs/TESTING.md.
//
// The blip is a NOTCH then a CLICK ($D418 volume to 0, then back with all three
// voices gated) because a plain blip is unfindable under music that rewrites every
// voice register each frame. The silence manufactures a clean onset, and volume is
// the register a player is least likely to touch.
//
// avMarkerEnabled() must stay a single boolean read — the rAF loop calls it every
// presented frame.

import { machine } from './state.js';

const PERIOD_MS = 10000;
const FIRST_MS = 1000;
const NOTCH_MS = 60;
const FLASH_MS = 120;

// The one and only piece of state: a module-local boolean, read per frame and
// written by the console helpers. Deliberately not mirrored anywhere — a second
// copy on window would let `c64Trace.avMarker = true` look like it did something.
let _enabled = false;

// Read the URL once at load. Nothing is written back.
if (typeof location !== 'undefined') {
  try {
    if (new URLSearchParams(location.search).get('avmarker') === '1') _enabled = true;
  } catch { /* no URL API */ }
}

export function avMarkerEnabled() {
  return _enabled;
}

export function setAvMarkerEnabled(on) {
  _enabled = !!on;
  return _enabled;
}

const NOTCH = [[0x18, 0x00]];
const BLIP_ON = [
  [0x18, 0x0F],
  [0x00, 0x00], [0x01, 0xC0], [0x05, 0x00], [0x06, 0xF0], [0x04, 0x21],
  [0x07, 0x00], [0x08, 0xC0], [0x0C, 0x00], [0x0D, 0xF0], [0x0B, 0x21],
  [0x0E, 0x00], [0x0F, 0xC0], [0x13, 0x00], [0x14, 0xF0], [0x12, 0x21],
];
const BLIP_OFF = [[0x04, 0x20], [0x0B, 0x20], [0x12, 0x20]];

export function createAvMarker({ doc = document } = {}) {
  let overlay = null;
  let lastFire = -1;
  let offAt = 0;
  let count = 0;
  let clickAt = 0;

  const paint = (on) => {
    if (!overlay) {
      overlay = doc.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:2147483647;' +
                              'pointer-events:none;display:none';
      doc.body.appendChild(overlay);
    }
    overlay.style.display = on ? 'block' : 'none';
  };

  const write = (pairs) => {
    if (!machine?._sidWrite) return false;
    for (const [reg, val] of pairs) machine._sidWrite(reg, val);
    return true;
  };

  return {
    tick(nowMs) {
      if (clickAt && nowMs >= clickAt) {
        clickAt = 0;
        paint(true);
        const blipped = write(BLIP_ON);
        offAt = nowMs + FLASH_MS;
        console.log(`[avmarker] #${count} @ ${(nowMs / 1000).toFixed(2)}s` +
                    (blipped ? '' : '  — NO SID (machine not running)'));
        return count;
      }
      if (offAt && nowMs >= offAt) {
        paint(false);
        write(BLIP_OFF);
        offAt = 0;
      }
      if (clickAt || offAt) return;
      if (lastFire < 0) lastFire = nowMs - PERIOD_MS + FIRST_MS;
      if (nowMs - lastFire < PERIOD_MS) return;
      lastFire = nowMs;
      count++;
      write(NOTCH);
      clickAt = nowMs + NOTCH_MS;
    },
    stop() {
      if (offAt || clickAt) { paint(false); write(BLIP_OFF); write([[0x18, 0x0F]]); }
      offAt = 0; clickAt = 0;
      if (overlay) { overlay.remove(); overlay = null; }
    },
    get count() { return count; },
  };
}
