// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

// Bauer §3.7.3: decode a graphics byte with the controls at the output phase.
export function decodeGraphicsPixel({ d011, d016, matrix, colour, value, offset }) {
  const bitmap = !!(d011 & 0x20), extended = !!(d011 & 0x40), multi = !!(d016 & 0x10);
  const invalid = extended && (bitmap || multi);
  const paired = multi && (bitmap || !!(colour & 8));
  const shift = paired ? 6 - (offset & 6) : 7 - offset;
  const code = (value >> shift) & (paired ? 3 : 1);
  const background = index => ({ label: `Background ${index} ($D02${index + 1})`, register: 0x21 + index });
  const fixed = (label, index) => ({ label, index });
  let mode, choices;
  if (invalid) {
    mode = bitmap ? multi ? 'Invalid bitmap mode 2' : 'Invalid bitmap mode 1' : 'Invalid text mode';
    choices = Array.from({ length: paired ? 4 : 2 }, () => fixed('Black output', 0));
  } else if (bitmap) {
    mode = multi ? 'Multicolour bitmap' : 'Standard bitmap';
    const high = fixed('Screen byte, upper four bits', matrix >> 4);
    const low = fixed('Screen byte, lower four bits', matrix & 15);
    choices = multi ? [background(0), high, low, fixed('Colour RAM', colour)] : [low, high];
  } else if (extended) {
    mode = 'Extended-background text';
    choices = [background(matrix >> 6), fixed('Colour RAM', colour)];
  } else if (paired) {
    mode = 'Multicolour text';
    choices = [background(0), background(1), background(2), fixed('Colour RAM, lower three bits', colour & 7)];
  } else {
    mode = multi ? 'Multicolour text, single-colour character' : 'Standard text';
    choices = [background(0), fixed('Colour RAM', colour)];
  }
  return {
    mode, code, choices, selected: choices[code], shift, bitCount: paired ? 2 : 1,
    foreground: paired ? code >= 2 : code === 1,
    character: bitmap ? null : extended ? matrix & 63 : matrix,
    rule: invalid ? bitmap ? multi ? '3.7.3.8' : '3.7.3.7' : '3.7.3.6'
      : bitmap ? multi ? '3.7.3.4' : '3.7.3.3' : extended ? '3.7.3.5' : multi ? '3.7.3.2' : '3.7.3.1',
  };
}
