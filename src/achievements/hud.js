// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/achievements/hud.js — the trophy HUD in the vibes view, for play: a slot
// per achievement of the loaded game, and a chase of the next player up its
// board. The view's HUD button shows and hides it. It drags anywhere, snapping
// to the edges and center lines. Dragged by its corner it reshapes, the toast's
// way: the shape dragged out picks the layout and the font size fits it. An unlock's trophy flies
// from its toast into its slot. Phones and tablets start without it and get
// the bar, the slim column and the pill. Kept in the browser.
//
// A running score can change every frame: it is painted at most once per
// display frame, writes only what changed, and allocates nothing but the
// texts it shows.

import { KIND_ICONS, iconMask, flap, count, sparkle, tremble, burst } from './toast.js';
import { GAME_ICONS } from './game-icons.js';
import { ordinal, ago } from './browse.js';

export const HUD_KEY = 'c64emu.achHud';
export const HUD_LAYOUTS = Object.freeze(['row', 'row2', 'box', 'col2', 'col1', 'pill-row', 'pill-col']);
/** Phones and tablets: the bar, the slim column and the pill. */
export const COMPACT_LAYOUTS = Object.freeze(['row', 'col1', 'pill-row', 'pill-col']);
export const COMPACT_QUERY = '(max-width: 680px), (pointer: coarse)';
/** Below this font size, in CSS pixels, the slots no longer read and the HUD is a pill. */
export const PILL_BELOW = 7.5;
export const FONT_MAX = 24;
/** Margin from the view's edges, as its buttons'; and the room the button column takes on the left. */
const MARGIN = 18, BUTTONS = 74;
const SNAP = 12;

/** A box's layout by its width over its height. */
export function layoutFor(aspect, compact = false) {
  if (compact) return aspect >= 1.5 ? 'row' : 'col1';
  return aspect >= 6 ? 'row' : aspect >= 2.4 ? 'row2' : aspect >= 1 ? 'box' : aspect >= 0.35 ? 'col2' : 'col1';
}
export const pillFor = (aspect) => (aspect >= 1 ? 'pill-row' : 'pill-col');

/** Slots across in a layout for a set of `n`: more rows, or columns, for a big set. */
export function slotColumns(layout, n) {
  if (n <= 0) return 0;
  const big = n > 16;
  if (layout === 'row') return Math.ceil(n / (big ? 2 : 1));
  if (layout === 'row2') return Math.ceil(n / (big ? 3 : 2));
  if (layout === 'box') return Math.min(n, big ? 10 : 7);
  if (layout === 'col2') return Math.min(n, big ? 3 : 2);
  if (layout === 'col1') return Math.min(n, big ? 2 : 1);
  return 0;
}

/** Where it is and how big: x and y from 0 to 1 across the free room, the drawn box in shares of the view's width. */
export const HUD_DEFAULT = Object.freeze({ fx: 0.5, fy: 1, bw: 0.64, bh: 0.05, shown: true, fade: false });
export const HUD_DEFAULT_COMPACT = Object.freeze({ fx: 0.5, fy: 0, bw: 0.5, bh: 0.07, shown: false, fade: false });
/** A stored state, anything missing or out of range taken from the default. */
export function parseHudState(text, compact = false) {
  const base = compact ? HUD_DEFAULT_COMPACT : HUD_DEFAULT;
  let v = null;
  try { v = JSON.parse(text ?? ''); } catch { /* the default */ }
  if (!v || typeof v !== 'object') return { ...base };
  const within = (x, lo, hi) => typeof x === 'number' && x >= lo && x <= hi;
  return {
    fx: within(v.fx, 0, 1) ? v.fx : base.fx,
    fy: within(v.fy, 0, 1) ? v.fy : base.fy,
    bw: within(v.bw, 0.01, 1) ? v.bw : base.bw,
    bh: within(v.bh, 0.01, 3) ? v.bh : base.bh,
    shown: typeof v.shown === 'boolean' ? v.shown : base.shown,
    fade: typeof v.fade === 'boolean' ? v.fade : base.fade,
  };
}

/**
 * Where `value` stands among the other players' entries: its rank, the
 * nearest entry ahead (the one to pass next) and the nearest one behind
 * (the last passed). A tie is not ahead. Written into `out`, so a running
 * score reuses one.
 */
export function chase(others, value, lowerIsBetter = false, out = { rank: 1, next: null, passed: null }) {
  let rank = 1, next = null, passed = null;
  for (let i = 0; i < others.length; i++) {
    const e = others[i];
    if (lowerIsBetter ? e.value < value : e.value > value) {
      rank++;
      if (next === null || (lowerIsBetter ? e.value > next.value : e.value < next.value)) next = e;
    } else if (passed === null || (lowerIsBetter ? e.value < passed.value : e.value > passed.value)) passed = e;
  }
  out.rank = rank;
  out.next = next;
  out.passed = passed;
  return out;
}

