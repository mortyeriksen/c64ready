// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/ui/themes.js — colour themes: the built-in ones, the ones a user imports
// as JSON, and which one is in use.
//
// A theme is a JSON file in the c64ready-theme/2 format (/1 files, which have
// no "look", import as they are):
//
//   {
//     "format": "c64ready-theme/2",
//     "name": "GEOS",
//     "author": "optional",
//     "modes": {
//       "dark":  { "panel-bg": "#000000", "text": "#f2f2f2", ... },
//       "light": { "panel-bg": "#ffffff", "text": "#111111", ... }
//     },
//     "look": { "dark": { "pattern": "dither", "size": "small" } }
//   }
//
// The keys of a mode are the tokens of styles-theme.css (THEME_TOKENS) and every
// value is a plain colour: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb() or rgba(). The
// optional "look" names a page pattern per mode from PATTERNS; the recipes are
// the app's, and pattern-ink must stay faint (MAX_INK_ALPHA). Nothing else is
// accepted, so a file cannot reach outside the colours and the named patterns. A theme needs at
// least one mode; a mode it leaves out uses its other mode (the appearance
// switch then has nothing to switch), and a token a mode leaves out keeps the
// Classic value for that mode.
//
// Classic is the stylesheet itself and injects nothing. Any other theme becomes
// one generated rule set in <style id="c64-theme">, also kept in storage so the
// inline script in index.html can apply it before first paint (it mirrors
// themeModes() and the stored keys below; test/themes-spec-test.js checks).
//
// The pure parts (parse, modes, css) take no DOM and are unit-tested.

import { GEOS_THEME } from './themes/geos.js';
import { BREADBIN_THEME } from './themes/breadbin.js';
import { PHOSPHOR_THEME } from './themes/phosphor.js';
import { OUTRUN_THEME } from './themes/outrun.js';
import { COMMANDO_THEME } from './themes/commando.js';

export const THEME_FORMAT = 'c64ready-theme/2';
const THEME_FORMATS = ['c64ready-theme/1', THEME_FORMAT]; // /1 files import as they are
export const THEME_KEY = 'c64emu.theme';            // id of the theme in use; none = Classic
export const THEMES_KEY = 'c64emu.themes';          // imported themes, validated
export const THEME_CSS_KEY = 'c64emu.themeCss';     // the active theme's rules, for first paint
export const THEME_MODES_KEY = 'c64emu.themeModes'; // 'dark' or 'light' for a one-mode theme
export const MAX_THEME_BYTES = 64 * 1024;
export const MAX_THEME_NAME = 40;

