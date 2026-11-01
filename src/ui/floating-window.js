// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/ui/floating-window.js — a window that floats over the app on a desktop,
// dragged by its title bar and resized from its edges, and remembers where it
// was. On a phone (or a short landscape screen with touch) it fills the screen,
// follows the on-screen keyboard and closes with the Back button. A dockable
// window can also sit docked on the right on a desktop, full height, with the
// page narrowed beside it (body.has-docked-window), resized from its left edge.
// `dockWhen` docks it whatever was chosen, while it holds (a fullscreen picture
// shares the screen with it rather than being covered).
// The window's element carries `.float-window`, its handles `.float-resize`
// (styles-float-window.css).

const FULL_QUERY = '(max-width: 680px), (pointer: coarse) and (max-height: 520px)';

/** True where a floating window fills the screen (a phone, or a short screen with touch). */
export const fillsScreen = () => !!globalThis.matchMedia?.(FULL_QUERY).matches;

const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* blocked */ } },
};

/** The edge handles to append to a floating window. */
export function resizeHandles() {
  return ['e', 's', 'w', 'se', 'sw'].map((d) => {
    const el = document.createElement('div');
    el.className = `float-resize float-resize-${d}`;
    el.dataset.dir = d;
    el.setAttribute('aria-hidden', 'true');
    return el;
  });
}

/**
 * @param {object} o
 * @param {HTMLElement} o.win        the window
 * @param {HTMLElement} o.head       its title bar, the drag handle
 * @param {HTMLElement[]} o.handles  from resizeHandles(), already in the window
 * @param {string} o.rectKey         where the desktop rect is remembered
 * @param {() => {x,y,w,h}} o.initial  the first rect, before one is remembered
 * @param {() => void} o.onBack      the Back button closed the full-screen window
 * @param {string} [o.dockKey]      makes it dockable: where docked-or-not and the docked width are remembered
 * @param {() => boolean} [o.dockWhen]  docks it while true, whatever was chosen
 * @param {boolean} [o.dockedFirst]       docked until a choice is remembered
 */
