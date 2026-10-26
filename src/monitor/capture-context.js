// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

const captures = new WeakMap();
let nextCapture = 1;

export function captureLabel(frame) {
  if (!frame) return 'No captured frame';
  if (!captures.has(frame)) captures.set(frame, nextCapture++);
  return `Captured frame #${captures.get(frame)}`;
}

export function recordedOrigin(frame, event) {
  return `${captureLabel(frame)} · raster ${Math.floor(frame.eventTick[event] / frame.cyclesPerLine)}, cycle ${frame.eventTick[event] % frame.cyclesPerLine + 1}`;
}
