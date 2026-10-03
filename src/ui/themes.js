// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/ui/themes.js — colour themes: the built-in ones, the ones a user imports
// as JSON, and which one is in use.
//
// A theme is a JSON file in the c64ready-theme/1 format:
//
//   {
//     "format": "c64ready-theme/1",
//     "name": "GEOS",
//     "author": "optional",
//     "modes": {
//       "dark":  { "panel-bg": "#000000", "text": "#f2f2f2", ... },
//       "light": { "panel-bg": "#ffffff", "text": "#111111", ... }
//     }
//   }
//
// The keys are the tokens of styles-theme.css (THEME_TOKENS) and every value is
// a plain colour: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb() or rgba(). Nothing else
// is accepted, so a file cannot reach outside the colours. A theme needs at
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

export const THEME_FORMAT = 'c64ready-theme/1';
export const THEME_KEY = 'c64emu.theme';            // id of the theme in use; none = Classic
export const THEMES_KEY = 'c64emu.themes';          // imported themes, validated
export const THEME_CSS_KEY = 'c64emu.themeCss';     // the active theme's rules, for first paint
export const THEME_MODES_KEY = 'c64emu.themeModes'; // 'dark' or 'light' for a one-mode theme
export const MAX_THEME_BYTES = 64 * 1024;
export const MAX_THEME_NAME = 40;

// Every token a theme may set, in styles-theme.css order (the theme-tokens spec
// test keeps the two lists equal).
export const THEME_TOKENS = [
  'crt-bg', 'page-glow', 'ui-bg', 'panel-bg', 'border', 'monitor-border', 'control-bg', 'field-bg-hover',
  'menu-bg', 'status-bg', 'dropzone-border', 'row-hover', 'dir-row-hover', 'scrollbar-thumb',
  'backdrop', 'scrim', 'shadow', 'highlight', 'text', 'dim', 'text-dim', 'text-bright',
  'on-accent', 'button-ink', 'warn-text', 'accent', 'accent2', 'accent-bright', 'accent-soft',
  'accent-pale', 'accent-deep', 'green', 'amber', 'red', 'info', 'on-green-ink', 'power',
  'power-hover', 'power-ink', 'logo-drop', 'logo-ramp-4', 'logo-ramp-2', 'logo-ramp-1',
  'key-down-bg', 'led-off', 'tape-motor-on', 'tape-bar-bg', 'tape-bar-hover', 'zoom-btn-bg',
  'zoom-btn-hover', 'dirzoom-bg', 'kbd-bg', 'kbd-border', 'kbd-hover', 'kbd-ink', 'vibes-text',
  'vibes-bg-1', 'vibes-bg-2', 'vibes-bg-3', 'vibes-hover-border', 'vibes-hover-bg-1',
  'vibes-hover-bg-2', 'vibes-hover-bg-3', 'dir-text', 'dir-dim', 'scope-bg', 'scope-grid',
  'scope-trace', 'touch-knob', 'touch-a', 'touch-b', 'touch-active', 'chip-ink', 'type-prg',
  'type-cbm', 'type-turbo', 'type-disk', 'type-crt', 'type-tap', 'type-t64', 'type-sid',
  'credits-bg-top', 'credits-bg-bottom', 'credits-scanline', 'splash-screen', 'splash-card-text',
  'splash-phone', 'a64-row-hover', 'a64-highlight', 'a64-meta', 'a64-overlay', 'a64-fact-label',
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

// Plain colours only. Channels 0–255 (or %), alpha 0–1 (or %).
const NUM = '\\s*(?:\\d{1,3}(?:\\.\\d+)?%?)\\s*';
const ALPHA = '\\s*(?:0|1|0?\\.\\d+|1\\.0+|\\d{1,3}(?:\\.\\d+)?%)\\s*';
const COLOUR = new RegExp(`^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgb\\(${NUM},${NUM},${NUM}\\)|rgba\\(${NUM},${NUM},${NUM},${ALPHA}\\))$`, 'i');
export const isThemeColour = (v) => typeof v === 'string' && v.length <= 40 && COLOUR.test(v.trim());

const fail = (error) => ({ error });

// Check a theme object (already JSON-parsed). Returns { theme } with only the
// known fields kept, or { error } with a sentence saying what to fix.
// `lenient` skips colours this build does not know instead of refusing the
// theme: for themes already stored, so a colour renamed in a later release
// costs that colour, not the whole theme.
export function validateTheme(obj, { lenient = false } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return fail('The file is not a theme: it should be a JSON object.');
  if (obj.format !== THEME_FORMAT) return fail(`The file is not a C64 READY. theme: "format" should be "${THEME_FORMAT}".`);
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
        if (lenient) continue;
        return fail(`Unknown colour "${token}" in mode "${mode}". Export the Classic theme to see every colour a theme can set.`);
      }
      if (!isThemeColour(value)) return fail(`"${token}" in mode "${mode}" is not a colour: use #rrggbb, #rgb, rgb() or rgba().`);
      out[token] = value.trim();
    }
    modes[mode] = out;
  }
  if (!modes.dark && !modes.light) return fail('The theme needs at least one mode: "dark" or "light".');
  return { theme: { name, author, modes } };
}

export function parseTheme(text) {
  if (typeof text !== 'string') return fail('The file could not be read.');
  if (text.length > MAX_THEME_BYTES) return fail(`The file is too large for a theme: ${MAX_THEME_BYTES / 1024} KB at most.`);
  let obj;
  try { obj = JSON.parse(text); } catch { return fail('The file is not valid JSON.'); }
  return validateTheme(obj);
}

// 'both', or the one mode a theme has (the appearance is then pinned to it).
export function themeModes(theme) {
  if (!theme || (theme.modes.dark && theme.modes.light)) return 'both';
  return theme.modes.dark ? 'dark' : 'light';
}

// The theme's rules. :root:root outranks styles-theme.css (one :root more)
// wherever the style element lands in <head>. The dark colours also go to the
// monitor (its frame, the touch controls), which stays dark in light mode and
// otherwise keeps Classic's; the splash keeps Classic's whatever the theme.
export function themeCss(theme) {
  if (!theme) return '';
  return ['dark', 'light'].filter((m) => theme.modes[m]).map((m) => {
    const decls = Object.entries(theme.modes[m]).map(([k, v]) => `--${k}: ${v};`).join(' ');
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
// gaps filled from Classic, so it is complete and ready to edit.
export function exportTheme(entry, classic) {
  const modes = {};
  const has = entry.theme ? entry.theme.modes : { dark: {}, light: {} };
  for (const m of ['dark', 'light']) {
    if (!has[m]) continue;
    modes[m] = {};
    for (const t of THEME_TOKENS) modes[m][t] = has[m][t] ?? classic[m][t];
  }
  return { format: THEME_FORMAT, name: entry.name, ...(entry.theme?.author ? { author: entry.theme.author } : {}), modes };
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

  apply();
  return { current: () => current, themes: all, cycle };
}