export function floatingWindow({ win, head, handles, rectKey, minW = 300, minH = 340, initial, onBack, dockKey = null, dockWhen = () => false, dockedFirst = false }) {
  const full = window.matchMedia?.(FULL_QUERY);
  let rect = (() => {
    try { const r = JSON.parse(storage.get(rectKey) || 'null'); return r && [r.x, r.y, r.w, r.h].every(Number.isFinite) ? r : null; } catch { return null; }
  })();
  let pushedHistory = false;
  const isFull = () => win.classList.contains('is-full');
  // dock = { on, w }: docked by choice or not, and the docked width, kept for
  // the next time it docks. A phone's full-screen window never docks.
  let dock = (() => {
    const first = { on: !!dockKey && dockedFirst, w: null };
    if (!dockKey) return first;
    try { const d = JSON.parse(storage.get(dockKey) || 'null'); return d && Number.isFinite(d.w) ? { on: d.on !== false, w: d.w } : first; } catch { return first; }
  })();
  const isDocked = () => !!dockKey && !isFull() && (dock.on || dockWhen());
  const dockWidth = (w) => Math.round(Math.min(Math.max(minW, w ?? rect?.w ?? 400), window.innerWidth * 0.6));
  const saveDock = () => storage.set(dockKey, JSON.stringify(dock));

  const clampRect = (r) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(Math.max(minW, r.w), vw - 16);
    const hgt = Math.min(Math.max(minH, r.h), vh - 16);
    return { w, h: hgt, x: Math.min(Math.max(8, r.x), vw - w - 8), y: Math.min(Math.max(8, r.y), vh - hgt - 8) };
  };
  function place(r) {
    rect = r;
    win.style.left = `${r.x}px`;
    win.style.top = `${r.y}px`;
    win.style.width = `${r.w}px`;
    win.style.height = `${r.h}px`;
  }
  function applyMode() {
    win.classList.toggle('is-full', !!full?.matches);
    win.classList.toggle('is-docked', isDocked());
    if (isFull() || isDocked()) win.style.left = win.style.top = win.style.width = win.style.height = '';
    if (isFull()) syncViewport();
    else if (isDocked()) { dock.w = dockWidth(dock.w); win.style.width = `${dock.w}px`; }
    else place(clampRect(rect || initial()));
    applyDock();
  }
  // The page makes room for a docked window that shows, and takes it back otherwise.
  function applyDock() {
    const on = !win.hidden && isDocked();
    document.body.classList.toggle('has-docked-window', on);
    if (on) document.documentElement.style.setProperty('--float-dock-w', `${dock.w}px`);
    else document.documentElement.style.removeProperty('--float-dock-w');
  }
  // A phone's keyboard shrinks the visual viewport, not the layout one: the window follows it.
  function syncViewport() {
    const vv = window.visualViewport;
    if (!vv || !isFull()) return;
    win.style.setProperty('--float-vh', `${vv.height}px`);
    win.style.setProperty('--float-top', `${vv.offsetTop}px`);
  }
  window.visualViewport?.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('scroll', syncViewport);
  full?.addEventListener?.('change', () => { if (!win.hidden) applyMode(); });
  window.addEventListener('resize', () => {
    if (win.hidden || isFull()) return;
    if (isDocked()) applyMode();
    else if (rect) place(clampRect(rect));
  });
  window.addEventListener('popstate', () => { if (pushedHistory) { pushedHistory = false; if (!win.hidden) onBack?.(); } });

  // Drag by the title bar and resize from the edges. The window's rect is read
  // once when a gesture starts, so moving the pointer never forces layout.
  // Docked, only the left edge moves, and it sets the docked width.
  let gesture = null;
  const startGesture = (e, dir) => {
    if (isFull() || e.button > 0) return;
    if (isDocked() && dir !== 'w') return;
    gesture = { dir, x0: e.clientX, y0: e.clientY, r: { ...rect }, dockW: dock.w };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const moveGesture = (e) => {
    if (!gesture) return;
    const dx = e.clientX - gesture.x0, dy = e.clientY - gesture.y0, r = gesture.r, d = gesture.dir;
    if (isDocked()) { dock.w = dockWidth(gesture.dockW - dx); win.style.width = `${dock.w}px`; applyDock(); return; }
    let next;
    if (d === 'move') next = { ...r, x: r.x + dx, y: r.y + dy };
    else {
      next = { ...r };
      if (d.includes('e')) next.w = r.w + dx;
      if (d.includes('s')) next.h = r.h + dy;
      if (d.includes('w')) { const w = Math.max(minW, r.w - dx); next.x = r.x + r.w - w; next.w = w; }
    }
    place(clampRect(next));
  };
  const endGesture = () => {
    if (!gesture) return;
    gesture = null;
    if (isDocked()) saveDock();
    else storage.set(rectKey, JSON.stringify(rect));
  };
  head.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) startGesture(e, 'move'); });
  for (const el of [head, ...handles]) {
    el.addEventListener('pointermove', moveGesture);
    el.addEventListener('pointerup', endGesture);
    el.addEventListener('pointercancel', endGesture);
  }
  for (const hd of handles) hd.addEventListener('pointerdown', (e) => startGesture(e, hd.dataset.dir));
  // Clicks inside stay inside: the app's own click handlers (focus the screen) must not fire.
  win.addEventListener('pointerdown', (e) => e.stopPropagation());

  return {
    /** Shows the window, placed for this screen. */
    show() {
      const wasHidden = win.hidden;
      win.hidden = false;
      applyMode();
      if (wasHidden && isFull()) { history.pushState({ floatWindow: true }, ''); pushedHistory = true; }
    },
    /** Hides it; `fromHistory` when the Back button already went back. */
    hide(fromHistory = false) {
      win.hidden = true;
      applyDock();
      if (pushedHistory && !fromHistory) { pushedHistory = false; history.back(); }
    },
    /** Docks it on the right, or floats it again where it was. */
    setDocked(on) {
      if (!dockKey) return;
      dock = { on: !!on, w: dockWidth(dock.w) };
      saveDock();
      if (!win.hidden) applyMode();
    },
    isDocked,
    /** Places it again, after what `dockWhen` reads has changed. */
    relayout() { if (!win.hidden) applyMode(); },
    /** Docking is a choice on a desktop: not on a phone, nor while `dockWhen` holds. */
    canDock: () => !!dockKey && !isFull() && !dockWhen(),
  };
}
