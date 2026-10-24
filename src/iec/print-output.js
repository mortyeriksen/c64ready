// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const WIDTH = 6120, HEIGHT = 7920;
function marks(page) {
  return page.map(op => op.path
    ? `<path d="${xml(op.path)}"/>`
    : `<text x="${xml(op.x)}" y="${xml(op.y)}" font-family="monospace" font-size="100" textLength="${xml(op.width)}" lengthAdjust="spacingAndGlyphs" xml:space="preserve">${xml(op.text)}</text>`).join('');
}
const paper = (page, index = 0) => `<g transform="translate(0 ${index * HEIGHT})"><rect width="${WIDTH}" height="${HEIGHT}" fill="white"/><g transform="translate(180 180)" fill="black">${marks(page)}</g></g>`;
const svg = (contents, count = 1) => `<svg xmlns="http://www.w3.org/2000/svg" width="612" height="${792 * count}" viewBox="0 0 ${WIDTH} ${HEIGHT * count}" role="img" aria-label="Printer output">${contents}</svg>`;

// SVG stacks pages in one image. HTML keeps separate Letter pages for printing.
export function renderPrintOutput(pages, format) {
  if (format === 'svg') return `<?xml version="1.0" encoding="UTF-8"?>\n${svg(pages.map(paper).join(''), Math.max(1, pages.length))}\n`;
  if (format !== 'html') throw new Error('Printer output supports svg or html');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Printer output · C64 READY.</title><style>
@page { size: letter; margin: 0; }
body { margin: 0; background: white; color: black; }
svg { display: block; width: 8.5in; height: 11in; break-after: page; break-inside: avoid; }
svg:last-child { break-after: auto; }
svg text { white-space: pre; }
</style></head><body>${pages.map(page => svg(paper(page))).join('')}</body></html>\n`;
}
