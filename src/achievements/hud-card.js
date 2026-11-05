// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/achievements/hud-card.js — the trophy HUD as a card at the head of the
// Achievements window's GAME tab: the vibes HUD's game block, a slot per
// achievement and the chase of the next player up, in the HUD's own classes
// (hud.js, styles-achievements.css), so a player knows it from the 3D view.
// And every trophy under the boards as a toast in miniature.

import { KIND_ICONS, iconMask, drawGameIcon } from './toast.js';
import { gameIconUrl } from './game-icons.js';
import { chase, gapText, boardLabel, slotColumns, challengeFx, challengeSince, FX_CLASS, FX_GOING_OUT, FX_BACK } from './hud.js';
import { h, ordinal, ago } from './browse.js';

const BLANK = ' ';
// The fill's 501 steps, made once: a running score moves it without allocating.
const FILL = Array.from({ length: 501 }, (_, i) => `scaleX(${i / 500})`);
const write = (node, text) => { if (node.firstChild) node.firstChild.data = text; else node.textContent = text; };
// A slot or card built again mid-effect carries on where it was.
const fxDelay = (a, fx, now) => (fx === FX_GOING_OUT || fx === FX_BACK ? `--ach-fx-delay: -${challengeSince(a, now)}ms` : null);

/** The boards GAME shows: while boards are played those running, the one in play on top, else every one. */
export function boardsShown(leaderboards, runningIds = [], playingId = null) {
  const on = leaderboards.filter((l) => runningIds.includes(l.id));
  if (!on.length) return leaderboards;
  return [...on.filter((l) => l.id === playingId), ...on.filter((l) => l.id !== playingId)];
}
/** The board the HUD chases: the one in play, else the first the player has a score on, else the first. */
export function boardChased(leaderboards, playingId, hasScore) {
  return leaderboards.find((l) => l.id === playingId) ?? leaderboards.find((l) => hasScore(l.id)) ?? leaderboards[0] ?? null;
}

/**
 * The HUD card for `game`, chasing `board` (null for a game without one).
 * @param {object} o
 * @param {object} o.game          the engine's snapshot
 * @param {object|null} o.board    the leaderboard chased: the one in play, else the player's
 * @param {object|null} o.standings  that board's standings, as fetched (all its entries)
 * @param {number|null} o.live     its running score while it is played
 * @param {number|null} o.meId     the signed-in player, told apart from the others
 * @param {(v: number, f: string) => string} o.format
 * @param {HTMLElement[]} [o.buttons]  on the game's line: attract mode, refresh
 * @returns {{ el: HTMLElement, live: (value: number) => void }}
 */
