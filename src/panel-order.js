// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/panel-order.js — user-arrangeable side-panel cards.
//
// Every `.panel-card` in the side panel carries a `data-panel` key and gets a
// grip handle injected in front of its header. Dragging a handle moves the card
// within its column or across to the other one, and either column may be
// emptied completely; the resulting layout is mirrored to localStorage so it
// survives reloads. The handle is a focusable button, so the same arranging
// works from the keyboard.
//
// The two columns are real containers (`.panel-col`), not a CSS multi-column
// flow. A flow decides the split for itself and cannot be emptied or steered,
// which is precisely what the user is given control of here. They are the same
// two columns whether they sit beside the picture or below it on a phone. Where
// there is only room for one, the containers go `display: contents` and the
// cards melt into a single stack — column membership is untouched, so widening
// the window brings the arrangement straight back.
//
// The order-independent parts (resolve, compare) are pure functions over key
// arrays, unit-tested in test/panel-order-spec-test.js with no DOM.

import { pushEscapeLayer, popEscapeLayer } from './escape-stack.js';

export const PANEL_ORDER_KEY = 'c64emu.panelOrder';
export const PANEL_HIDDEN_KEY = 'c64emu.panelHidden';

// Movement below this many pixels is a click, not a drag — so tapping a handle
// never leaves the card mid-flight.
const DRAG_THRESHOLD_PX = 4;

// ── Pure layout logic ───────────────────────────────────────────────────────
//
// A layout is one array of key arrays, one per column: [[...col0], [...col1]].

// Storage may hold anything a previous version (or a hand-edit) left behind.
// Returns null for everything that is not an array of arrays of strings;
// callers then fall back to the authored default.
export function parseSavedLayout(raw) {
  if (typeof raw !== 'string') return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  if (!parsed.every(col => Array.isArray(col) && col.every(k => typeof k === 'string'))) return null;
  return parsed;
}

// The hidden set, from storage. Same tolerance as parseSavedLayout: anything
// that isn't an array of strings is treated as nothing hidden. A key naming a
// card that no longer exists is harmless — it is intersected with the real ones
// at startup, so a panel that comes back in a later release comes back visible.
export function parseHiddenKeys(raw) {
  if (typeof raw !== 'string') return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(parsed) || !parsed.every(k => typeof k === 'string')) return null;
  return parsed;
}

// Reconcile a saved layout against the cards that actually exist. The saved
// layout is the authority on everything it names; the rest is two dull rules:
//
//   - a key naming a card that no longer exists is skipped, and a key repeated
//     within or across columns counts once;
//   - a card the saved layout never heard of — the normal case for every
//     existing user the release after a panel is added — goes to the BOTTOM of
//     the last column still in use, in authored order.
//
// Appending is the safe answer rather than the clever one. Threading a newcomer
// back to the column and index it was authored at reads better on paper, but it
// shuffles the user's own cards to make room, and it drops a card they have
// never seen into a column they deliberately emptied — resurrecting that column
// on its own, which reads as a fault. The bottom of a column already in use is
// predictable, needs no special case, and is one drag away from anywhere else.
export function resolveLayout(defaultLayout, savedLayout) {
  const known = new Set(defaultLayout.flat());
  const out = defaultLayout.map(() => []);
  const seen = new Set();

  if (Array.isArray(savedLayout)) {
    for (let c = 0; c < out.length; c++) {
      for (const key of savedLayout[c] ?? []) {
        if (!known.has(key) || seen.has(key)) continue;
        seen.add(key);
        out[c].push(key);
      }
    }
  }

  // Nothing usable saved at all — the authored layout is the answer, columns and
  // all. Without this every card would count as new and pile into one column.
  if (!out.some(col => col.length > 0)) return defaultLayout.map(col => [...col]);

  // Everything the saved layout did not name goes to the bottom of the last
  // column still in use, in authored order.
  let last = 0;
  for (let c = 0; c < out.length; c++) if (out[c].length > 0) last = c;
  for (const key of defaultLayout.flat()) {
    if (seen.has(key)) continue;
    seen.add(key);
    out[last].push(key);
  }
  return out;
}

export function isDefaultLayout(defaultLayout, layout) {
  return JSON.stringify(defaultLayout) === JSON.stringify(layout);
}

