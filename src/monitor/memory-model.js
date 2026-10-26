// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { graphicsLayout } from './setup-model.js';

// Roles follow current register configuration, not inferred program ownership.
export function memoryRegions(state, vicMemory) {
  const layout = graphicsLayout(state), bank = layout.bank;
  const regions = [
    { kind: 'zero', title: 'Zero page', start: 0, size: 256 },
    { kind: 'stack', title: 'CPU stack', start: 0x100, size: 256 },
    { kind: 'screen', title: layout.bitmapOn ? 'Bitmap colour cells' : 'Screen codes', start: bank + layout.screen, size: 1000 },
    { kind: 'pointers', title: 'Sprite pointer table', start: bank + layout.screen + 0x3f8, size: 8 },
    { kind: layout.bitmapOn ? 'bitmap' : 'characters', title: layout.bitmapOn ? 'Bitmap pixels' : 'Character patterns', start: bank + (layout.bitmapOn ? layout.bitmap : layout.characters), size: layout.bitmapOn ? 8000 : 2048 },
    { kind: 'code', title: 'Current CPU location', start: state.pc, size: 1 },
  ];
  for (let i = 0; i < 8; i++) if (state.vic[0x15] & (1 << i)) {
    const pointer = vicMemory[layout.screen + 0x3f8 + i];
    regions.push({ kind: 'sprite', title: `Sprite ${i} source`, index: i, pointer, start: bank + pointer * 64, size: 64 });
  }
  return regions;
}

export function rolesForPage(regions, page) {
  const start = page * 256;
  return regions.filter(region => region.start < start + 256 && region.start + region.size > start);
}

export function byteSummary(bytes) {
  const seen = new Uint8Array(256);
  let nonzero = 0, distinct = 0;
  for (const value of bytes) {
    if (value) nonzero++;
    if (!seen[value]) { seen[value] = 1; distinct++; }
  }
  return { nonzero, distinct };
}