// Every token a theme may set, in styles-theme.css order (the theme-tokens spec
// test keeps the two lists equal).
export const THEME_TOKENS = [
  'crt-bg', 'page-glow', 'pattern-ink', 'ui-bg', 'panel-bg', 'border', 'monitor-border', 'control-bg', 'field-bg-hover',
  'button-bg', 'button-text', 'button-dim', 'button-accent', 'button-accent2', 'button-green',
  'button-amber', 'button-red', 'primary-bg', 'primary-text', 'primary-dim', 'primary-accent',
  'primary-accent2', 'primary-green', 'primary-amber', 'primary-red', 'primary-border',
  'menu-bg', 'status-bg', 'dropzone-border', 'row-hover', 'dir-row-hover', 'scrollbar-thumb',
  'backdrop', 'scrim', 'shadow', 'highlight', 'text', 'dim', 'text-dim', 'text-bright',
  'on-accent', 'button-ink', 'warn-text', 'accent', 'accent2', 'accent-bright', 'accent-soft',
  'accent-pale', 'accent-deep', 'green', 'amber', 'red', 'info', 'on-green-ink',
  'logo-ramp-4', 'logo-ramp-2', 'logo-ramp-1',
  'key-down-bg', 'led-off', 'tape-motor-on', 'tape-bar-bg', 'tape-bar-hover', 'zoom-btn-bg',
  'zoom-btn-hover', 'dirzoom-bg', 'kbd-bg', 'kbd-border', 'kbd-hover', 'kbd-ink', 'vibes-text',
  'vibes-bg-1', 'vibes-bg-2', 'vibes-bg-3', 'vibes-hover-border', 'vibes-hover-bg-1',
  'vibes-hover-bg-2', 'vibes-hover-bg-3', 'dir-text', 'dir-dim', 'scope-bg', 'scope-grid',
  'scope-trace', 'touch-knob', 'touch-a', 'touch-b', 'touch-active', 'chip-ink', 'type-prg',
  'type-cbm', 'type-turbo', 'type-disk', 'type-crt', 'type-tap', 'type-t64', 'type-sid',
  'credits-bg-top', 'credits-bg-bottom', 'credits-scanline',
  'a64-row-hover', 'a64-highlight', 'a64-meta', 'a64-overlay', 'a64-fact-label',
  'a64-body', 'a64-subtle', 'a64-link', 'a64-primary-border', 'a64-primary-hover',
  'a64-text-button', 'a64-text-button-hover', 'a64-line', 'a64-tagline', 'a64-search-icon',
  'a64-tab-active', 'a64-tab-underline', 'a64-tab-hover', 'a64-sidebar-bg', 'a64-eyebrow',
  'a64-note', 'a64-main-bg', 'a64-chip-text', 'a64-chip-border', 'a64-chip-bg', 'a64-format-bg',
  'a64-format-border', 'a64-disk-text', 'a64-disk-bg', 'a64-disk-border', 'a64-crt-text',
  'a64-crt-bg', 'a64-crt-border', 'a64-tape-text', 'a64-tape-bg', 'a64-tape-border', 'a64-tag',
  'a64-rating', 'a64-star', 'a64-run-text', 'a64-run-border', 'a64-run-bg', 'a64-footer',
  'a64-hint', 'a64-empty-border', 'a64-empty-bg', 'a64-empty-text', 'a64-progress-bg',
  'a64-progress-stripe', 'a64-counter',
];
const TOKEN_SET = new Set(THEME_TOKENS);
// Tokens an earlier build exported, now gone: the splash's own colours, before
// it took each theme's ordinary tokens. A file that still has them imports
// without them.
const RETIRED_TOKENS = new Set(['power', 'power-hover', 'power-ink', 'logo-drop', 'splash-screen', 'splash-card-text', 'splash-phone']);

// Plain colours only. Channels 0–255 (or %), alpha 0–1 (or %).
const NUM = '\\s*(?:\\d{1,3}(?:\\.\\d+)?%?)\\s*';
const ALPHA = '\\s*(?:0|1|0?\\.\\d+|1\\.0+|\\d{1,3}(?:\\.\\d+)?%)\\s*';
const COLOUR = new RegExp(`^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgb\\(${NUM},${NUM},${NUM}\\)|rgba\\(${NUM},${NUM},${NUM},${ALPHA}\\))$`, 'i');
export const isThemeColour = (v) => typeof v === 'string' && v.length <= 40 && COLOUR.test(v.trim());

const fail = (error) => ({ error });

// Page patterns. A theme names one per mode in its "look"; the app owns every
// recipe, so a theme file carries no CSS. Each recipe is drawn in
// var(--pattern-ink) behind the panels (body's --page-pattern layer, over the
// page glow) and returns the layers' images and their sizes, one per layer.
export const PATTERN_SIZES = ['small', 'medium', 'large'];
const PATTERNS = {
  none: null,
  // A checkerboard, like the GEOS desktop.
  dither: (n) => ({ image: 'repeating-conic-gradient(var(--pattern-ink) 0 25%, transparent 0 50%)', size: `${2 * n}px ${2 * n}px` }),
  // Wide horizontal bands, like green-bar printer paper.
  bars: (n) => ({ image: 'linear-gradient(var(--pattern-ink) 50%, transparent 50%)', size: `100% ${24 * n}px` }),
  // Thin horizontal lines, like a monitor's scanlines.
  scanlines: (n) => ({ image: 'linear-gradient(var(--pattern-ink) 1px, transparent 1px)', size: `100% ${n + 1}px` }),
  // A square grid of thin lines.
  grid: (n) => ({
    image: 'linear-gradient(var(--pattern-ink) 1px, transparent 1px), linear-gradient(90deg, var(--pattern-ink) 1px, transparent 1px)',
    size: `${16 * n}px ${16 * n}px, ${16 * n}px ${16 * n}px`,
  }),
  // A grid of small dots.
  dots: (n) => ({ image: 'radial-gradient(circle, var(--pattern-ink) 1px, transparent 1.5px)', size: `${6 * n}px ${6 * n}px` }),
  // Fine diagonal crosshatch, like a woven or textured surface.
  weave: (n) => ({
    image: `repeating-linear-gradient(45deg, var(--pattern-ink) 0 1px, transparent 1px ${5 * n}px), repeating-linear-gradient(-45deg, var(--pattern-ink) 0 1px, transparent 1px ${5 * n}px)`,
    size: 'auto, auto',
  }),
};
export const PATTERN_NAMES = Object.keys(PATTERNS);
// Classic's own pattern: a large, faint grid. It is the stylesheet's default
// (styles-base.css, kept equal to this recipe by the themes test), so Classic
// injects nothing; a theme whose look names no pattern sets it back to none.
export const CLASSIC_LOOK = { dark: { pattern: 'grid', size: 'large' }, light: { pattern: 'grid', size: 'large' } };
const SIZE_STEP = { small: 1, medium: 2, large: 3 };
export const patternLayers = (pattern, size = 'medium') => (PATTERNS[pattern] ? PATTERNS[pattern](SIZE_STEP[size] ?? 2) : null);

