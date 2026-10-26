// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

export const PREVIEWS = {
  tiles: { width: 64, height: 32, note: 'Eight bytes make an 8 × 8 tile, highest bit on the left. This is a raw interpretation, not a detected character set.' },
  upper: { width: 128, height: 128, note: 'Each byte selects a character from the uppercase/graphics ROM set. Sixteen characters per row here, not the C64 screen layout. Custom character sets will look different.' },
  lower: { width: 128, height: 128, note: 'Each byte selects a character from the lowercase/uppercase ROM set. Sixteen characters per row here, not the C64 screen layout. Custom character sets will look different.' },
  sprites: { width: 48, height: 42, note: 'Four 24 × 21 monochrome sprites, each in a 64-byte slot. The last byte in each slot is unused. Multicolour and expansion are not applied.' },
};

// Writes a monochrome mask into reusable caller storage. No machine access.
export function previewMask(bytes, start, mode, charRom, out) {
  const { width, height } = PREVIEWS[mode];
  out.fill(0, 0, width * height);
  const characters = mode === 'upper' || mode === 'lower';
  const sprite = mode === 'sprites';
  const tileWidth = sprite ? 24 : 8;
  const tileHeight = sprite ? 21 : 8;
  const columns = width / tileWidth;
  const count = sprite ? 4 : characters ? 256 : 32;
  for (let tile = 0; tile < count; tile++) {
    const origin = ((tile / columns) | 0) * tileHeight * width + (tile % columns) * tileWidth;
    for (let row = 0; row < tileHeight; row++) {
      for (let octet = 0; octet < tileWidth / 8; octet++) {
        const value = characters
          ? (charRom?.[(mode === 'lower' ? 2048 : 0) + bytes[start + tile] * 8 + row] ?? 0)
          : bytes[start + tile * (sprite ? 64 : 8) + row * (sprite ? 3 : 1) + octet];
        for (let bit = 0; bit < 8; bit++) out[origin + row * width + octet * 8 + bit] = (value >>> (7 - bit)) & 1;
      }
    }
  }
}
