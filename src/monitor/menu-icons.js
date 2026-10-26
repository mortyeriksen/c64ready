// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

// Monochrome 16 × 16 glyphs inherit the surrounding text's theme and selected colour.
const PATHS = {
  back: 'M5 2H3v2H1v2H0v2h1v2h2v2h2V8h6v1h1v2h-1v1H7v2h5v-1h2v-2h1V8h-1V6h-2V5H5z',
  setup: 'M1 8h3V5h2V2h2v10h2V8h2V5h2v3h1v2h-3v4H6V6H5v4H1z',
  code: 'M2 3h2v2h2v2h2v2H6v2H4v2H2v-2h2V9h2V7H4V5H2zM9 11h6v2H9z',
  atlas: 'M4 2h1V0h2v2h2V0h2v2h1v2h2v2h-2v2h2v2h-2v2h-1v2H9v-2H7v2H5v-2H4v-2H2v-2h2V6H2V4h2zM6 4v6h4V4z',
  frame: 'M2 1h12v1h1v10h-1v1h-4v1h2v1H4v-1h2v-1H2v-1H1V2h1zM3 3v8h10V3zM4 4h8v1H4zM4 7h8v1H4z',
  sid: 'M2 10h2v4H2zM6 6h2v8H6zM10 2h2v12h-2zM2 7h2v2H2zM6 3h2v2H6zM10 0h2v1h-2z',
  controls: 'M6 1h4v1h1v3h-1v1H9v5H7V6H6V5H5V2h1zM2 10h4v2H3v2h10v-2h-3v-2h4v1h1v4H1v-4h1zM11 9h2v2h-2z',
  storage: 'M2 1h11v1h1v1h1v12H1V1zM4 2v4h7V2zM9 2v3h1V2zM4 9v5h8V9zM5 10h6v1H5zM5 12h6v1H5z',
};

export function menuIcon(view) {
  return `<svg class="monitor-menu-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" fill-rule="evenodd" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><path d="${PATHS[view]}"/></svg>`;
}
