// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

export function graphicsLayout(state) {
  const r = state.vic;
  return {
    bank: state.vicBank,
    screen: (r[0x18] >>> 4) * 1024,
    characters: (r[0x18] & 14) * 1024,
    bitmap: (r[0x18] & 8) * 1024,
    bitmapOn: !!(r[0x11] & 32), multicolour: !!(r[0x16] & 16), extended: !!(r[0x11] & 64),
  };
}

export function spriteLayout(state, memory, index, latched = false) {
  const r = state.vic, layout = graphicsLayout(state), bit = 1 << index;
  const pointerAddress = layout.screen + 0x3F8 + index;
  const pointer = latched ? state.spritePointers[index] : memory[pointerAddress];
  const bank = latched ? state.spriteBanks[index] : state.vicBank;
  const offset = latched ? state.spriteOffsets[index] : pointer * 64;
  return {
    index, pointerAddress: state.vicBank + pointerAddress, pointer, bank, offset,
    address: bank + offset, enabled: !!(r[0x15] & bit), dma: !!state.spriteDma[index],
    displaying: !!state.spriteDisplay[index], multicolour: !!(r[0x1C] & bit),
    x: r[index * 2] + ((r[0x10] & bit) ? 256 : 0), y: r[index * 2 + 1],
    width: (r[0x1D] & bit) ? 48 : 24, height: (r[0x17] & bit) ? 42 : 21,
    behind: !!(r[0x1B] & bit), colour: r[0x27 + index] & 15,
  };
}

function putPixel(out, offset, colour, alpha = 255) {
  out[offset] = colour >>> 16 & 255; out[offset + 1] = colour >>> 8 & 255;
  out[offset + 2] = colour & 255; out[offset + 3] = alpha;
}

export function spritePixels(out, data, sprite, state) {
  const r = state.vic, p = state.palette;
  for (let y = 0; y < 21; y++) {
    for (let x = 0; x < 24; x++) {
      const byte = data[y * 3 + (x >>> 3)];
      const value = sprite.multicolour ? (byte >>> (6 - (x & 6))) & 3 : (byte >>> (7 - (x & 7))) & 1;
      const colour = sprite.multicolour ? (value === 1 ? r[0x25] : value === 2 ? sprite.colour : r[0x26]) & 15 : sprite.colour;
      putPixel(out, (y * 24 + x) * 4, p[colour], value ? 255 : 0);
    }
  }
}

export function characterPixels(out, memory, state) {
  const base = (state.vic[0x18] & 14) * 1024;
  for (let glyph = 0; glyph < 256; glyph++) {
    for (let row = 0; row < 8; row++) {
      const byte = memory[(base + glyph * 8 + row) & 0x3FFF];
      for (let bit = 0; bit < 8; bit++) {
        const pixel = (((glyph >>> 4) * 8 + row) * 128 + (glyph & 15) * 8 + bit) * 4;
        putPixel(out, pixel, state.palette[(byte & (128 >>> bit)) ? 1 : 0]);
      }
    }
  }
}

// A reconstruction from the current register setup, without scroll, sprites or
// mid-frame changes. It is a view of display memory, not a second VIC renderer.
export function screenPixels(out, memory, state) {
  const layout = graphicsLayout(state), r = state.vic, p = state.palette;
  const invalid = layout.extended && (layout.bitmapOn || layout.multicolour);
  for (let cell = 0; cell < 1000; cell++) {
    const code = memory[layout.screen + cell], colour = state.colorRam[cell] & 15;
    const multi = layout.multicolour && (layout.bitmapOn || (colour & 8));
    for (let row = 0; row < 8; row++) {
      const address = layout.bitmapOn ? layout.bitmap + cell * 8 + row
        : layout.characters + (layout.extended ? code & 63 : code) * 8 + row;
      const byte = memory[address & 0x3FFF];
      for (let x = 0; x < 8; x++) {
        const value = multi ? (byte >>> (6 - (x & 6))) & 3 : (byte >>> (7 - x)) & 1;
        let index;
        if (invalid) index = 0;
        else if (layout.bitmapOn) index = multi ? (value === 0 ? r[0x21] : value === 1 ? code >>> 4 : value === 2 ? code & 15 : colour) : (value ? code >>> 4 : code & 15);
        else if (multi) index = value === 3 ? colour & 7 : r[0x21 + value];
        else index = value ? colour : r[0x21 + (layout.extended ? code >>> 6 : 0)];
        putPixel(out, ((((cell / 40) | 0) * 8 + row) * 320 + (cell % 40) * 8 + x) * 4, p[index & 15]);
      }
    }
  }
}
