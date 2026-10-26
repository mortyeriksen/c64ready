// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

export function appendPixelBits(section, pixel) {
  const g = pixel.graphics;
  if (!g) return;
  const p = document.createElement('p');
  p.textContent = g.bitCount === 2 ? 'Each pair of bits paints two neighbouring pixels.' : 'Each bit paints one pixel.';
  const strip = document.createElement('div'); strip.className = 'monitor-pixel-bits'; strip.setAttribute('aria-label', 'Source byte, bit 7 on the left');
  for (let bit = 7; bit >= 0; bit--) {
    const cell = document.createElement('span'); cell.textContent = String((pixel.value >> bit) & 1);
    cell.className = bit >= g.shift && bit < g.shift + g.bitCount ? 'selected' : ''; cell.title = `Bit ${bit}`; strip.append(cell);
  }
  const table = document.createElement('table'); table.className = 'monitor-pixel-colours';
  const head = document.createElement('tr');
  for (const label of ['Pixel code', 'Colour source']) { const th = document.createElement('th'); th.textContent = label; head.append(th); }
  table.append(head);
  g.choices.forEach((choice, index) => {
    const row = document.createElement('tr'), code = document.createElement('td'), source = document.createElement('td');
    if (index === g.code) row.className = 'selected';
    code.textContent = index.toString(2).padStart(g.bitCount, '0') + (index === g.code ? ' ←' : '');
    source.textContent = choice.label + (choice.index !== undefined ? ` · colour ${choice.index}` : ''); row.append(code, source); table.append(row);
  });
  section.append(p, strip, table);
}
