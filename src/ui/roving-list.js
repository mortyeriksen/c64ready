// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/ui/roving-list.js — a list of rows as one Tab stop, the ARIA toolbar /
// grid way: Tab lands on the control last used in the list (at first the first
// one), the arrow keys move inside it and Tab leaves it.
//
//   ↑ / ↓       the same control in the row above or below (or its last one)
//   ← / →       the previous or next control in the row
//   Home / End  the first control of the first or last row
//
// A row's controls can include a role="button" element that is not a real
// button (a drive directory row, a Library file's name). Enter or Space on one
// clicks it, as the browser does for a real button.
//
// The rows are re-rendered freely (search results, the hidden-panel picker):
// a MutationObserver keeps exactly one control in the Tab order.

export const ROVING_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

// Whether a key is a roving list's to handle: a dialog that keeps every key to
// itself (capture phase) lets these through to the list.
export function rovingListKey(e) {
  if (!e.target?.closest?.('[data-roving-list]')) return false;
  if (ROVING_KEYS.has(e.key)) return true;
  return (e.key === 'Enter' || e.key === ' ') && e.target.getAttribute('role') === 'button' && e.target.localName !== 'button';
}
const CONTROL = 'button, a[href], [tabindex]';   // disabled and hidden ones are filtered out below

export function rovingList(container, rowSelector) {
  let active = null;
  const controlsIn = (row) => [...(row.matches(CONTROL) ? [row] : []), ...row.querySelectorAll(CONTROL)]
    .filter((c) => !c.disabled && !c.hidden && c.getClientRects?.().length !== 0);
  const rows = () => [...container.querySelectorAll(rowSelector)].map(controlsIn).filter((r) => r.length);
  const sync = () => {
    const all = rows().flat();
    if (!all.includes(active)) active = all[0] ?? null;
    for (const c of all) c.setAttribute('tabindex', c === active ? '0' : '-1');
  };
  const go = (c) => { if (!c) return; active = c; sync(); c.focus(); };

  container.setAttribute('data-roving-list', '');
  container.addEventListener('focusin', (e) => {
    if (rows().flat().includes(e.target)) { active = e.target; sync(); }
  });
  container.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.getAttribute?.('role') === 'button' && e.target.localName !== 'button') {
      if (e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      e.target.click();
      return;
    }
    if (!ROVING_KEYS.has(e.key) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const grid = rows();
    const r = grid.findIndex((row) => row.includes(e.target));
    if (r < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const c = grid[r].indexOf(e.target);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const row = grid[r + (e.key === 'ArrowDown' ? 1 : -1)];
      if (row) go(row[Math.min(c, row.length - 1)]);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      go(grid[r][c + (e.key === 'ArrowRight' ? 1 : -1)]);
    } else {
      go((e.key === 'Home' ? grid[0] : grid.at(-1))[0]);
    }
  });
  new MutationObserver(sync).observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden'] });
  sync();
  return { sync };
}