export function hudCard({ game, board, standings, live = null, meId = null, format, buttons = [] }) {
  const list = game.achievements;
  const n = list.filter((a) => a.unlocked).length;
  const pts = list.filter((a) => a.unlocked).reduce((t, a) => t + (a.points || 0), 0);
  const total = list.reduce((t, a) => t + (a.points || 0), 0);
  const next = list.findIndex((a) => !a.unlocked);
  const now = Date.now();

  const icon = h('span', { class: 'ach-hud-icon' });
  drawGameIcon(icon, gameIconUrl(game.id));
  const id = h('div', { class: 'ach-hud-id' }, icon,
    h('span', { class: 'ach-hud-words' }, h('h3', { class: 'ach-hud-title ach-game-title' }, game.title),
      list.length ? h('small', {}, h('i', {}, String(pts)), ` / ${total} pts · `, h('i', {}, String(n)), ` of ${list.length}`) : null),
    ...buttons);
  const slots = list.length ? h('div', { class: 'ach-hud-slots', role: 'img', 'aria-label': `${n} of ${list.length} unlocked` },
    list.map((a, i) => {
      const fx = challengeFx(a, now);
      return h('span', { class: `ach-hud-slot${a.unlocked ? ' is-got' : ''}${i === next ? ' is-next' : ''}${FX_CLASS[fx]}`, style: fxDelay(a, fx, now), title: `${a.title}: ${a.description} (${a.points})` }, String(i + 1));
    })) : null;

  // The chase: the running score, else the best, its rank and the next player to pass.
  const label = h('span', { class: 'ach-hud-now' }, 'BEST '), value = h('span', { class: 'ach-hud-value' }, '------'), rank = h('span', { class: 'ach-hud-rank' }, BLANK);
  const fill = h('i', { class: 'ach-hud-fill' }), who = h('span', {}, BLANK), gap = h('span', {}, '0'), gapBox = h('span', { hidden: true }, gap, ' to go');
  const chaseEl = board ? h('div', { class: 'ach-hud-chase' },
    game.leaderboards.length > 1 ? h('span', { class: 'ach-hud-board' }, boardLabel(board.title)) : null,
    h('div', { class: 'ach-hud-l1' }, h('span', {}, label, value), rank),
    h('div', { class: 'ach-hud-track' }, fill),
    h('span', { class: 'ach-hud-next' }, who, gapBox)) : null;

  const el = h('section', { class: 'ach-hud ach-hud-card', 'data-layout': 'box', 'data-chase': board ? 'on' : 'off', 'data-slots': list.length ? 'on' : 'off', 'aria-label': `${game.title}: trophies and rank` },
    h('div', { class: 'ach-hud-in' }, id, slots, chaseEl));
  el.style.setProperty('--ach-hud-trophy', iconMask(KIND_ICONS.unlock));
  if (slots) el.style.setProperty('--ach-hud-cols', String(slotColumns('box', list.length)));

  const others = (standings?.entries ?? []).filter((e) => meId == null || e.user?.id !== meId).map((e) => ({ name: (e.user?.name ?? e.name ?? '?').toUpperCase(), value: e.value }));
  const result = { rank: 1, next: null, passed: null };
  let shownValue = '', shownRank = -1, shownNext = null, shownGap = '', shownFill = -1, shownLabel = '';
  // Only what changed is written, in place: a running score repaints this every frame.
  function paint(running) {
    if (!board) return;
    const v = running ?? standings?.me?.value ?? null;
    const l = running != null ? 'NOW ' : 'BEST ';
    if (l !== shownLabel) { shownLabel = l; write(label, l); }
    if (v == null) {
      if (shownValue !== '------') { shownValue = '------'; write(value, '------'); }
      if (shownRank !== 0) { shownRank = 0; write(rank, BLANK); }
      if (shownNext !== 'none') { shownNext = 'none'; write(who, standings ? 'NO SCORE YET' : BLANK); gapBox.hidden = true; }
      return;
    }
    const c = chase(others, v, board.lowerIsBetter, result);
    const text = format(v, board.format);
    if (text !== shownValue) { shownValue = text; write(value, text); }
    if (c.rank !== shownRank) { shownRank = c.rank; write(rank, ordinal(c.rank).toUpperCase()); rank.dataset.rank = String(Math.min(c.rank, 4)); }
    let p = 1;
    if (c.next) {
      const from = c.passed ? c.passed.value : board.lowerIsBetter ? null : 0;
      p = from == null || c.next.value === from ? 0 : Math.min(1, Math.max(0, (v - from) / (c.next.value - from)));
      if (shownNext !== c.next) { shownNext = c.next; write(who, `NEXT ${c.next.name} ${format(c.next.value, board.format)} · `); gapBox.hidden = false; }
      const g = gapText(c.next.value - v, board, (x) => format(x, board.format));
      if (g !== shownGap) { shownGap = g; write(gap, g); }
    } else if (shownNext !== 'top') { shownNext = 'top'; write(who, 'TOP OF THE BOARD'); gapBox.hidden = true; }
    const q = Math.round(p * 500);
    if (q !== shownFill) { shownFill = q; fill.style.transform = FILL[q]; }
  }
  paint(live);
  return { el, live: paint };
}

/**
 * Every trophy of a game as a toast in miniature: a trophy when unlocked, its
 * number while locked, the next one marked. When it was unlocked, and whether
 * it is being checked.
 */
export function trophyCards(achievements, unlockedAt = () => null, checking = () => false) {
  const next = achievements.findIndex((a) => !a.unlocked);
  const now = Date.now();
  const list = h('ul', { class: 'ach-trophies' }, achievements.map((a, i) => {
    const got = a.unlocked, at = got ? unlockedAt(a) : null, fx = challengeFx(a, now);
    return h('li', { class: `ach-trophy ${got ? 'is-got' : 'is-locked'}${i === next ? ' is-next' : ''}${FX_CLASS[fx]}`, style: fxDelay(a, fx, now) },
      h('span', { class: 'ach-trophy-icon', 'aria-hidden': 'true' }, got ? null : String(i + 1)),
      h('span', { class: 'ach-trophy-words' },
        h('b', {}, a.title),
        h('span', {}, a.description),
        at ? h('em', {}, `Unlocked ${ago(at)}`) : null,
        got && checking(a) ? h('span', { class: 'ach-checking' }, 'Being checked') : null,
        h('span', { class: 'sr-only' }, got ? ' Unlocked.' : a.challenge === 'out' ? ' Out for now.' : ' Locked.')),
      h('span', { class: 'ach-trophy-pts' }, got ? `+${a.points}` : String(a.points)),
      i === next ? h('span', { class: 'ach-trophy-tag' }, 'NEXT UP') : null);
  }));
  list.style.setProperty('--ach-hud-trophy', iconMask(KIND_ICONS.unlock));
  return list;
}
