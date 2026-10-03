// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/ui/appearance.js — dark, light or system appearance.
//
// The setting is one of 'dark', 'light' or 'system' (the default, stored as no
// entry at all). 'system' follows the OS colour scheme, live. The resolved mode
// lands on <html data-mode="dark|light">, which selects the token values in
// styles-theme.css; elements marked .mode-dark keep the dark values whatever
// the mode (the monitor, the splash, the machine's own readouts).
//
// The inline script at the top of <body> in index.html applies the stored
// choice before first paint, so a reload never flashes the other mode. It
// mirrors parseAppearance() and resolveMode() here, and applies the stored
// theme (src/ui/themes.js); keep them in sync
// (test/appearance-spec-test.js checks they agree).
//
// The pure parts (parse, resolve, cycle) take no DOM and are unit-tested.

export const APPEARANCE_KEY = 'c64emu.appearance';
export const APPEARANCES = ['dark', 'light', 'system'];

// Storage may hold anything an older build or a hand-edit left; only the two
// explicit choices count, everything else is the default.
export function parseAppearance(raw) {
  return raw === 'dark' || raw === 'light' ? raw : 'system';
}

// A theme with only one mode pins it: its other mode would be the same one.
export function resolveMode(appearance, systemPrefersDark, themeModes = 'both') {
  if (themeModes === 'dark' || themeModes === 'light') return themeModes;
  if (appearance === 'dark' || appearance === 'light') return appearance;
  return systemPrefersDark ? 'dark' : 'light';
}

// The header button's order, starting from the default: system → the mode
// the system is not showing → the system's own mode → system. So the first
// click always changes what is on screen, and so does the second; only the
// step back to system cannot, as system shows the mode just left.
//   dark OS:  system → light → dark → system
//   light OS: system → dark → light → system
export function nextAppearance(appearance, systemPrefersDark) {
  const os = systemPrefersDark ? 'dark' : 'light';
  const other = systemPrefersDark ? 'light' : 'dark';
  const now = parseAppearance(appearance);
  return now === 'system' ? other : now === other ? os : 'system';
}

const LABELS = { dark: 'Dark', light: 'Light', system: 'System' };

// Icons for the header button, one per setting: a moon, a sun, and a screen
// for "follow the system".
const ICONS = {
  dark: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  system: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
};

function readStored() {
  try { return parseAppearance(localStorage.getItem(APPEARANCE_KEY)); } catch { return 'system'; }
}

function store(appearance) {
  try {
    if (appearance === 'system') localStorage.removeItem(APPEARANCE_KEY);
    else localStorage.setItem(APPEARANCE_KEY, appearance);
  } catch { /* storage off: the choice lasts this session */ }
}

// A token's current value, for code that paints colours itself (canvas). Reads
// the page's values, so it is for areas that follow the mode, not .mode-dark.
export function themeColor(name, fallback) {
  try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; }
  catch { return fallback; }
}

export const isLightMode = () => document.documentElement.dataset.mode === 'light';

// Wire the header button and the Options toggle. Returns the current setting's
// getter so callers can read it; fires 'c64-appearance' on window whenever the
// resolved mode changes, for anything that paints colours from script.
export function initAppearance({ headerButton, optionsButton } = {}) {
  const root = document.documentElement;
  const query = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  let appearance = readStored();

  const apply = (force = false) => {
    const mode = resolveMode(appearance, query ? query.matches : true, root.dataset.themeModes);
    const changed = force || root.dataset.mode !== mode;
    root.dataset.mode = mode;
    root.style.colorScheme = mode;
    // The browser chrome (address bar, PWA title bar) takes the page colour.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', getComputedStyle(root).getPropertyValue('--crt-bg').trim() || '#070a1c');
    if (headerButton) {
      const next = nextAppearance(appearance, query ? query.matches : true);
      const svg = headerButton.querySelector('svg');
      if (svg) svg.innerHTML = ICONS[appearance];
      const label = `Appearance: ${LABELS[appearance]}. Switch to ${LABELS[next].toLowerCase()}`;
      headerButton.setAttribute('aria-label', label);
      headerButton.dataset.tip = label;
    }
    if (optionsButton) optionsButton.textContent = `APPEARANCE: ${LABELS[appearance].toUpperCase()}`;
    if (changed) window.dispatchEvent(new CustomEvent('c64-appearance', { detail: { mode } }));
  };

  const set = (next) => { appearance = parseAppearance(next); store(appearance); apply(); };
  const cycle = () => set(nextAppearance(appearance, query ? query.matches : true));
  headerButton?.addEventListener('click', cycle);
  optionsButton?.addEventListener('click', cycle);
  // Follow the OS while on 'system'; an explicit choice ignores it.
  // The OS setting also decides the button's order, so its label updates either way.
  query?.addEventListener?.('change', () => apply());
  // Another tab changed the setting.
  window.addEventListener('storage', (e) => { if (e.key === APPEARANCE_KEY) { appearance = readStored(); apply(); } });
  // A new theme: the mode may be pinned now, and the colours have changed even
  // where the mode has not, so everything painted from script redraws.
  window.addEventListener('c64-theme', () => apply(true));

  apply();
  return () => appearance;
}
