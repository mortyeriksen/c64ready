// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/achievements/attract.js — attract mode, centered over the whole window:
// the page dimmed behind it, or the vibes view while that is open. When a game
// ends (its set's game over, or else its score posted), its high-score screen cycles the
// way an arcade cabinet's does between games: each board, Trophy Hunters and the
// player's trophies, a page at a time. It switches on like a CRT, a page's
// title cycles the C64's colours over raster bars, and its rows are PRINTed a
// character at a time. The pages turn on their own wherever the pointer rests,
// and the bars under it pick one. Space continues, as do the next game, ✕ and a
// click beside it. Not Esc: in Retro Vibes or fullscreen that is taken already.

import { KIND_ICONS, iconMask, flap, sparkle } from './toast.js';
import { ordinal } from './browse.js';

/** How long each page shows. */
export const PAGE_MS = 7000;
/** It waits for the score's toast to go, but no longer than this. */
const SETTLE_MS = 12000;
/**
 * A game that seems to have ended may still be playing, as OutRun runs on for a second at 0 and can
 * reach a checkpoint: it waits this long first, and an unlock after the first PLAYS_ON ms calls it off.
 */
const GRACE_MS = 2000, PLAYS_ON = 250;
/** The top ten of a board or Trophy Hunters; a player further down ends it with their own row. */
const ROWS = 10;

// Two fewer rows at the top when the player's own goes under them, after a gap: the screen holds as many.
const topRows = (entries, mine, own, limit) => (own && !entries.slice(0, limit).some(mine) ? limit - 2 : limit);

/**
 * A board's rows, best first: the top `limit`, or when the player is further
 * down, two fewer, a gap (null) and their own row at the end.
 */
export function boardRows(st, user, limit = ROWS) {
  const entries = st?.entries ?? [];
  const mine = (e) => user?.id != null && e.user?.id === user.id;
  const own = st?.me?.rank != null;
  const rows = entries.slice(0, topRows(entries, mine, own, limit)).map((e) => ({ rank: e.rank, name: e.user?.name ?? e.name ?? '?', value: e.value, me: mine(e) }));
  if (own && !rows.some((r) => r.me)) rows.push(null, { rank: st.me.rank, name: user?.name ?? 'YOU', value: st.me.value, me: true });
  return rows;
}

/** The Trophy Hunters rows, as a board's: by points, a star for a finished set. */
export function fameRows(top, user, limit = ROWS) {
  const entries = top?.entries ?? [];
  const mine = (e) => user?.id != null && e.user?.id === user.id;
  const own = top?.me?.rank != null;
  const rows = entries.slice(0, topRows(entries, mine, own, limit)).map((e) => ({ rank: e.rank, name: e.user?.name ?? '?', points: e.points, complete: !!e.complete, me: mine(e) }));
  if (own && !rows.some((r) => r.me)) rows.push(null, { rank: top.me.rank, name: user?.name ?? 'YOU', points: top.me.points, complete: !!top.me.complete, me: true });
  return rows;
}

/**
 * The pages for a game: after a game, the board just played and no other, as
 * OutRun's route A without the other routes; opened from the GAME tab, every
 * board. Then Trophy Hunters and the trophies when it has achievements.
 */
export function attractPages(game, { boards = new Map(), fame = null, played = null } = {}) {
  const shown = played != null ? game.leaderboards.filter((l) => l.id === played) : game.leaderboards;
  const pages = shown.map((l) => ({ kind: 'board', board: l, standings: boards.get(l.id) ?? null }));
  if (game.achievements.length) {
    if (fame?.entries?.length) pages.push({ kind: 'fame', top: fame });
    pages.push({ kind: 'trophies' });
  }
  return pages;
}

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const INK = { board: 'var(--green)', fame: 'var(--medal-gold)', trophies: 'var(--amber)' };
// The title's letters through eight colours (styles-achievements.css), 175 ms
// each, every letter half a step ahead of the one before: whole class names, made once.
const CYCLE = Array.from({ length: 8 }, (_, i) => `ach-toast-ch is-c${i}`);
const HALF_STEP_MS = 87.5;

/**
 * @param {object} o
 * @param {() => HTMLElement|null} o.host  where it shows: the vibes view while open, else the page
 * @param {HTMLElement} [o.watch]       the vibes view: opening or closing it ends attract mode
 * @param {() => object|null} o.engine  the achievement engine (engine.js)
 * @param {() => object|null} [o.me]    the signed-in user
 * @param {number} [o.pageMs]
 */