// The ink sits under the header text on the page, so it has to stay faint.
export const MAX_INK_ALPHA = 0.15;
export function colourAlpha(v) {
  const s = v.trim().toLowerCase();
  if (s.startsWith('#')) {
    const h = s.slice(1);
    if (h.length === 4) return parseInt(h[3] + h[3], 16) / 255;
    if (h.length === 8) return parseInt(h.slice(6), 16) / 255;
    return 1;
  }
  const m = s.match(/^rgba\(.*,\s*([\d.]+)(%?)\s*\)$/);
  if (!m) return 1;
  return m[2] ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
}

// A theme's "look": per mode, a page pattern and its size. Returns { look }
// with only what is valid kept, or { error }. Lenient drops what it cannot use.
function validateLook(obj, modes, lenient) {
  if (obj === undefined) return { look: null };
  const bad = (error) => (lenient ? { look: null } : fail(error));
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return bad('"look" should be an object with "dark", "light" or both.');
  const look = {};
  for (const [mode, set] of Object.entries(obj)) {
    if (mode !== 'dark' && mode !== 'light') { if (lenient) continue; return fail(`Unknown mode "${mode}" in "look": its modes are "dark" and "light".`); }
    if (!set || typeof set !== 'object' || Array.isArray(set)) { if (lenient) continue; return fail(`"look" mode "${mode}" should be an object.`); }
    const out = {};
    for (const [key, value] of Object.entries(set)) {
      if (key === 'pattern') {
        if (!PATTERN_NAMES.includes(value)) { if (lenient) continue; return fail(`"pattern" in "look" mode "${mode}" should be one of ${PATTERN_NAMES.join(', ')}.`); }
        out.pattern = value;
      } else if (key === 'size') {
        if (!PATTERN_SIZES.includes(value)) { if (lenient) continue; return fail(`"size" in "look" mode "${mode}" should be one of ${PATTERN_SIZES.join(', ')}.`); }
        out.size = value;
      } else if (!lenient) {
        return fail(`Unknown setting "${key}" in "look" mode "${mode}": a look has "pattern" and "size".`);
      }
    }
    // A look for a mode the theme does not have has nothing to apply to.
    if (modes[mode] && out.pattern && out.pattern !== 'none') look[mode] = out;
  }
  return { look: Object.keys(look).length ? look : null };
}