/** A board's short name, for a game with several: "Hiscores (The Duel)" is THE DUEL, "Route C" ROUTE C. */
export function boardLabel(title) {
  return (/\(([^)]+)\)\s*$/.exec(title)?.[1] ?? title).toUpperCase();
}

/** The rcheevos formats that are a time. */
export const TIME_FORMATS = new Set(['TIME', 'FRAMES', 'TIMESECS', 'MILLISECS', 'SECS', 'MINUTES', 'SECS_AS_MINS']);
/** The gap to the next player: a time in its board's format, else the points grouped. */
export function gapText(n, board, format) {
  return TIME_FORMATS.has(board.format) ? format(Math.abs(n)) : grouped(n);
}

/** 21130 as "21,130". */
export function grouped(n) {
  let s = String(Math.round(Math.abs(n)));
  for (let i = s.length - 3; i > 0; i -= 3) s = `${s.slice(0, i)},${s.slice(i)}`;
  return s;
}

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// No entries: a plain array, so the chase's loop sees one kind of array. Never written to.
const NONE = [];
// The fill's 501 steps, made once: moving it allocates nothing.
const FILL = Array.from({ length: 501 }, (_, i) => `scaleX(${i / 500})`);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function tool(cls, label, paths) {
  const b = el('button', `ach-hud-tool ${cls}`);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  return b;
}
const replay = (node, cls) => { node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); };
// A text changed in place, in its own text node: inserting a node would have the
// page's body:has() rules restyle the whole page.
const write = (node, text) => { if (node.firstChild) node.firstChild.data = text; else node.textContent = text; };

/**
 * @param {object} o
 * @param {HTMLElement} o.area          the vibes view
 * @param {HTMLButtonElement} o.button  its HUD button
 * @param {() => object|null} o.engine  the achievement engine (engine.js), or null
 * @param {() => object|null} [o.me]    the signed-in user
 * @param {Storage} [o.storage]
 */