export function createAttract({ host, watch = null, engine, me = () => null, pageMs = PAGE_MS }) {
  let root = null, panel = null, screen = null, bar = null;
  let pages = [], page = -1, gen = 0, game = null, posted = null;
  let waiting = 0;                 // the settle timer, while waiting for the score's toast to go
  let last = null, lastGame = null;   // the board news of the game in play: the board played, and its score when posted
  let cycling = 0, cycleStep = 0, letters = null, shown = null;   // the title's colour cycle: half-steps, and each letter's colour
  const timers = new Set();
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  // Space continues. Taken before anything else sees it, the C64 included, and
  // its release too, so continuing presses nothing in the game.
  function onKey(e) {
    if (e.code !== 'Space' || !root) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    const up = (u) => {
      if (u.code !== 'Space') return;
      u.preventDefault();
      u.stopImmediatePropagation();
      globalThis.removeEventListener('keyup', up, true);
    };
    globalThis.addEventListener('keyup', up, true);
    close();
  }

  // ── Opening: after the score's toast, with the standings as they are now ──
  function schedule(e) {
    cancel();
    const until = performance.now() + SETTLE_MS, since = Date.now() + PLAYS_ON;
    const look = () => {
      waiting = 0;
      const where = host();
      if (!where || playsOn(since)) return;
      const busy = document.querySelector('.ach-toast:not(.ach-toast-out):not(.ach-toast-placing)');
      if (busy && performance.now() < until) { waiting = setTimeout(look, 400); return; }
      open(e);
    };
    waiting = setTimeout(look, GRACE_MS);
  }
  // An unlock since the game seemed to end: it is still being played. A time ahead of this clock is
  // the server's, from before, and not counted.
  function playsOn(since) {
    const list = engine()?.game?.achievements, now = Date.now();
    if (list) for (let i = 0; i < list.length; i++) { const at = list[i].unlockedAt; if (at > since && at <= now) return true; }
    return false;
  }
  function cancel() { clearTimeout(waiting); waiting = 0; }

  async function open(e = null) {
    const eng = engine();
    const g = eng?.enabled ? eng.game : null;
    const where = host();
    if (!g || !where || !(g.leaderboards.length || g.achievements.length)) return;
    const my = gen + 1;
    gen = my;
    const boards = new Map();
    let fame = null;
    await Promise.all([
      ...g.leaderboards.map((l) => eng.leaderboard(l.id, 10).then((st) => { boards.set(l.id, st); }, () => {})),
      g.achievements.length && eng.api?.top ? eng.api.top(g.hash, 10).then((t) => { fame = t; }, () => {}) : null,
    ]);
    if (gen !== my || host() !== where) return;
    game = g;
    posted = e;
    pages = attractPages(g, { boards, fame, played: e?.leaderboard?.id ?? null });
    if (!pages.length) return;
    // The board just played comes first.
    const first = Math.max(0, pages.findIndex((p) => p.kind === 'board' && p.board.id === e?.leaderboard?.id));
    build(where);
    show(first, true);
  }

  function build(where) {
    root?.remove();
    // Over the page it is fixed to the window; in the vibes view it fills that.
    root = el('div', `ach-attract${where === document.body ? ' is-window' : ''}`);
    root.style.setProperty('--ach-hud-trophy', iconMask(KIND_ICONS.unlock));
    const scrim = el('div', 'ach-attract-scrim');
    scrim.addEventListener('click', () => close());
    panel = el('div', 'ach-attract-panel mode-dark');
    panel.tabIndex = -1;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', `${game.title}: high scores`);
    const x = el('button', 'ach-attract-x', '✕');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', () => close());
    const tube = el('div', 'ach-attract-tube');
    screen = el('div', 'ach-attract-screen');
    tube.append(screen);
    bar = el('div', 'ach-attract-pages');
    pages.forEach((p, i) => {
      const b = el('button', 'ach-attract-page');
      b.type = 'button';
      b.setAttribute('aria-label', `Page ${i + 1}`);
      b.append(el('i'));
      b.addEventListener('click', () => show(i));
      bar.append(b);
    });
    panel.append(x, tube, bar);
    panel.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowRight') { ev.preventDefault(); show(page + 1); }
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); show(page - 1); }
    });
    root.append(scrim, panel);
    where.append(root);
    globalThis.addEventListener('keydown', onKey, true);
    if (!reducedMotion()) panel.classList.add('is-landing');
  }

  // A page: the screen switches off and on to it, and its time drains in the bar below.
  function show(i, first = false) {
    if (!root || !pages.length) return;
    page = (i + pages.length) % pages.length;
    const my = ++gen;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    const p = pages[page];
    panel.style.setProperty('--ach-ink', INK[p.kind]);
    [...bar.children].forEach((b, k) => {
      b.classList.toggle('is-done', k < page);
      b.classList.remove('is-run');
      const fresh = el('i');
      b.firstChild.replaceWith(fresh);
      if (k !== page) return;
      b.style.setProperty('--ach-attract-ms', `${pageMs}ms`);
      b.classList.add('is-run');
      fresh.addEventListener('animationend', () => { if (gen === my) show(page + 1); });
    });
    const still = reducedMotion();
    const draw = () => { if (gen === my) render(p, my, still); };
    if (still) { draw(); return; }
    if (first) { screen.classList.remove('is-off'); restart(screen, 'is-on'); later(260, draw); return; }
    screen.classList.remove('is-on');
    restart(screen, 'is-off');
    later(250, () => { screen.classList.remove('is-off'); restart(screen, 'is-on'); draw(); });
  }
  // A half-step on: each letter whose colour comes round moves on. Only those are written.
  function cycle() {
    cycleStep = (cycleStep + 1) & 15;
    for (let i = 0; i < letters.length; i++) {
      const c = ((cycleStep + i) >> 1) & 7;
      if (shown[i] === c) continue;
      shown[i] = c;
      letters[i].className = CYCLE[c];
    }
  }
  function stopCycle() { clearInterval(cycling); cycling = 0; letters = null; }
  function restart(node, cls) { node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); }

  function render(p, my, still) {
    const head = el('div', 'ach-attract-head');
    const bars = el('div', 'ach-attract-bars');
    for (let k = 0; k < 3; k++) bars.append(el('i'));
    const label = p.kind === 'board' ? p.board.title : p.kind === 'fame' ? 'Trophy hunters' : 'Trophies';
    const title = el('div', 'ach-attract-title');
    title.style.setProperty('--ach-attract-fit', String(Math.min(1, 14 / Math.max(1, label.length))));
    stopCycle();
    if (still) title.textContent = label;
    else {
      flap(title, label);
      letters = title.children;
      shown = new Int8Array(letters.length).fill(-1);
      cycle();
      cycling = setInterval(cycle, HALF_STEP_MS);
    }
    head.append(bars, title);
    const body = el('div', 'ach-attract-body');
    const foot = el('div', 'ach-attract-foot');
    foot.append(el('span', '', game.title), el('span', 'ach-attract-press', 'PRESS SPACE TO CONTINUE'));
    screen.replaceChildren(head, body, foot);
    if (p.kind === 'trophies') { trophies(body, my, still); return; }
    const user = me();
    const fmt = (v) => engine()?.format(v, p.board?.format) ?? String(v);
    const lines = p.kind === 'board'
      ? boardRows(p.standings, user).map((r) => (r ? { cls: rowClass(r), cells: [ordinal(r.rank).toUpperCase(), r.name, fmt(r.value)] } : null))
      : fameRows(p.top, user).map((r) => (r ? { cls: rowClass(r), cells: [ordinal(r.rank).toUpperCase(), r.name, `${r.points} PTS`], star: r.complete } : null));
    if (p.kind === 'board' && posted?.type === 'submitted' && posted.leaderboard?.id === p.board.id) {
      // The score just played, under the board.
      const tag = posted.softcore ? ' SOFTCORE' : posted.result?.improved ? ' NEW BEST!' : '';
      lines.push({ cls: 'is-blank', cells: ['', '', ''] }, { cls: 'is-you', cells: ['YOU', `${user?.name ?? 'PLAYER'}${tag}`, fmt(posted.value)] });
    }
    if (!lines.length) lines.push({ cls: 'is-rest', cells: ['', p.kind === 'board' ? 'NO SCORES YET' : 'NO ONE YET', ''] });
    const players = p.kind === 'board' ? p.standings?.players : p.top?.players;
    type(body, lines, my, still, () => {
      if (players) body.append(el('div', 'ach-attract-count', players === 1 ? '1 PLAYER' : `${players} PLAYERS`));
    });
  }
  const rowClass = (r) => `${r.rank <= 3 ? `is-podium is-rank-${r.rank}` : 'is-rest'}${r.me ? ' is-me' : ''}`;

  // Rows PRINTed a character a frame behind a blinking cursor. One prebound
  // step appends one character (a cached one-letter string) to a text node:
  // nothing is allocated per character, only a row's elements as it starts.
  // The cursor is the typed cell's ::after: moving it inserts no node, which
  // would have the page's body:has() rules restyle the whole page.
  let typing = null, typingCell = null;
  function typeIn(cell) {
    if (cell === typingCell) return;
    typingCell?.classList.remove('is-typing');
    typingCell = cell;
    cell?.classList.add('is-typing');
  }
  function type(body, lines, my, still, done) {
    if (still) {
      for (const line of lines) {
        const row = startRow(body, line);
        if (line) row.cells.forEach((t, c) => { t.data = line.cells[c]; });
        if (line?.star) row.el.children[1].append(el('span', 'ach-attract-star', ' ★'));
      }
      done();
      return;
    }
    typing = { body, lines, my, done, li: 0, ci: 0, k: 0, row: null };
    requestAnimationFrame(step);
  }
  function startRow(body, line) {
    const row = el('div', `ach-attract-row ${line ? line.cls : 'is-gap'}`);
    body.append(row);
    if (!line) { row.textContent = '...'; return { el: row, cells: [] }; }
    const cells = [];
    for (let c = 0; c < line.cells.length; c++) {
      const span = el('span');
      const t = document.createTextNode('');
      span.append(t);
      row.append(span);
      cells.push(t);
    }
    return { el: row, cells };
  }
  function step() {
    const t = typing;
    if (!t || t.my !== gen) { typing = null; typeIn(null); return; }
    while (t.li < t.lines.length) {
      const line = t.lines[t.li];
      if (!t.row) { t.row = startRow(t.body, line); t.ci = 0; t.k = 0; }
      if (!line) { t.row = null; t.li++; continue; }
      const text = line.cells[t.ci];
      if (t.k < text.length) {
        const node = t.row.cells[t.ci];
        node.appendData(text[t.k++]);
        typeIn(node.parentNode);
        requestAnimationFrame(step);
        return;
      }
      if (++t.ci < line.cells.length) { t.k = 0; continue; }
      if (line.star) t.row.el.children[1].append(el('span', 'ach-attract-star', ' ★'));
      t.row = null;
      t.li++;
    }
    typing = null;
    typeIn(null);
    t.done();
  }

  // The trophies: one tile each, lit ones popping in with sparks, the next blinking.
  function trophies(body, my, still) {
    const list = game.achievements;
    const grid = el('div', 'ach-attract-tiles');
    grid.style.setProperty('--ach-attract-cols', String(Math.min(list.length, list.length > 16 ? 10 : 7)));
    const next = list.findIndex((a) => !a.unlocked);
    list.forEach((a, i) => {
      const t = el('span', `ach-attract-tile${a.unlocked ? ' is-got' : ''}`, a.unlocked ? null : String(i + 1));
      t.title = `${a.title}: ${a.description} (${a.points})`;
      grid.append(t);
      if (still) { if (i === next) t.classList.add('is-next'); return; }
      t.style.visibility = 'hidden';
      later(400 + i * 70, () => {
        if (gen !== my) return;
        t.style.visibility = '';
        t.classList.add('is-in');
        if (a.unlocked) later(120, () => { if (gen === my) sparkle(panel, t); });
        if (i === next) later(300, () => t.classList.add('is-next'));
      });
    });
    const got = list.filter((a) => a.unlocked);
    const sum = el('div', 'ach-attract-sum');
    sum.append(el('span', '', `${got.length} / ${list.length} TROPHIES`), el('span', '', `${got.reduce((n, a) => n + (a.points || 0), 0)} / ${list.reduce((n, a) => n + (a.points || 0), 0)} PTS`));
    body.append(grid, sum);
    if (next >= 0) body.append(el('div', 'ach-attract-next', `NEXT: ${list[next].title.toUpperCase()} +${list[next].points}`));
  }

  function close() {
    cancel();
    stopCycle();
    gen++;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    globalThis.removeEventListener('keydown', onKey, true);
    const r = root;
    root = null;
    if (!r) return;
    if (reducedMotion()) { r.remove(); return; }
    r.classList.add('is-closing');
    setTimeout(() => r.remove(), 260);
  }

  const ready = () => !!host() && !!engine()?.enabled;
  /**
   * A leaderboard's news (engine onLeaderboard): the next attempt ends attract
   * mode, and a posted score opens it, unless the set says when its game is over.
   */
  function leaderboardEvent(e) {
    const g = engine()?.game;
    if (e.type === 'started' || e.type === 'submitted') { last = e; lastGame = g?.hash ?? null; }
    if (e.type === 'started') { cancel(); if (root) close(); return; }
    if (e.type === 'submitted' && ready() && !g?.gameOver) schedule(e);
  }
  /** The set's game over (engine onGameOver): attract mode opens on the board last played, if any. */
  function gameOver() {
    if (!ready() || root || waiting) return;
    schedule(last && lastGame === engine().game?.hash ? last : null);
  }

  // Opening or closing the vibes view ends it: its place is gone.
  if (watch) new MutationObserver(() => { cancel(); if (root) close(); }).observe(watch, { attributes: true, attributeFilter: ['hidden'] });

  return { leaderboardEvent, gameOver, open, close, isOpen: () => !!root };
}