// Check a theme object (already JSON-parsed). Returns { theme } with only the
// known fields kept, or { error } with a sentence saying what to fix.
// `lenient` skips colours this build does not know instead of refusing the
// theme: for themes already stored, so a colour renamed in a later release
// costs that colour, not the whole theme.
export function validateTheme(obj, { lenient = false } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return fail('The file is not a theme: it should be a JSON object.');
  if (!THEME_FORMATS.includes(obj.format)) return fail(`The file is not a C64 READY. theme: "format" should be "${THEME_FORMAT}".`);
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!name) return fail('The theme needs a "name".');
  if (name.length > MAX_THEME_NAME) return fail(`The theme's name is too long: ${MAX_THEME_NAME} characters at most.`);
  if (/^classic$/i.test(name)) return fail('"Classic" is the built-in theme\'s name; give this one another.');
  const author = typeof obj.author === 'string' ? obj.author.trim().slice(0, 60) : '';
  if (!obj.modes || typeof obj.modes !== 'object' || Array.isArray(obj.modes)) return fail('The theme needs "modes", with "dark", "light" or both.');
  for (const key of Object.keys(obj.modes)) {
    if (key !== 'dark' && key !== 'light') return fail(`Unknown mode "${key}": a theme's modes are "dark" and "light".`);
  }
  const modes = {};
  for (const mode of ['dark', 'light']) {
    const set = obj.modes[mode];
    if (set === undefined) continue;
    if (!set || typeof set !== 'object' || Array.isArray(set)) return fail(`Mode "${mode}" should be an object of colours.`);
    const out = {};
    for (const [token, value] of Object.entries(set)) {
      if (!TOKEN_SET.has(token)) {
        if (lenient || RETIRED_TOKENS.has(token)) continue;
        return fail(`Unknown colour "${token}" in mode "${mode}". Export the Classic theme to see every colour a theme can set.`);
      }
      if (!isThemeColour(value)) return fail(`"${token}" in mode "${mode}" is not a colour: use #rrggbb, #rgb, rgb() or rgba().`);
      if (token === 'pattern-ink' && colourAlpha(value) > MAX_INK_ALPHA) {
        if (lenient) continue;
        return fail(`"pattern-ink" in mode "${mode}" is too strong for text to stay readable over it: give it an alpha of ${MAX_INK_ALPHA} or less, as in rgba(0, 0, 0, 0.1).`);
      }
      out[token] = value.trim();
    }
    modes[mode] = out;
  }
  if (!modes.dark && !modes.light) return fail('The theme needs at least one mode: "dark" or "light".');
  const { look, error } = validateLook(obj.look, modes, lenient);
  if (error) return fail(error);
  return { theme: { name, author, modes, ...(look ? { look } : {}) } };
}

export function parseTheme(text) {
  if (typeof text !== 'string') return fail('The file could not be read.');
  if (text.length > MAX_THEME_BYTES) return fail(`The file is too large for a theme: ${MAX_THEME_BYTES / 1024} KB at most.`);
  let obj;
  try { obj = JSON.parse(text); } catch { return fail('The file is not valid JSON.'); }
  return validateTheme(obj);
}

// A button colour a theme leaves out is the theme's own general colour, and a
// primary button colour its button colour (the border its border), so a theme
// that does not part buttons from fields looks as it always did. In order:
// the primary colours read the button colours filled before them.
const BUTTON_SOURCES = {
  'button-bg': 'control-bg', 'button-text': 'text', 'button-dim': 'dim', 'button-accent': 'accent',
  'button-accent2': 'accent2', 'button-green': 'green', 'button-amber': 'amber', 'button-red': 'red',
  'primary-bg': 'button-bg', 'primary-text': 'button-text', 'primary-dim': 'button-dim',
  'primary-accent': 'button-accent', 'primary-accent2': 'button-accent2', 'primary-green': 'button-green',
  'primary-amber': 'button-amber', 'primary-red': 'button-red', 'primary-border': 'border',
};
export function withButtonColours(set) {
  const out = { ...set };
  for (const [button, source] of Object.entries(BUTTON_SOURCES)) {
    if (out[button] === undefined && out[source] !== undefined) out[button] = out[source];
  }
  return out;
}

// 'both', or the one mode a theme has (the appearance is then pinned to it).
export function themeModes(theme) {
  if (!theme || (theme.modes.dark && theme.modes.light)) return 'both';
  return theme.modes.dark ? 'dark' : 'light';
}

// The theme's rules. :root:root outranks styles-theme.css (one :root more)
// wherever the style element lands in <head>. The dark colours also go to the
// monitor (its frame, the touch controls), which stays dark in light mode and
// otherwise keeps Classic's. The first-visit splash wears a built-in theme of
// its own (tools/splash-themes.mjs, from themeModeSet below).
const DEFAULT_INK_ALPHA = 0.07;
// One mode's custom properties as the page gets them: the theme's colours,
// the button colours that follow them, and its page pattern.
export function themeModeSet(theme, m) {
  const set = withButtonColours(theme.modes[m]);
  const layers = patternLayers(theme.look?.[m]?.pattern, theme.look?.[m]?.size);
  if (layers) {
    // A pattern with no ink of its own is drawn in the theme's text colour, faintly.
    if (!set['pattern-ink'] && /^#[0-9a-f]{6}$/i.test(set.text || '')) {
      set['pattern-ink'] = `rgba(${[1, 3, 5].map((i) => parseInt(set.text.slice(i, i + 2), 16)).join(', ')}, ${DEFAULT_INK_ALPHA})`;
    }
    set['page-pattern'] = layers.image;
    set['page-pattern-size'] = layers.size;
  } else {
    set['page-pattern'] = 'none';
    set['page-pattern-size'] = 'auto';
  }
  return set;
}
export function themeCss(theme) {
  if (!theme) return '';
  return ['dark', 'light'].filter((m) => theme.modes[m]).map((m) => {
    const set = themeModeSet(theme, m);
    const decls = Object.entries(set).map(([k, v]) => `--${k}: ${v};`).join(' ');
    const sel = m === 'dark' ? `:root:root[data-mode="dark"], :root:root .c64-monitor.mode-dark` : `:root:root[data-mode="light"]`;
    return `${sel} { ${decls} }`;
  }).join('\n');
}

