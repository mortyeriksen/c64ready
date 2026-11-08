// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/achievements/hud-card.js — the trophy HUD as a card at the head of the
// Achievements window's GAME tab: the vibes HUD's game block and a slot per
// achievement (the boards are listed under it), in the HUD's own classes
// (hud.js, styles-achievements.css), so a player knows it from the 3D view.
// And every trophy under the boards as a toast in miniature.

import { KIND_ICONS, iconMask, drawGameIcon } from './toast.js';
import { gameIconUrl } from './game-icons.js';
import { challengeFx, challengeSince, FX_CLASS, FX_GOING_OUT, FX_BACK } from './hud.js';
import { h, ago } from './browse.js';

// A slot or card built again mid-effect carries on where it was.
const fxDelay = (a, fx, now) => (fx === FX_GOING_OUT || fx === FX_BACK ? `--ach-fx-delay: -${challengeSince(a, now)}ms` : null);

/** The boards GAME shows: while boards are played those running, the one in play on top, else every one. */
export function boardsShown(leaderboards, runningIds = [], playingId = null) {
  const on = leaderboards.filter((l) => runningIds.includes(l.id));
  if (!on.length) return leaderboards;
  return [...on.filter((l) => l.id === playingId), ...on.filter((l) => l.id !== playingId)];
}
/**
 * The HUD card for `game`: its icon, title and points, and a slot per achievement.
 * @param {object} o
 * @param {object} o.game          the engine's snapshot
 * @param {HTMLElement[]} [o.buttons]  on the game's line: attract mode, refresh
 * @returns {{ el: HTMLElement }}
 */
export function hudCard({ game, buttons = [] }) {
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

  const el = h('section', { class: 'ach-hud ach-hud-card', 'data-layout': 'box', 'data-chase': 'off', 'data-slots': list.length ? 'on' : 'off', 'aria-label': `${game.title}: trophies` },
    h('div', { class: 'ach-hud-in' }, id, slots));
  el.style.setProperty('--ach-hud-trophy', iconMask(KIND_ICONS.unlock));

  return { el };
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