export function createTrophyHud({ area, button, engine, me = () => null, storage = globalThis.localStorage }) {
  const mq = globalThis.matchMedia?.(COMPACT_QUERY);
  const compact = () => !!mq?.matches;
  const read = () => { try { return storage?.getItem(HUD_KEY) ?? null; } catch { return null; } };
  const S = parseHudState(read(), compact());
  const save = () => { try { storage?.setItem(HUD_KEY, JSON.stringify(S)); } catch { /* kept for this visit */ } };

  // ── Its parts ─────────────────────────────────────────────────────────
  const hud = el('div', 'ach-hud mode-dark');
  hud.hidden = true;
  hud.dataset.chase = 'off';
  hud.setAttribute('role', 'region');
  hud.setAttribute('aria-label', 'Trophies and rank');
  // The trophy for the slots, the flyers and the tips, all in the view.
  area.style.setProperty('--ach-hud-trophy', iconMask(KIND_ICONS.unlock));
  const inner = el('div', 'ach-hud-in');
  const icon = el('span', 'ach-hud-icon');
  const title = el('b', 'ach-hud-title');
  const pts = el('i', '', '0'), total = el('span');
  const got = el('i', '', '0'), of = el('span');
  const words = el('span', 'ach-hud-words');
  const ptsLine = el('small');
  ptsLine.append(pts, total);
  words.append(title, ptsLine);
  const tally = el('span', 'ach-hud-count');
  tally.append(got, of);
  const id = el('div', 'ach-hud-id');
  id.append(icon, words, tally);
  const slots = el('div', 'ach-hud-slots');
  // Each line holds text from the start, so the HUD is as tall before the standings come as after.
  const BLANK = '\u00a0';
  const nowLabel = el('span', 'ach-hud-now', 'NOW '), value = el('span', 'ach-hud-value', '------'), rankEl = el('span', 'ach-hud-rank', BLANK);
  const fill = el('i', 'ach-hud-fill');
  // "NEXT ZAK 041200 · " changes when the next player does, the gap as the score runs.
  const next = el('span', 'ach-hud-next'), who = el('span', '', BLANK), gapBox = el('span'), gap = el('span', '', '0');
  gapBox.append(gap, ' to go');
  gapBox.hidden = true;
  next.append(who, gapBox);
  const line1 = el('div', 'ach-hud-l1'), track = el('div', 'ach-hud-track');
  const valueBox = el('span');
  valueBox.append(nowLabel, value);
  line1.append(valueBox, rankEl);
  track.append(fill);
  // The board chased, named when the game has more than one.
  const boardName = el('span', 'ach-hud-board');
  boardName.hidden = true;
  const chaseEl = el('div', 'ach-hud-chase');
  chaseEl.append(boardName, line1, track, next);
  inner.append(id, slots, chaseEl);
  const tools = el('div', 'ach-hud-tools');
  const grip = tool('ach-hud-grip', 'Move (arrows), reshape (Shift+arrows)', '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>');
  const turn = tool('ach-hud-turn', 'Stand up or lie down', '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>');
  const fade = tool('ach-hud-fade', 'Fade while playing', '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>');
  const hide = tool('ach-hud-hide', 'Hide the trophies', '<path d="M6 6l12 12M18 6L6 18"/>');
  tools.append(grip, turn, fade, hide);
  const corner = el('span', 'ach-hud-resize');
  corner.title = 'Drag to reshape';
  hud.append(inner, tools, corner);
  // The lines a drag snaps to, made once.
  const guideV = el('i', 'ach-hud-guide v'), guideH = el('i', 'ach-hud-guide h');
  guideV.hidden = guideH.hidden = true;
  area.append(hud, guideV, guideH);
  // The button's ring shows the set's progress; its badge, what happened while the HUD was hidden.
  button.insertAdjacentHTML('beforeend', '<svg class="model-viewer-hud-ring" viewBox="0 0 40 40" aria-hidden="true"><circle class="bg" cx="20" cy="20" r="18.5"/><circle class="fg" cx="20" cy="20" r="18.5" stroke-dasharray="0 200"/></svg>');
  const ringFg = button.querySelector('.model-viewer-hud-ring .fg');

  // ── What it shows ─────────────────────────────────────────────────────
  let game = null;              // the engine's snapshot
  let board = null;             // the leaderboard chased: the one last played, else the first
  const standings = new Map();  // board id → { others, me }
  let live = null;              // the chased board's running score while it is in play
  const running = new Map();    // board id → its running score, the latest started last
  const arriving = new Set();   // unlocks still flying to their slot
  let userId = null;
  let lastRank = 0, lastClimb = -Infinity, pending = 0, counting = 0;
  // What the chase shows, so only a change is written.
  let shownLabel = 'NOW ', shownValue = '', shownRank = -1, shownWho = null, shownFill = -1, shownGap = '', shownDiff = NaN;
  const result = { rank: 1, next: null, passed: null };

  const isGot = (a) => a.unlocked && !arriving.has(a.id);
  const available = () => !!(engine()?.enabled && game && (game.achievements.length || game.leaderboards.length));
  const onScreen = () => !area.hidden && !hud.hidden;

  function buildSlots() {
    slots.replaceChildren(...game.achievements.map((a, i) => {
      const s = el('span', 'ach-hud-slot', String(i + 1));
      s.addEventListener('pointerenter', () => showTip(s, a.id, i));
      s.addEventListener('pointerleave', hideTip);
      return s;
    }));
  }
  function paintSlots() {
    const list = game?.achievements ?? NONE;
    const firstLocked = list.findIndex((a) => !isGot(a));
    list.forEach((a, i) => {
      const s = slots.children[i];
      if (!s) return;
      s.classList.toggle('is-got', isGot(a));
      s.classList.toggle('is-next', i === firstLocked);
      s.setAttribute('aria-label', `${a.title}: ${isGot(a) ? 'unlocked' : 'locked'}, ${a.points} points`);
    });
    const n = list.filter(isGot).length;
    got.textContent = String(n);
    of.textContent = `/${list.length}`;
    total.textContent = ` / ${list.reduce((t, a) => t + (a.points || 0), 0)} pts`;
    const len = 2 * Math.PI * 18.5;
    ringFg?.setAttribute('stroke-dasharray', `${list.length ? (len * n) / list.length : 0} ${len}`);
  }
  const gotPoints = () => (game?.achievements ?? NONE).filter(isGot).reduce((t, a) => t + (a.points || 0), 0);

  async function loadStandings(l) {
    const e = engine();
    if (!e || !l) return;
    const hash = game?.hash;
    let st = null;
    try { st = await e.leaderboard(l.id, 100); } catch { st = null; }
    if (game?.hash !== hash) return;
    const mine = me()?.id ?? null;
    const others = (st?.entries ?? NONE).filter((x) => mine == null || x.user?.id !== mine)
      .map((x) => ({ name: (x.user?.name ?? x.name ?? '?').toUpperCase(), value: x.value }));
    standings.set(l.id, { others, me: st?.me ?? null });
    if (board?.id === l.id) { lastRank = 0; shownWho = null; paintChase(false); }
  }
  function boardOf(bid) {
    const ls = game.leaderboards;
    for (let i = 0; i < ls.length; i++) if (ls[i].id === bid) return ls[i];
    return null;
  }
  function setBoard(l) {
    board = l;
    lastRank = 0;
    shownWho = null;
    shownDiff = NaN;
    hud.dataset.chase = l ? 'on' : 'off';
    const name = l && game?.leaderboards.length > 1 ? boardLabel(l.title) : '';
    boardName.textContent = name;
    boardName.hidden = !name;
  }

  // ── The chase: the running score (or the best), its rank, the next to pass ──
  function formatted(x) {
    const e = engine();
    return e ? e.format(x, board.format) : String(x);
  }
  function paintChase(playing) {
    if (!board) return;
    const st = standings.get(board.id);
    const v = live ?? st?.me?.value ?? null;
    const label = live != null ? 'NOW ' : 'BEST ';
    if (label !== shownLabel) { shownLabel = label; write(nowLabel, label); }
    if (v == null) {
      showValue('------');
      showRank(0);
      showWho(null, st ? 'NO SCORE YET' : BLANK);
      showFill(0);
      return;
    }
    const c = chase(st ? st.others : NONE, v, board.lowerIsBetter, result);
    showValue(formatted(v));
    showRank(c.rank);
    if (c.next) {
      const from = c.passed ? c.passed.value : board.lowerIsBetter ? null : 0;
      showFill(from == null || c.next.value === from ? 0 : clamp((v - from) / (c.next.value - from), 0, 1));
      showWho(c.next, null);
      const d = c.next.value - v;
      if (d !== shownDiff) { shownDiff = d; const g = gapText(d, board, formatted); if (g !== shownGap) { shownGap = g; write(gap, g); } }
    } else {
      showFill(1);
      showWho(null, 'TOP OF THE BOARD');
    }
    if (playing && lastRank && c.rank < lastRank) climbed(c.rank);
    lastRank = c.rank;
  }
  function showValue(t) { if (t !== shownValue) { shownValue = t; write(value, t); } }
  function showRank(n) {
    if (n === shownRank) return;
    shownRank = n;
    write(rankEl, n ? ordinal(n).toUpperCase() : BLANK);
    rankEl.dataset.rank = String(Math.min(n, 4));
  }
  // The next player, or a line in their place; the gap shows only with a player.
  function showWho(entry, text) {
    const key = entry ?? text;
    if (key === shownWho) return;
    shownWho = key;
    write(who, entry ? `NEXT ${entry.name} ${formatted(entry.value)} · ` : text);
    gapBox.hidden = !entry;
  }
  // Scaled, never sized: a step of 1/500 or more is written, so no layout.
  function showFill(p) {
    const q = Math.round(p * 500);
    if (q === shownFill) return;
    shownFill = q;
    fill.style.transform = FILL[q];
  }
  // Running scores come every frame, or faster in warp: painted once per display frame.
  let framed = false;
  function paintFrame() { framed = false; paintChase(true); }

  // ── Layout: the box's shape picks it, the font size fits it ───────────
  function bounds() {
    const W = area.clientWidth, H = area.clientHeight;
    return { W, H, left: Math.min(BUTTONS, W / 4), top: MARGIN, right: W - MARGIN, bottom: H - MARGIN };
  }
  function measureAs(layoutName, n, bw, bh) {
    hud.dataset.layout = layoutName;
    inner.style.setProperty('--ach-hud-cols', String(slotColumns(layoutName, n)));
    hud.style.fontSize = '10px';
    return 10 * Math.min(bw / hud.offsetWidth, bh / hud.offsetHeight);
  }
  function fit(bw, bh) {
    const aspect = bw / bh, n = game?.achievements.length ?? 0;
    const before = hud.dataset.layout;
    let f = measureAs(n ? layoutFor(aspect, compact()) : pillFor(aspect), n, bw, bh);
    if (n && f < PILL_BELOW) f = measureAs(pillFor(aspect), n, bw, bh);
    hud.style.fontSize = `${clamp(f, 6, FONT_MAX).toFixed(2)}px`;
    return before !== hud.dataset.layout;
  }
  function place() {
    const b = bounds(), w = hud.offsetWidth, h = hud.offsetHeight;
    const left = b.left + S.fx * Math.max(0, b.right - b.left - w);
    const top = b.top + S.fy * Math.max(0, b.bottom - b.top - h);
    hud.style.left = `${left}px`;
    hud.style.top = `${top}px`;
    hud.classList.toggle('ach-hud-tools-below', top < 44);
    hud.classList.toggle('ach-hud-tools-start', left + w / 2 < 64);
    hud.classList.toggle('ach-hud-tools-end', left + w / 2 > b.W - 64);
    // The corner grip faces the open room, so a docked HUD can always grow.
    hud.dataset.corner = `${S.fy > 0.5 ? 't' : 'b'}${S.fx > 0.5 ? 'l' : 'r'}`;
  }
  function share(left, top) {
    const b = bounds(), fw = b.right - b.left - hud.offsetWidth, fh = b.bottom - b.top - hud.offsetHeight;
    S.fx = fw > 0 ? clamp((left - b.left) / fw, 0, 1) : 0.5;
    S.fy = fh > 0 ? clamp((top - b.top) / fh, 0, 1) : 0.5;
  }
  function layout() {
    if (!onScreen() || !area.clientWidth) return false;
    const W = area.clientWidth;
    const changed = fit(S.bw * W, S.bh * W);
    place();
    return changed;
  }
  // Slots clack back in one by one, the rest drawn in a few raster lines at a time.
  function redraw(delay = 0) {
    if (reducedMotion()) return;
    for (const n of [id, chaseEl]) { n.style.animationDelay = `${delay}ms`; replay(n, 'ach-hud-in-raster'); }
    [...slots.children].forEach((s, i) => { s.style.animationDelay = `${delay + i * 22}ms`; replay(s, 'ach-hud-clack'); });
  }
  // A move and reshape as one: the skin glides from where it was, its contents redraw.
  function morph(change) {
    const a = hud.getBoundingClientRect();
    change();
    const b = hud.getBoundingClientRect();
    if (reducedMotion() || !a.width || !b.width) return;
    hud.animate([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${a.width / b.width}, ${a.height / b.height})`, transformOrigin: '0 0' }, { transform: 'none', transformOrigin: '0 0' }],
      { duration: 460, easing: 'cubic-bezier(.2, .9, .3, 1.12)' });
    inner.animate([{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }], { duration: 460 });
    redraw(180);
  }

  // ── Show and hide: out of the button, back into it ────────────────────
  function sync(animate = false) {
    const can = available();
    button.hidden = !can;
    const show = can && S.shown;
    button.setAttribute('aria-pressed', String(show));
    if (show === !hud.hidden) { if (show) layout(); return; }
    hideTip();
    const from = button.getBoundingClientRect();
    if (show) {
      hud.hidden = false;
      layout();
      pending = 0;
      badge('');
      if (animate && !reducedMotion() && from.width) {
        const r = hud.getBoundingClientRect();
        hud.animate([{ transform: `translate(${from.left + from.width / 2 - r.left}px, ${from.top + from.height / 2 - r.top}px) scale(.04)`, opacity: 0.2, transformOrigin: '0 0' },
          { transform: 'none', opacity: 1, transformOrigin: '0 0' }], { duration: 480, easing: 'cubic-bezier(.2, .9, .3, 1.1)' });
        redraw(260);
      }
      wake();
    } else if (animate && !reducedMotion() && from.width && !area.hidden) {
      const r = hud.getBoundingClientRect();
      hud.animate([{ transform: 'none', opacity: 1, transformOrigin: '0 0' },
        { transform: `translate(${from.left + from.width / 2 - r.left}px, ${from.top + from.height / 2 - r.top}px) scale(.04)`, opacity: 0.2, transformOrigin: '0 0' }],
      { duration: 340, easing: 'cubic-bezier(.6, 0, .9, .5)' }).onfinish = () => { if (!S.shown) hud.hidden = true; ping(); };
    } else hud.hidden = true;
  }
  function setShown(on) { S.shown = on; save(); sync(true); }
  button.addEventListener('click', () => setShown(!S.shown));
  hide.addEventListener('click', () => setShown(false));
  function badge(text, cls = '') {
    button.querySelector('.model-viewer-hud-badge')?.remove();
    if (text) button.append(el('span', `model-viewer-hud-badge ${cls}`, text));
  }
  function ping() { if (!reducedMotion()) replay(button, 'is-ping'); }

  // ◐ fades it after a few quiet seconds; anything happening brings it back.
  let idleTimer = 0;
  function goIdle() { hud.classList.add('is-idle'); }
  function wake() {
    hud.classList.remove('is-idle');
    clearTimeout(idleTimer);
    if (S.fade) idleTimer = setTimeout(goIdle, 3500);
  }
  fade.setAttribute('aria-pressed', String(S.fade));
  fade.addEventListener('click', () => { S.fade = !S.fade; fade.setAttribute('aria-pressed', String(S.fade)); save(); wake(); });
  hud.addEventListener('pointerenter', wake);
  hud.addEventListener('pointerleave', wake);

  // ── Move, snapping to the edges and center lines ──────────────────────
  // Bounds and size are read once when a drag starts: a move only writes.
  let snapLine = null;
  function snap(v, sz, lo, hi, mid) {
    if (Math.abs(v - lo) < SNAP) { snapLine = lo; return lo; }
    if (Math.abs(v - (hi - sz)) < SNAP) { snapLine = hi; return hi - sz; }
    if (Math.abs(v - (mid - sz / 2)) < SNAP) { snapLine = mid; return mid - sz / 2; }
    snapLine = null;
    return v;
  }
  function showGuide(g, at, side) {
    if (at == null) { if (!g.hidden) g.hidden = true; return; }
    g.hidden = false;
    g.style[side] = `${at}px`;
  }
  let drag = null;
  hud.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target === corner || (e.target.closest('.ach-hud-tool') && !e.target.closest('.ach-hud-grip'))) return;
    drag = { px: e.clientX, py: e.clientY, left: hud.offsetLeft, top: hud.offsetTop, w: hud.offsetWidth, h: hud.offsetHeight, b: bounds(), moved: false, id: e.pointerId };
    hud.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  hud.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.px, dy = e.clientY - drag.py;
    if (!drag.moved) {
      if (Math.abs(dx) + Math.abs(dy) < 5) return;
      drag.moved = true;
      hud.classList.add('is-dragging');
      hideTip();
      wake();
    }
    const b = drag.b, w = drag.w, h = drag.h;
    const x = snap(clamp(drag.left + dx, b.left, Math.max(b.left, b.right - w)), w, b.left, b.right, b.W / 2);
    showGuide(guideV, snapLine, 'left');
    const y = snap(clamp(drag.top + dy, b.top, Math.max(b.top, b.bottom - h)), h, b.top, b.bottom, b.H / 2);
    showGuide(guideH, snapLine, 'top');
    hud.style.left = `${x}px`;
    hud.style.top = `${y}px`;
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    // A tap on a touch screen shows the tools, as a pointer's hover does.
    if (!drag.moved && e.pointerType === 'touch') hud.classList.toggle('is-tools');
    if (drag.moved) { share(hud.offsetLeft, hud.offsetTop); place(); save(); }
    drag = null;
    hud.classList.remove('is-dragging');
    guideV.hidden = guideH.hidden = true;
  };
  hud.addEventListener('pointerup', endDrag);
  hud.addEventListener('pointercancel', endDrag);

  // ── Reshape by the corner, the opposite corner staying put ────────────
  // Fitting measures the HUD, so it runs once per display frame, not per pointer event.
  let size = null;
  corner.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const c = hud.dataset.corner;
    const ar = area.getBoundingClientRect();
    size = { c, ax: hud.offsetLeft + (c[1] === 'l' ? hud.offsetWidth : 0), ay: hud.offsetTop + (c[0] === 't' ? hud.offsetHeight : 0), ox: ar.left, oy: ar.top, b: bounds(), x: e.clientX, y: e.clientY, raf: 0, id: e.pointerId };
    corner.setPointerCapture(e.pointerId);
    hud.classList.add('is-resizing');
    hideTip();
    wake();
  });
  function reshape() {
    if (!size) return;
    size.raf = 0;
    const b = size.b, L = size.c[1] === 'l', T = size.c[0] === 't';
    const bw = clamp(Math.abs(size.x - size.ox - size.ax), 24, Math.max(24, L ? size.ax - b.left : b.right - size.ax));
    const bh = clamp(Math.abs(size.y - size.oy - size.ay), 24, Math.max(24, T ? size.ay - b.top : b.bottom - size.ay));
    S.bw = bw / b.W;
    S.bh = bh / b.W;
    const changed = fit(bw, bh);
    hud.style.left = `${L ? size.ax - hud.offsetWidth : size.ax}px`;
    hud.style.top = `${T ? size.ay - hud.offsetHeight : size.ay}px`;
    if (changed) redraw(0);
  }
  corner.addEventListener('pointermove', (e) => {
    if (!size || e.pointerId !== size.id) return;
    size.x = e.clientX;
    size.y = e.clientY;
    if (!size.raf) size.raf = requestAnimationFrame(reshape);
  });
  const endSize = (e) => {
    if (!size || e.pointerId !== size.id) return;
    cancelAnimationFrame(size.raf);
    reshape();
    size = null;
    hud.classList.remove('is-resizing');
    share(hud.offsetLeft, hud.offsetTop);
    place();
    save();
  };
  corner.addEventListener('pointerup', endSize);
  corner.addEventListener('pointercancel', endSize);

  // The grip by keyboard: arrows move it, Shift+arrows reshape it.
  grip.addEventListener('keydown', (e) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    if (e.shiftKey) { S.bw = clamp(S.bw + d[0] * 0.02, 0.02, 1); S.bh = clamp(S.bh + d[1] * 0.02, 0.02, 3); layout(); }
    else { S.fx = clamp(S.fx + d[0] * 0.03, 0, 1); S.fy = clamp(S.fy + d[1] * 0.03, 0, 1); place(); }
    save();
  });

  // ⟲ stands it up or lays it down, keeping its center.
  turn.addEventListener('click', () => {
    const r = hud.getBoundingClientRect(), a = area.getBoundingClientRect();
    const cx = r.left - a.left + r.width / 2, cy = r.top - a.top + r.height / 2;
    morph(() => {
      const w0 = S.bw;
      S.bw = S.bh;
      S.bh = w0;
      layout();
      const b = bounds(), w = hud.offsetWidth, h = hud.offsetHeight;
      share(clamp(cx - w / 2, b.left, b.right - w), clamp(cy - h / 2, b.top, b.bottom - h));
      place();
    });
    save();
    wake();
  });

  // ── A slot's mini toast: beside it in a column, above or below it otherwise ──
  let tip = null;
  function showTip(s, aid, i) {
    hideTip();
    const a = game?.achievements.find((x) => x.id === aid);
    if (!a || drag?.moved || size) return;
    const isNext = s.classList.contains('is-next');
    tip = el('div', `ach-hud-tip mode-dark${isGot(a) ? ' is-got' : isNext ? ' is-next' : ''}`);
    const pic = el('span', 'ach-hud-tip-icon', isGot(a) ? null : String(i + 1));
    const t = el('b');
    if (reducedMotion()) t.textContent = a.title; else flap(t, a.title);
    const lines = el('span', 'ach-hud-tip-words');
    lines.append(t, el('span', '', isGot(a) ? `${a.description} Unlocked ${a.unlockedAt ? ago(a.unlockedAt) : 'before'}.` : a.description));
    tip.append(pic, lines, el('span', 'ach-hud-tip-pts', isGot(a) ? `+${a.points}` : String(a.points)));
    area.append(tip);
    const ar = area.getBoundingClientRect(), r = s.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight, room = 10;
    const x0 = r.left - ar.left, y0 = r.top - ar.top;
    let x, y;
    if (hud.dataset.layout?.startsWith('col')) {
      x = x0 + r.width / 2 > ar.width / 2 ? x0 - tw - room : x0 + r.width + room;
      y = y0 + r.height / 2 - th / 2;
    } else {
      x = x0 + r.width / 2 - tw / 2;
      y = y0 > th + room + 8 ? y0 - th - room : y0 + r.height + room;
    }
    tip.style.left = `${clamp(x, 6, ar.width - tw - 6)}px`;
    tip.style.top = `${clamp(y, 6, ar.height - th - 6)}px`;
  }
  function hideTip() { tip?.remove(); tip = null; }

  // ── An unlock: its trophy flies from its toast into its slot ──────────
  function land(aid) {
    arriving.delete(aid);
    const before = +pts.textContent || 0;
    paintSlots();
    const i = game?.achievements.findIndex((a) => a.id === aid) ?? -1;
    const s = slots.children[i];
    if (!onScreen() || !s || reducedMotion()) { pts.textContent = String(gotPoints()); return; }
    replay(s, 'ach-hud-flash');
    sparkle(hud, s);
    replay(hud, 'ach-hud-sweep');
    count(pts, before, gotPoints(), String, 600);
    counting = performance.now() + 1100;
    wake();
  }
  function landHidden(aid) {
    arriving.delete(aid);
    paintSlots();
    pts.textContent = String(gotPoints());
    pending++;
    badge(`+${pending}`);
    ping();
  }
  // The toast showing this unlock, once it is up: waits while others are ahead of it in the queue.
  function whenToast(heading, then) {
    const until = performance.now() + 15000;
    const look = () => {
      const t = [...area.querySelectorAll(':scope > .ach-toast-unlock:not(.ach-toast-out)')].find((x) => x.querySelector('.ach-toast-title')?.getAttribute('aria-label') === heading);
      if (t) { setTimeout(() => then(t.isConnected ? t.querySelector('.ach-toast-icon') : null), 1300); return; }
      if (performance.now() > until || area.hidden) { then(null); return; }
      setTimeout(look, 250);
    };
    look();
  }
  function fly(from, aid) {
    const i = game?.achievements.findIndex((a) => a.id === aid) ?? -1;
    const target = onScreen() ? slots.children[i] : button.hidden ? null : button;
    if (!target) { arriving.delete(aid); paintSlots(); return; }
    if (!from || reducedMotion() || area.hidden) { if (target === button) landHidden(aid); else land(aid); return; }
    const ar = area.getBoundingClientRect(), r0 = from.getBoundingClientRect(), r1 = target.getBoundingClientRect();
    const x0 = r0.left - ar.left, y0 = r0.top - ar.top, x1 = r1.left - ar.left, y1 = r1.top - ar.top;
    const mx = (x0 + x1) / 2 + (x1 > x0 ? -1 : 1) * 60, my = Math.min(y0, y1) - 40 + (y1 - y0) * 0.2;
    const path = [
      { transform: `translate(${x0}px, ${y0}px) scale(1) rotate(0deg)` },
      { transform: `translate(${mx}px, ${my}px) scale(1.25) rotate(-25deg)`, offset: 0.45 },
      { transform: `translate(${x1}px, ${y1}px) scale(${r1.width / r0.width}) rotate(0deg)` },
    ];
    // The trophy and its trail: three echoes a beat behind, as a C64 game draws a sprite's.
    for (const k of [3, 2, 1, 0]) {
      const f = el('i', 'ach-hud-flyer');
      f.style.width = `${r0.width}px`;
      f.style.height = `${r0.height}px`;
      f.style.opacity = k ? String(0.45 - k * 0.12) : '1';
      area.append(f);
      f.animate(path, { duration: 760, delay: k * 45, easing: 'cubic-bezier(.45, 0, .25, 1)', fill: 'both' }).onfinish = () => {
        f.remove();
        if (k) return;
        if (target === button) landHidden(aid); else land(aid);
      };
    }
  }

  // Passing a player ticks the rank. Into the top ten it is stamped too, with the shower.
  function climbed(rank) {
    if (rank > 10) { if (onScreen() && !reducedMotion()) replay(rankEl, 'ach-hud-bump'); return; }
    const now = performance.now();
    if (now - lastClimb < 1500) return;
    lastClimb = now;
    if (!onScreen()) {
      if (!area.hidden && !button.hidden) { badge(ordinal(rank).toUpperCase(), 'is-rank'); ping(); }
      return;
    }
    wake();
    if (reducedMotion()) return;
    const medal = rank === 1 ? 'gold' : rank === 2 ? 'silver' : 'bronze';
    tremble(chaseEl, () => {
      replay(rankEl, 'ach-hud-bump');
      const st = el('span', 'ach-hud-stamp', `${ordinal(rank).toUpperCase()}!`);
      st.style.setProperty('--ach-ink', `var(--medal-${medal})`);
      chaseEl.append(st);
      setTimeout(() => st.remove(), 1700);
      replay(hud, 'ach-hud-sweep');
      burst(hud, { rings: 1, pieces: rank <= 3 ? 36 : 20, from: chaseEl });
    });
  }

  // ── The engine's news ─────────────────────────────────────────────────
  /** The game, its achievements or unlocks changed, the account changed, or achievements were turned on or off. */
  function refresh() {
    const g = engine()?.enabled ? engine().game : null;
    const changed = g?.hash !== game?.hash;
    const uid = me()?.id ?? null;
    const signedInAs = uid !== userId;
    userId = uid;
    game = g;
    if (changed) {
      standings.clear();
      arriving.clear();
      live = null;
      running.clear();
      pending = 0;
      badge('');
      shownValue = '';
      shownRank = -1;
      shownGap = '';
      shownDiff = NaN;
      setBoard(game?.leaderboards[0] ?? null);
      if (game) {
        title.textContent = game.title;
        icon.style.setProperty('--ach-icon', iconMask(GAME_ICONS[game.id] ?? KIND_ICONS.unlock));
        buildSlots();
        hud.dataset.slots = game.achievements.length ? 'on' : 'off';
      }
    }
    // A new game, or another account: its own entry is told apart from the others'.
    if (game && (changed || signedInAs)) for (const l of game.leaderboards) loadStandings(l);
    if (game) {
      paintSlots();
      if (performance.now() > counting) pts.textContent = String(gotPoints());
      paintChase(false);
    }
    sync(false);
    if (changed && onScreen()) { layout(); redraw(0); }
  }
  /** An unlock (engine onUnlock): its toast is showing, or about to. */
  function unlocked(achievement) {
    if (!game || !game.achievements.some((a) => a.id === achievement.id)) return;
    if (area.hidden || !available()) return;
    arriving.add(achievement.id);
    if (!onScreen()) { landHidden(achievement.id); return; }
    whenToast(achievement.title, (from) => fly(from, achievement.id));
  }
  /**
   * A leaderboard's running score, its end, or a posted score (engine onLeaderboard).
   * Several boards can run at once, as OutRun's routes: it follows the one that
   * started last, and another only when that one is no longer running.
   */
  function leaderboardEvent(e) {
    if (!game) return;
    const type = e.type, id = e.leaderboard.id;
    if (type === 'started' || type === 'updated') {
      if (type === 'started') running.delete(id);
      running.set(id, e.value);
      if (board === null || (board.id !== id && (type === 'started' || !running.has(board.id)))) setBoard(boardOf(id) ?? e.leaderboard);
      if (board.id !== id) return;
      live = e.value;
      if (!framed && !area.hidden) { framed = true; requestAnimationFrame(paintFrame); }
      return;
    }
    running.delete(id);
    if (type === 'submitted') { const l = boardOf(id); if (l) loadStandings(l); }
    if (board?.id !== id) return;
    // The board followed ended: the latest started of those still running takes over.
    let after = null;
    for (const k of running.keys()) after = k;
    if (after != null) setBoard(boardOf(after));
    live = after != null ? running.get(after) : null;
    lastRank = 0;
    paintChase(false);
  }

  // The view's size changed, or it opened: lay out again.
  new ResizeObserver(() => { if (!drag && !size) layout(); }).observe(area);
  mq?.addEventListener?.('change', () => { if (onScreen()) layout(); });
  // The C64 face arriving changes every measure.
  globalThis.document?.fonts?.addEventListener?.('loadingdone', () => { if (!drag && !size) layout(); });

  return { refresh, unlocked, leaderboardEvent, element: hud };
}