// ── Built-in and imported themes ────────────────────────────────────────────

export const CLASSIC = { id: 'classic', name: 'Classic', builtin: true, theme: null };
const BUILTIN = [
  CLASSIC,
  { id: 'geos', name: 'GEOS', builtin: true, theme: validateTheme(GEOS_THEME).theme },
  { id: 'breadbin', name: 'Breadbin', builtin: true, theme: validateTheme(BREADBIN_THEME).theme },
  { id: 'phosphor', name: 'Phosphor', builtin: true, theme: validateTheme(PHOSPHOR_THEME).theme },
  { id: 'outrun', name: 'Out Run', builtin: true, theme: validateTheme(OUTRUN_THEME).theme },
  { id: 'commando', name: 'Commando', builtin: true, theme: validateTheme(COMMANDO_THEME).theme },
];

// The built-in themes, in the order THEME steps through them.
export const BUILTIN_THEMES = BUILTIN;

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'theme';

// Imported themes as stored: each re-validated, anything broken dropped.
export function parseStoredThemes(raw) {
  let list;
  try { list = JSON.parse(raw || '[]'); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item.id !== 'string' || !item.id.startsWith('user:')) continue;
    const { theme } = validateTheme({ format: THEME_FORMAT, ...item.theme }, { lenient: true });
    if (theme) out.push({ id: item.id, name: theme.name, builtin: false, theme });
  }
  return out;
}

// The file Export saves: the theme with every token in both modes it has, the
// gaps filled from Classic, so it is ready to edit. A button or primary colour
// the theme leaves out stays out: it follows the colour it derives from, and
// writing it down would cut it off from later edits to that colour.
export function exportTheme(entry, classic) {
  const modes = {};
  const has = entry.theme ? entry.theme.modes : { dark: {}, light: {} };
  for (const m of ['dark', 'light']) {
    if (!has[m]) continue;
    modes[m] = {};
    for (const t of THEME_TOKENS) {
      if ((t in BUTTON_SOURCES || t === 'pattern-ink') && has[m][t] === undefined) continue;
      modes[m][t] = has[m][t] ?? classic[m][t];
    }
  }
  const own = entry.theme ? entry.theme.look : CLASSIC_LOOK;
  const look = own ? Object.fromEntries(Object.entries(own).filter(([m]) => modes[m])) : null;
  return { format: THEME_FORMAT, name: entry.name, ...(entry.theme?.author ? { author: entry.theme.author } : {}), modes,
    ...(look && Object.keys(look).length ? { look } : {}) };
}

// ── In the page ─────────────────────────────────────────────────────────────

function readClassic() {
  // Classic's values, from the stylesheet itself: the dark block and the light one.
  const out = { dark: {}, light: {} };
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    const walk = (list) => {
      for (const r of list) {
        // @import keeps its rules on its own sheet; @media and the like inline.
        if (r.styleSheet) { try { walk(r.styleSheet.cssRules); } catch { /* not readable */ } continue; }
        if (r.cssRules && !r.selectorText) { walk(r.cssRules); continue; }
        const sel = (r.selectorText || '').replace(/\s+/g, ' ');
        const mode = sel === ':root, .mode-dark' ? 'dark' : sel === ':root[data-mode="light"]' ? 'light' : null;
        if (!mode) continue;
        for (const t of THEME_TOKENS) { const v = r.style.getPropertyValue('--' + t).trim(); if (v) out[mode][t] = v; }
      }
    };
    walk(rules);
  }
  for (const t of THEME_TOKENS) out.light[t] ??= out.dark[t];
  return out;
}

