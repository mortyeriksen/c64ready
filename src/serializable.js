// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
export function copyData(value, maxBytes = 16384) {
  let nodes = 0;
  function check(value, depth) {
    if (++nodes > 2048 || depth > 8) throw new Error('Saved data is too complex.');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string' && value.length <= maxBytes) return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (Array.isArray(value)) { value.forEach(v => check(v, depth + 1)); return; }
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
      for (const [key, entry] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe saved data key.');
        check(entry, depth + 1);
      }
      return;
    }
    throw new Error('Saved data must be plain JSON.');
  }
  check(value, 0);
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > maxBytes) throw new Error('Saved data exceeds the size limit.');
  return JSON.parse(json);
}
