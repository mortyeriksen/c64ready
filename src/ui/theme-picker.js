// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { createDialog, el, button } from '../assembly64/dom.js';
import { themeModeSet, CLASSIC_LOOK } from './themes.js';

export const THEME_PICKER_SEEN = 'c64emu.themePickerShown';
const MOTIFS = {
  classic: '<path d="M75 31H49L32 48v33l17 17h26V82H56l-7-7V54l7-7h19z" fill="currentColor" stroke="none"/><path d="M83 47h19v14H83m0 7h19v14H83"/>',
  geos: '<rect x="23" y="26" width="82" height="76" rx="4"/><path d="M23 43h82M32 35h2m6 0h2m6 0h2M35 56h24v32H35zM70 56h23M70 67h23M70 78h16"/>',
  breadbin: '<rect x="15" y="41" width="98" height="55" rx="13"/><path d="M26 52h65M26 63h76M26 74h76M40 85h48M36 52v22m13-22v22m13-22v22m13-22v22m13-22v22M96 48h7"/>',
  phosphor: '<rect x="21" y="25" width="86" height="70" rx="12"/><path d="M39 48l12 10-12 10m20 0h24M49 104h30m-15-9v9"/><path d="M31 38h66m-66 43h66" opacity=".25"/>',
  outrun: '<circle cx="64" cy="47" r="25" fill="currentColor" stroke="none" opacity=".8"/><path d="M25 42h78m-81 9h84m-78 9h72" stroke="var(--tile-bg)" stroke-width="4"/><path d="M9 108l43-38h24l43 38M64 76v9m0 8v13M32 86h64M19 98h90"/>',
  commando: '<path d="M64 19l36 14v33c0 22-36 42-36 42S28 88 28 66V33z"/><path d="M64 37l6 13 15 2-11 10 3 15-13-7-13 7 3-15-11-10 15-2z" fill="currentColor" stroke="none"/><path d="M44 87l20 11 20-11"/>',
  artdeco: '<path d="M64 109L14 59l12-15 13-9 12-5h26l12 5 13 9 12 15zM64 109V25M64 109L39 35m25 74L26 44m38 65l25-74m-25 74l38-65M33 78h62M23 65h82"/><path d="M56 20l8-9 8 9"/>',
  lookout: '<path d="M89 19a19 19 0 1 0 17 28 18 18 0 0 1-17-28z" fill="currentColor" stroke="none"/><path d="M11 88l31-39 27 31 14-17 34 30M11 101q13-9 26 0t26 0 26 0 26 0M26 28h6m-3-3v6m27 1h6m-3-3v6"/>',
};
const TAGLINES = { classic: 'VIC blue', geos: 'Desktop geometry', breadbin: 'Warm keys', phosphor: 'Terminal glow', outrun: 'Chase the sunset', commando: 'Ready for action', artdeco: 'Gilt & geometry', lookout: 'After the last light' };

export function createThemePicker(themes) {
  let dialog = null;
  let shownThisSession = false;
  return {
    get isOpen() { return !!dialog; },
    hasBeenShown() { if (shownThisSession) return true; try { return localStorage.getItem(THEME_PICKER_SEEN) === '1'; } catch { return false; } },
    open({ onClose = () => {}, remember = true } = {}) {
      if (dialog) return;
      let selected = themes.current().id;
      dialog = createDialog('Choose your look', () => {
        dialog = null;
        shownThisSession = true;
        if (remember) try { localStorage.setItem(THEME_PICKER_SEEN, '1'); } catch { /* session only */ }
        onClose();
      });
      dialog.card.classList.add('theme-picker');
      const intro = el('p', 'Pick a theme. You can change it in Options.', { class: 'theme-picker-intro' });
      const grid = el('div', null, { class: 'theme-picker-grid', role: 'radiogroup', 'aria-label': 'Colour theme', 'data-roving-list': '' });
      const entries = themes.themes();
      const classic = { modes: themes.classic(), look: CLASSIC_LOOK };
      // The terminal theme leads the gallery, with Classic alongside it.
      const first = entries.findIndex(t => t.id === 'phosphor');
      if (first > 0) entries.unshift(entries.splice(first, 1)[0]);
      const cards = [];
      function choose(id) {
        selected = id;
        for (const card of cards) {
          const checked = card.dataset.theme === id;
          card.setAttribute('aria-checked', String(checked));
          card.tabIndex = checked ? 0 : -1;
        }
      }
      for (const entry of entries) {
        const mode = !entry.theme || entry.theme.modes[document.documentElement.dataset.mode] ? document.documentElement.dataset.mode : entry.theme.modes.dark ? 'dark' : 'light';
        const preview = entry.theme ? { ...entry.theme, modes: { [mode]: { ...classic.modes[mode], ...entry.theme.modes[mode] } } } : classic;
        const set = themeModeSet(preview, mode);
        const card = el('button', null, { type: 'button', class: 'theme-tile', role: 'radio', 'data-theme': entry.id, 'aria-label': entry.name });
        card.style.setProperty('--tile-bg', set['panel-bg'] || '#161622');
        card.style.setProperty('--tile-ink', set.text || '#ffffff');
        card.style.setProperty('--tile-accent', set.accent || set.text || '#ffffff');
        card.style.setProperty('--pattern-ink', set['pattern-ink'] || 'rgba(128,128,128,.07)');
        card.style.setProperty('--tile-pattern', set['page-pattern'] || 'none');
        card.style.setProperty('--tile-pattern-size', set['page-pattern-size'] || 'auto');
        const art = el('span', null, { class: 'theme-tile-art', 'aria-hidden': 'true' });
        art.innerHTML = `<svg viewBox="0 0 128 128" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${MOTIFS[entry.id] || '<path d="M64 18l45 46-45 46-45-46zM43 64h42m-21-21v42"/>'}</svg>`;
        card.append(art, el('span', entry.name, { class: 'theme-tile-name' }), el('span', TAGLINES[entry.id] || 'Your own colours', { class: 'theme-tile-caption' }), el('span', '✓', { class: 'theme-tile-check', 'aria-hidden': 'true' }));
        card.addEventListener('click', () => choose(entry.id));
        cards.push(card); grid.append(card);
      }
      grid.addEventListener('keydown', event => {
        if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        if (event.altKey || event.metaKey || event.ctrlKey) return;
        const at = cards.indexOf(document.activeElement);
        if (at < 0) return;
        event.preventDefault(); event.stopPropagation();
        const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
        const step = { ArrowRight: 1, ArrowLeft: -1, ArrowUp: -columns, ArrowDown: columns }[event.key];
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? cards.length - 1 : (at + step + cards.length) % cards.length;
        choose(cards[next].dataset.theme); cards[next].focus();
      });
      choose(selected);
      const actions = el('div', null, { class: 'theme-picker-actions' });
      actions.append(button('KEEP CURRENT', () => dialog.close()), button('APPLY THEME', () => { themes.select(selected); dialog.close(); }, { class: 'btn btn-primary', 'data-theme-use': '' }));
      dialog.body.append(intro, grid, actions);
      cards.find(card => card.dataset.theme === selected)?.focus();
    },
  };
}