export function initThemes({ cycleButton, importButton, exportButton, removeButton, fileInput, notify, confirm }) {
  const root = document.documentElement;
  let imported = (() => { try { return parseStoredThemes(localStorage.getItem(THEMES_KEY)); } catch { return []; } })();
  const all = () => [...BUILTIN, ...imported];
  let current = (() => { let id = null; try { id = localStorage.getItem(THEME_KEY); } catch {} return all().find((t) => t.id === id) || CLASSIC; })();

  const saveImported = () => {
    try { localStorage.setItem(THEMES_KEY, JSON.stringify(imported.map((t) => ({ id: t.id, theme: t.theme })))); }
    catch { notify('The theme could not be saved in this browser: its storage is full or switched off. It applies until you reload.'); }
  };

  const apply = () => {
    const css = themeCss(current.theme);
    const modes = themeModes(current.theme);
    let style = document.getElementById('c64-theme');
    if (css && !style) { style = document.createElement('style'); style.id = 'c64-theme'; document.head.appendChild(style); }
    if (style) style.textContent = css;
    if (modes === 'both') delete root.dataset.themeModes; else root.dataset.themeModes = modes;
    try {
      if (current === CLASSIC) { localStorage.removeItem(THEME_KEY); localStorage.removeItem(THEME_CSS_KEY); localStorage.removeItem(THEME_MODES_KEY); }
      else {
        localStorage.setItem(THEME_KEY, current.id);
        localStorage.setItem(THEME_CSS_KEY, css);
        if (modes === 'both') localStorage.removeItem(THEME_MODES_KEY); else localStorage.setItem(THEME_MODES_KEY, modes);
      }
    } catch { /* storage off: the theme lasts this session */ }
    if (cycleButton) cycleButton.textContent = `THEME: ${current.name.toUpperCase()}`;
    if (removeButton) removeButton.disabled = current.builtin;
    // Appearance re-resolves the mode (a one-mode theme pins it) and tells
    // anything that paints colours itself to redraw.
    window.dispatchEvent(new Event('c64-theme'));
  };

  const select = (entry) => { current = entry; apply(); };

  const cycle = () => {
    const list = all();
    select(list[(list.indexOf(current) + 1) % list.length]);
  };
  cycleButton?.addEventListener('click', cycle);

  importButton?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > MAX_THEME_BYTES) { notify(`"${file.name}" is too large for a theme: ${MAX_THEME_BYTES / 1024} KB at most.`); return; }
    const { theme, error } = parseTheme(await file.text());
    if (error) { notify(`"${file.name}" could not be imported. ${error}`); return; }
    if (BUILTIN.some((b) => b.name.toLowerCase() === theme.name.toLowerCase())) {
      notify(`"${theme.name}" is the name of a built-in theme; give the imported one another name.`);
      return;
    }
    // A theme with the same name replaces the earlier import, so re-importing
    // an edited file updates it rather than piling up copies.
    const same = imported.find((t) => t.name.toLowerCase() === theme.name.toLowerCase());
    const entry = { id: same?.id || `user:${slug(theme.name)}-${Date.now().toString(36)}`, name: theme.name, builtin: false, theme };
    imported = same ? imported.map((t) => (t === same ? entry : t)) : [...imported, entry];
    saveImported();
    select(entry);
  });

  exportButton?.addEventListener('click', () => {
    const data = JSON.stringify(exportTheme(current, readClassic()), null, 2) + '\n';
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `c64ready-${slug(current.name)}.theme.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  removeButton?.addEventListener('click', async () => {
    if (current.builtin) return;
    if (!(await confirm(`Remove the theme "${current.name}" from this browser? You can import its file again later.`))) return;
    imported = imported.filter((t) => t !== current);
    saveImported();
    select(CLASSIC);
  });

  // Another tab imported, removed or picked a theme: take its lists as they now
  // are, so this tab neither shows a stale theme nor writes a stale list back.
  window.addEventListener('storage', (e) => {
    if (e.key !== THEMES_KEY && e.key !== THEME_KEY) return;
    try { imported = parseStoredThemes(localStorage.getItem(THEMES_KEY)); } catch { imported = []; }
    let id = null; try { id = localStorage.getItem(THEME_KEY); } catch {}
    current = all().find((t) => t.id === id) || CLASSIC;
    apply();
  });

  // A first visitor leaving the splash keeps the theme it wore (src/ui/splash.js),
  // unless a theme is already chosen.
  window.addEventListener('c64-splash-leaving', (e) => {
    let chosen = null; try { chosen = localStorage.getItem(THEME_KEY); } catch {}
    const entry = BUILTIN.find((t) => t.id === e.detail?.theme);
    if (!chosen && entry) select(entry);
  });

  apply();
  return { current: () => current, themes: all, cycle };
}