// ── DOM wiring ──────────────────────────────────────────────────────────────

const GRIP_SVG =
  '<svg viewBox="0 0 10 16" width="10" height="16" fill="currentColor" aria-hidden="true" focusable="false">' +
  '<circle cx="2" cy="3" r="1.35"/><circle cx="8" cy="3" r="1.35"/>' +
  '<circle cx="2" cy="8" r="1.35"/><circle cx="8" cy="8" r="1.35"/>' +
  '<circle cx="2" cy="13" r="1.35"/><circle cx="8" cy="13" r="1.35"/></svg>';

// The Status card's h2 holds the title in a span followed by the fps/ms/MB
// badge, so its textContent would read "Status– fps · – ms". Every other card
// titles itself with a bare h2. First span if there is one, whole h2 otherwise.
function _cardName(card) {
  const h2 = card.querySelector('h2');
  if (!h2) return card.getAttribute('data-panel') || 'panel';
  return (h2.querySelector('span')?.textContent || h2.textContent || '').trim();
}

export function initPanelOrder() {
  const panel = document.querySelector('.side-panel');
  const cols = [...(panel?.querySelectorAll(':scope > .panel-cols > .panel-col') ?? [])];
  if (!panel || cols.length < 2) return;

  const cardsIn = col => [...col.querySelectorAll(':scope > .panel-card[data-panel]')];
  const keysIn = col => cardsIn(col).map(c => c.getAttribute('data-panel'));
  // A hidden card keeps its place in the layout — it is only not drawn — so the
  // saved order still knows where to put it back. Everything that measures or
  // counts boxes has to skip it, since it has none.
  const shownIn = col => cardsIn(col).filter(c => !c.classList.contains('is-panel-hidden'));

  const defaultLayout = cols.map(keysIn);
  const byKey = new Map(cols.flatMap(cardsIn).map(c => [c.getAttribute('data-panel'), c]));
  if (byKey.size < 2) return;

  let layout = defaultLayout;

  // Lives on <body>, not in the panel, where it cannot perturb the columns.
  const live = document.createElement('div');
  live.className = 'panel-order-live';
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('role', 'status');
  document.body.appendChild(live);

  // Drop-to-hide target: a square that only exists while a card is in flight.
  // Body-level and pointer-events:none — the drag owns the pointer capture, so
  // this is hit-tested by hand rather than by the browser. It sits BELOW the
  // ghost so the card being dropped stays the thing you are looking at.
  const hideTarget = document.createElement('div');
  hideTarget.className = 'panel-hide-target';
  hideTarget.setAttribute('aria-hidden', 'true');
  hideTarget.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" aria-hidden="true">' +
    '<path d="M3 3l18 18M10.6 5.1A9.6 9.6 0 0 1 12 5c5 0 9 4.5 9 7a11 11 0 0 1-2.4 3.6' +
    'M6.2 6.7A11.6 11.6 0 0 0 3 12c0 2.5 4 7 9 7a9.7 9.7 0 0 0 4.2-1"/>' +
    '<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg><span>Hide</span>';
  document.body.appendChild(hideTarget);

  // Bring-back affordance: a + in the same corner, shown only while something is
  // hidden. Without it a hidden card would be reachable only through Options,
  // which is a long way to go for something you dropped by accident.
  const restoreBtn = document.createElement('button');
  restoreBtn.type = 'button';
  restoreBtn.className = 'panel-restore-btn';
  restoreBtn.title = 'Show a hidden panel';
  restoreBtn.setAttribute('aria-label', 'Show a hidden panel');
  restoreBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  document.body.appendChild(restoreBtn);

  const restoreDialog = document.createElement('div');
  restoreDialog.className = 'modal-backdrop panel-restore-modal';
  restoreDialog.hidden = true;
  restoreDialog.innerHTML =
    '<div class="modal-card panel-restore-card" role="dialog" aria-modal="true" ' +
    'aria-labelledby="panel-restore-title">' +
    '<div class="panel-card-header"><h2 id="panel-restore-title">Show hidden panels</h2>' +
    '<button class="expand-btn" data-close aria-label="Close">✕</button></div>' +
    '<p class="panel-restore-hint">Choose one to put it back at the bottom of its column.</p>' +
    '<div class="panel-restore-list"></div></div>';
  document.body.appendChild(restoreDialog);
  const restoreList = restoreDialog.querySelector('.panel-restore-list');

  const restoreIsOpen = () => !restoreDialog.hidden;
  const closeRestore = () => {
    restoreDialog.hidden = true;
    popEscapeLayer(restoreLayer);
    if (hidden.size) restoreBtn.focus();
  };
  const restoreLayer = { close: closeRestore, isOpen: restoreIsOpen };

  // A restored card goes to the BOTTOM of the column it belongs to — the same
  // rule a brand-new panel follows, and the one place the eye can find it.
  const unhide = (key) => {
    const card = byKey.get(key);
    if (!card) return;
    hidden.delete(key);
    const col = card.closest('.panel-col') ?? cols[0];
    col.appendChild(card);
    applyHidden();
    syncFromDom();
    save();
    saveHidden();
    syncRestoreUi();
    live.textContent = `${_cardName(card)} shown again`;
  };

  const fillRestoreList = () => {
    restoreList.innerHTML = '';
    // Alphabetical, not hide-order: the list is something to look a name up in,
    // and the order things were hidden in is not something anyone remembers.
    const listed = [...hidden]
      .map(key => [key, byKey.get(key)])
      .filter(([, card]) => card)
      .sort((a, b) => _cardName(a[1]).localeCompare(_cardName(b[1])));
    for (const [key, card] of listed) {
      // .lib-row is the Library / Save-States row: same box, padding and hover,
      // so a hidden panel picks up the size of a saved state in that dialog.
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lib-row panel-restore-item';
      const name = document.createElement('span');
      name.className = 'lib-name';
      name.textContent = _cardName(card);
      b.appendChild(name);
      b.addEventListener('click', () => {
        unhide(key);
        if (hidden.size) fillRestoreList(); else closeRestore();
      });
      restoreList.appendChild(b);
    }
  };

  const openRestore = () => {
    if (!hidden.size) return;
    fillRestoreList();
    restoreDialog.hidden = false;
    pushEscapeLayer(restoreLayer);
    restoreList.querySelector('button')?.focus();
  };

  restoreBtn.addEventListener('click', openRestore);
  restoreDialog.addEventListener('click', (e) => {
    if (e.target === restoreDialog || e.target.hasAttribute('data-close')) closeRestore();
  });

  // The + and the hide oval share the corner, so the + stands down mid-drag.
  const syncRestoreUi = () => {
    restoreBtn.classList.toggle('is-shown', hidden.size > 0 && !drag?.active);
    if (!hidden.size && restoreIsOpen()) closeRestore();
  };

  const overHideTarget = (e) => {
    const r = hideTarget.getBoundingClientRect();
    if (!r.width) return false;
    return e.clientX >= r.left && e.clientX <= r.right &&
           e.clientY >= r.top && e.clientY <= r.bottom;
  };

  const save = () => {
    try {
      if (isDefaultLayout(defaultLayout, layout)) localStorage.removeItem(PANEL_ORDER_KEY);
      else localStorage.setItem(PANEL_ORDER_KEY, JSON.stringify(layout));
    } catch {}
  };

  // Marks a column with no cards left in it, so it can show itself as a drop
  // target mid-drag. The CSS `:empty` cannot do this job — the whitespace in the
  // markup counts as a child.
  const syncEmpty = () => {
    for (const col of cols) col.classList.toggle('is-empty', shownIn(col).length === 0);
  };

  const syncFromDom = () => {
    layout = cols.map(keysIn);
    syncEmpty();
  };

  const applyLayout = (next) => {
    next.forEach((keys, c) => {
      for (const key of keys) {
        const card = byKey.get(key);
        if (card) cols[c].appendChild(card);
      }
    });
    syncFromDom();
  };

  const hidden = new Set();
  const saveHidden = () => {
    try {
      if (hidden.size === 0) localStorage.removeItem(PANEL_HIDDEN_KEY);
      else localStorage.setItem(PANEL_HIDDEN_KEY, JSON.stringify([...hidden]));
    } catch {}
  };
  const applyHidden = () => {
    for (const [key, card] of byKey) card.classList.toggle('is-panel-hidden', hidden.has(key));
    syncEmpty();
  };

  let saved = null;
  try { saved = parseSavedLayout(localStorage.getItem(PANEL_ORDER_KEY)); } catch {}
  applyLayout(resolveLayout(defaultLayout, saved));
  let savedHidden = null;
  try { savedHidden = parseHiddenKeys(localStorage.getItem(PANEL_HIDDEN_KEY)); } catch {}
  for (const key of savedHidden ?? []) if (byKey.has(key)) hidden.add(key);
  applyHidden();

  // ── Handles ───────────────────────────────────────────────────────────────
  const handles = new Map();
  for (const [key, card] of byKey) {
    const header = card.querySelector(':scope > .panel-card-header');
    if (!header) continue;
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'panel-drag-handle';
    handle.innerHTML = GRIP_SVG;
    handle.setAttribute('aria-label', `Reorder ${_cardName(card)}`);
    handle.title = 'Drag to reorder — or use the arrow keys';
    // The header itself toggles expand (main.js) or drive-9 power (media.js);
    // the handle lives inside it, so it has to swallow its own events.
    handle.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); });
    header.insertBefore(handle, header.firstChild);
    handles.set(key, handle);
  }

  const announce = (card) => {
    const col = card.closest('.panel-col');
    // What a person counts is what they can see; a hidden card is not a position.
    const siblings = shownIn(col);
    const at = siblings.indexOf(card);
    const where = cols.length > 1 ? ` in column ${cols.indexOf(col) + 1}` : '';
    live.textContent = `${_cardName(card)} moved to position ${at + 1} of ${siblings.length}${where}`;
  };

  // Puts `card` at slot `idx` of column `c`. Every move, dragged or typed, goes
  // through here.
  //
  // `idx` counts the cards that are *shown*, because that is what the slots were
  // measured from and what the pointer aimed at. A hidden card keeps its place in
  // the layout but owns no box, so it must not consume a slot here either.
  // Counting the full list instead put every drop one place too high per hidden
  // card above it, and made the bottom of such a column unreachable: an index
  // past the last visible card still found a card in the full list and landed
  // above it.
  const place = (card, c, idx) => {
    const shown = shownIn(cols[c]).filter(x => x !== card);
    cols[c].insertBefore(card, idx < shown.length ? shown[idx] : null);
    syncEmpty();
  };

  // ── Keyboard arranging ────────────────────────────────────────────────────
  // Up/Down walk the column; Left/Right hand the card to the other column, so
  // everything the pointer can do is reachable without one.
  for (const [key, handle] of handles) {
    handle.addEventListener('keydown', e => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const card = byKey.get(key);
      const col = card.closest('.panel-col');
      const c = cols.indexOf(col);
      // Shown cards only, to match what place() indexes and what Up/Down look
      // like: stepping over a card nobody can see reads as the key doing nothing.
      const siblings = shownIn(col);
      const at = siblings.indexOf(card);
      let toCol = c, to = at;

      if (e.key === 'ArrowUp') to = at - 1;
      else if (e.key === 'ArrowDown') to = at + 1;
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = siblings.length - 1;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        toCol = e.key === 'ArrowLeft' ? c - 1 : c + 1;
        if (toCol < 0 || toCol >= cols.length) return;
        to = Math.min(at, shownIn(cols[toCol]).length);
      } else return;

      e.preventDefault();
      e.stopPropagation();
      if (toCol === c && (to < 0 || to >= siblings.length || to === at)) return;

      place(card, toCol, to);
      syncFromDom();
      save();
      announce(card);
      handle.focus();
    });
  }

  // ── Pointer dragging ──────────────────────────────────────────────────────
  // The dragged card stays in the flow as the placeholder — hollowed out and
  // outlined — and that placeholder is what moves to the target slot, so the
  // opening space is laid out by the browser and comes out right at the end of
  // a column, the end of a row, and in an empty column alike.
  //
  // The drop point is tracked as a (column, index) pair and acted on only when
  // it changes. That normalisation is what keeps this stable: with the pointer
  // resting in the opened slot, "after the card above" and "before the card
  // below" name the same index, so they cancel instead of trading the
  // placeholder back and forth every frame.
  let drag = null;

  // True while the columns are real side-by-side boxes. Outside that breakpoint
  // they are `display: contents` and own no box at all, so the cards are one
  // flow and the column has to be inferred from the card the pointer picks.
  const columnsAreBoxes = () =>
    cols.every(c => getComputedStyle(c).display !== 'contents');

  const measure = () => {
    drag.split = columnsAreBoxes();
    drag.colRects = drag.split ? cols.map(c => c.getBoundingClientRect()) : null;
    drag.slots = cols.map(col =>
      shownIn(col).filter(c => c !== drag.card)
        .map(card => ({ card, rect: card.getBoundingClientRect() })));
  };

  const setDropAt = (c, idx) => {
    if (drag.dropCol === c && drag.dropIdx === idx) return;
    drag.dropCol = c;
    drag.dropIdx = idx;
    place(drag.card, c, idx);
    // Placing it moved everything after it — and may have opened or collapsed a
    // column — so the slots are stale. One measurement pass, and only because
    // the drop point actually changed.
    measure();
  };

  // Index within a column's slots, from which side of each card the pointer is.
  const indexIn = (slots, e) => {
    if (!slots.length) return 0;
    let hit = -1, best = Infinity;
    for (let i = 0; i < slots.length; i++) {
      const r = slots[i].rect;
      if (e.clientX >= r.left && e.clientX <= r.right &&
          e.clientY >= r.top && e.clientY <= r.bottom) { hit = i; break; }
      const ox = e.clientX - (r.left + r.width / 2);
      const oy = e.clientY - (r.top + r.height / 2);
      const d = ox * ox + oy * oy;
      if (d < best) { best = d; hit = i; }
    }
    // Cards always stack vertically — in a column, or in the single flow — so
    // the vertical midpoint is the whole test.
    const r = slots[hit].rect;
    return e.clientY < r.top + r.height / 2 ? hit : hit + 1;
  };

  const endDrag = (commit) => {
    if (!drag) return;
    const { handle, ghost, card, startCol, startNext, startLayout, hadFocus, overHide } = drag;
    ghost?.remove();
    card.classList.remove('panel-drag-source');
    document.body.classList.remove('panels-reordering');
    document.body.classList.remove('panels-hide-armed');
    hideTarget.classList.remove('is-over');
    try { panel.releasePointerCapture(drag.pointerId); } catch {}
    drag = null;
    if (commit && overHide) {
      // Put it back where it was picked up first: hiding a card should not also
      // move it, so unhiding later finds it where the user left it.
      startCol.insertBefore(card, startNext);
      hidden.add(card.getAttribute('data-panel'));
      applyHidden();
      syncFromDom();
      save();
      saveHidden();
      syncRestoreUi();
      live.textContent = `${_cardName(card)} hidden — Options ▸ Display ▸ RESET PANELS brings it back`;
      if (hadFocus) handle.focus();
      return;
    }
    syncRestoreUi();
    if (!commit) {
      startCol.insertBefore(card, startNext);   // a cancelled drag puts it back
      syncFromDom();
    } else {
      syncFromDom();
      if (JSON.stringify(layout) !== startLayout) {
        save();
        announce(card);
      }
    }
    // Only give the handle its focus back if it had it before the drag. A
    // pointer drag never focuses it (pointerdown preventDefaults), so focusing
    // it here would leave the grip lit up with :focus-visible long after the
    // drop — the highlight would sit there until something else was clicked.
    if (hadFocus) handle.focus();
  };

  for (const [key, handle] of handles) {
    handle.addEventListener('pointerdown', e => {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const card = byKey.get(key);
      // Capture on the panel, never on the handle: the handle rides inside the
      // card, and moving the card to its next slot takes the handle out of the
      // document for an instant, which drops the capture and kills the drag at
      // its first move. The panel itself never moves.
      try { panel.setPointerCapture(e.pointerId); } catch {}
      drag = {
        pointerId: e.pointerId, handle, card, ghost: null, active: false,
        startX: e.clientX, startY: e.clientY, offX: 0, offY: 0,
        slots: null, colRects: null, split: false,
        dropCol: null, dropIdx: null, overHide: false,
        startCol: card.closest('.panel-col'), startNext: card.nextElementSibling,
        startLayout: JSON.stringify(layout),
        hadFocus: document.activeElement === handle,
      };
    });
  }

  // Move / release listeners live on the panel, which owns the capture, so one
  // set covers every handle and none of them can be moved out from under a drag.
  {
    panel.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;

      if (!drag.active) {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        drag.active = true;

        // Measure the card before hollowing it out — the ghost inherits its size.
        const rect = drag.card.getBoundingClientRect();
        // A body-level fixed clone follows the pointer. Lifting the card itself
        // would be clipped by its column box.
        const ghost = drag.card.cloneNode(true);
        ghost.removeAttribute('id');
        for (const el of ghost.querySelectorAll('[id]')) el.removeAttribute('id');
        ghost.classList.add('panel-drag-ghost');
        ghost.style.width = `${rect.width}px`;
        ghost.style.height = `${rect.height}px`;
        ghost.setAttribute('aria-hidden', 'true');
        document.body.appendChild(ghost);
        drag.ghost = ghost;
        drag.offX = rect.left;
        drag.offY = rect.top;
        // Children go `visibility: hidden` rather than away, so the emptied box
        // keeps the card's own height.
        drag.card.classList.add('panel-drag-source');
        document.body.classList.add('panels-reordering');
        syncRestoreUi();          // the + stands down; the oval has the corner
        measure();
      }

      // Transform only — a composited write with no layout read after it.
      drag.ghost.style.transform =
        `translate3d(${drag.offX + dx}px, ${drag.offY + dy}px, 0)`;

      // Over the hide circle the placeholder stops following: the question has
      // changed from "where does this go" to "does this go away at all".
      const overHide = overHideTarget(e);
      if (overHide !== drag.overHide) {
        drag.overHide = overHide;
        hideTarget.classList.toggle('is-over', overHide);
        drag.ghost.classList.toggle('is-over-hide', overHide);
        // Nothing in the columns is a drop point while the answer is "gone", so
        // the opened slot and any empty-column target stop advertising
        // themselves. The space stays, so letting go over neither one puts the
        // card back without the layout having moved underneath.
        document.body.classList.toggle('panels-hide-armed', overHide);
      }
      if (overHide) return;

      if (drag.split) {
        // Side-by-side columns: the pointer's x picks the column outright, so an
        // empty one is as reachable as a full one.
        let c = 0, best = Infinity;
        for (let i = 0; i < drag.colRects.length; i++) {
          const r = drag.colRects[i];
          if (e.clientX >= r.left && e.clientX <= r.right) { c = i; break; }
          const d = Math.abs(e.clientX - (r.left + r.width / 2));
          if (d < best) { best = d; c = i; }
        }
        setDropAt(c, indexIn(drag.slots[c], e));
      } else {
        // Melted into one flow: pick a slot across the whole run, then work out
        // which column that lands in, so the split survives the narrow layout.
        const flat = drag.slots.flat();
        const i = indexIn(flat, e);
        const firstLen = drag.slots[0].length;
        if (i <= firstLen) setDropAt(0, i);
        else setDropAt(1, i - firstLen);
      }
    });

    panel.addEventListener('pointerup', e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      endDrag(drag.active);
    });
    panel.addEventListener('pointercancel', e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      endDrag(false);
    });
    // Belt and braces: if the capture is ever lost mid-drag, settle where the
    // card stands rather than leaving a ghost stranded and the panel frozen.
    panel.addEventListener('lostpointercapture', e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      endDrag(drag.active);
    });
  }

  // ── Reset ─────────────────────────────────────────────────────────────────
  const resetBtn = document.getElementById('btn-panel-order-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      try { localStorage.removeItem(PANEL_ORDER_KEY); } catch {}
      hidden.clear();
      saveHidden();
      applyHidden();
      applyLayout(defaultLayout);
      syncRestoreUi();
      live.textContent = 'Panel layout reset — hidden cards are back';
    });
  }

  // Last, not with the other init: syncRestoreUi reads `drag`, which is declared
  // further down, so calling it any earlier would hit the temporal dead zone.
  syncRestoreUi();
}
