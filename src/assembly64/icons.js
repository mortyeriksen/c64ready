// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
const ns = 'http://www.w3.org/2000/svg';
const icons = [
  ['demo', 'Demo', /\bdemos?\b/i, '#a59bff', 'M1 2h14v10H1z M6 12h4v2h3v1H3v-1h3z', 'M3 4h10v1H3z M3 6h8v1H3z M3 8h5v1H3z'],
  ['game', 'Game', /\bgames?\b/i, '#80d7a7', 'M7 1h2v2H7z M6 3h4v2H9v5H7V5H6z M3 10h10v1h2v4H1v-4h2z', 'M4 12h3v1H4z M11 11h2v2h-2z'],
  ['intro', 'Intro', /\bintros?\b/i, '#f4cd78', 'M7 0h2v4h2v2h4v2h-4v2H9v5H7v-5H5V8H1V6h4V4h2z', 'M7 5h2v4H7z M6 6h4v2H6z'],
  ['music', 'Music', /\b(music|sid|tunes?|songs?)\b/i, '#f298c4', 'M6 2h8v10h-1v2h-4v-3h3V5H8v7H7v2H3v-3h3z', 'M8 3h4v1H8z'],
  ['graphics', 'Graphics', /\b(graphics?|pictures?|art)\b/i, '#7cd4ef', 'M1 2h14v12H1z', 'M3 4h3v3H3z M3 11l4-4 2 2 2-3 2 5z'],
  ['tools', 'Tools', /\b(tools?|utilit(?:y|ies))\b/i, '#f1b581', 'M10 1h2v3h2V1h1v5l-2 2h-2l-6 7H2v-3l7-7V3z', 'M3 12h2v1H3z'],
  ['mags', 'Magazine', /\b(mags?|magazines?|diskmags?)\b/i, '#c3d69b', 'M1 2h6l1 1 1-1h6v12H9l-1 1-1-1H1z', 'M7 4h2v8H7z M3 5h3v1H3z M10 5h3v1h-3z M3 8h3v1H3z M10 8h3v1h-3z'],
  ['charts', 'Charts', /\bcharts?\b/i, '#edcc7a', 'M1 14h14v1H1z M2 8h3v5H2z M7 5h3v8H7z M12 1h3v12h-3z', 'M3 9h1v3H3z M8 6h1v6H8z M13 2h1v10h-1z'],
  ['bbs', 'BBS', /\bbbs\b/i, '#8bd7bb', 'M1 1h14v10H1z M7 11h2v2h5v2h-2v-1H4v1H2v-2h5z', 'M3 3h2v1h1v1H5v1H3V5h1V4H3z M8 6h4v1H8z'],
  ['easyflash', 'EasyFlash', /\b(easyflash|cartridges?)\b/i, '#e7a987', 'M3 1h10v2h2v9h-3v3H4v-3H1V3h2z', 'M4 3h8v5H4z M5 12h1v2H5z M8 12h1v2H8z M10 12h1v2h-1z'],
  ['reu', 'REU', /\b(reu|ram)\b/i, '#b3a5ef', 'M4 3h8v10H4z M1 4h3v1H1z M1 7h3v1H1z M1 10h3v1H1z M12 4h3v1h-3z M12 7h3v1h-3z M12 10h3v1h-3z', 'M6 5h4v5H6z'],
  ['c128', 'C128', /\b(c128|128)\b/i, '#9cbfee', 'M3 1h10v8H3z M2 10h12l2 4H0z', 'M5 3h6v4H5z M3 11h2v1H3z M6 11h2v1H6z M9 11h2v1H9z M3 13h10v1H3z'],
  ['misc', 'Other production', /.*/, '#a6afca', 'M2 1h10l2 2v12H2z', 'M4 2h6v4H4z M4 9h8v5H4z M6 10h4v1H6z'],
];
export function typeIconFor(kind) {
  return icons.find(([, , pattern]) => pattern.test(String(kind || '')));
}
function svgIcon(paths) {
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('shape-rendering', 'crispEdges');
  for (const [d, fill] of paths) {
    const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); path.setAttribute('fill', fill); svg.append(path);
  }
  return svg;
}
export function createTypeIcon(kind) {
  const [id, label, , color, outline, detail] = typeIconFor(kind);
  const wrapper = document.createElement('span'); wrapper.className = 'mb-format-icon mb-type-icon'; wrapper.dataset.type = id;
  const svg = svgIcon([[outline, color], [detail, '#151832']]);
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label);
  wrapper.append(svg); return wrapper;
}
export function createFavoriteIcon() {
  const svg = svgIcon([['M7 1h2v3h2v2h4v2h-3v3h1v3h-3v-2H6v2H3v-3h1V8H1V6h4V4h2z', 'currentColor']]);
  svg.classList.add('mb-favorite-icon'); svg.setAttribute('aria-hidden', 'true'); return svg;
}
