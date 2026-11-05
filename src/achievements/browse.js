// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/achievements/browse.js — the Achievements window's achievement views, read from
// the games API (src/achievements/api.js): a game's head (title, a progress
// meter with one cell per achievement), its leaderboards drawn as the game's
// own high-score screen, its achievements, the activity feed, the list of
// games, a game's page and a player's profile. Names and game titles link to
// the profile and the game page. A player keeps one colour everywhere, the
// chat's name colours from the C64 palette.

import { pushEscapeLayer, popEscapeLayer } from '../ui/escape-stack.js';
import { ICON_GRID, gameIconUrl } from './game-icons.js';

/** Builds an element: attributes, `on` listeners, then children. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}
const SVG = 'http://www.w3.org/2000/svg';
function icon(paths, size = 15) {
  const s = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) s.setAttribute(k, v);
  for (const d of paths) { const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
}
export const trophyIcon = (size) => icon(['M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z', 'M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4'], size);
export const starIcon = (size) => icon(['M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z'], size);

/**
 * A game's own pixel icon, about `px` CSS pixels across at a whole number of device pixels per icon
 * pixel, so its pixels stay square and sharp on any screen; null for a game without one.
 */
export function gameIcon(id, px = 14) {
  const url = gameIconUrl(id);
  if (!url) return null;
  const dpr = globalThis.devicePixelRatio || 1;
  const size = (ICON_GRID * Math.max(1, Math.round((px / ICON_GRID) * dpr))) / dpr;
  return h('img', { src: url, width: size, height: size, alt: '', class: 'ach-game-icon', 'aria-hidden': 'true', draggable: 'false' });
}

/** How long ago `at` was, in a few words. */
export function ago(at, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
/** How long ago `at` was in one short unit: "just now", "5m ago", "3h ago", "2d ago", "5w ago", "1y ago". */
export function agoShort(at, now = Date.now()) {
  const mins = Math.floor(Math.max(0, now - at) / 60_000), hrs = Math.floor(mins / 60);
  if (mins < 1) return 'just now';
  if (hrs < 1) return `${mins}m ago`;
  if (hrs < 24) return `${hrs}h ago`;
  if (hrs < 24 * 7) return `${Math.floor(hrs / 24)}d ago`;
  if (hrs < 24 * 365) return `${Math.floor(hrs / (24 * 7))}w ago`;
  return `${Math.floor(hrs / (24 * 365))}y ago`;
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
export function ordinal(n) {
  const t = n % 100;
  const suffix = t >= 11 && t <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suffix}`;
}
/** A player's colour: one of the chat's eight name colours (chat-c0 … chat-c7), the same every time. */
export function playerHue(id) {
  let x = 0;
  for (const c of String(id)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return `chat-c${x % 8}`;
}

const note = (text) => h('p', { class: 'achievements-note' }, text);
const failed = (e) => h('p', { class: 'achievements-error', role: 'alert' }, e?.status === 404 ? 'Not found.' : 'The achievements server cannot be reached.');
const heading = (text) => h('h4', { class: 'ach-h' }, text);

/**
 * The views share one context:
 * @typedef {object} BrowseContext
 * @property {ReturnType<import('./api.js').createGamesApi>} api
 * @property {(value: number, format: string) => string} format
 * @property {(view: { type: 'profile', id: number } | { type: 'game', hash: string }) => void} go
 * @property {() => object|null} me  the signed-in user
 * @property {(user: object) => string|null} [pictureUrl]  a user's picture, or null
 * @property {(file: File) => Promise<object>} [setPicture]  sets the signed-in account's picture
 * @property {() => Promise<object>} [removePicture]  takes it down
 */

const playerLink = (ctx, user) => h('button', { type: 'button', class: `ach-player ${playerHue(user.id)}`, on: { click: () => ctx.go({ type: 'profile', id: user.id }) } }, user.name);
const gameLink = (ctx, game, cls = 'achievements-link') => h('button', { type: 'button', class: cls, on: { click: () => ctx.go({ type: 'game', hash: game.hash }) } }, game.title);
/** A player as the chat names them: their badge or tile, and their name, opening their profile. */
export const playerChip = (ctx, user) => h('span', { class: 'ach-player-chip' }, tile(ctx, user), playerLink(ctx, user));

/** A player's tile: their picture, or their initial in their colour. */
function tile(ctx, user, cls = 'ach-tile') {
  const url = ctx.pictureUrl?.(user);
  return h('span', { class: `${cls} ${playerHue(user.id)}${url ? ' has-picture' : ''}`, 'aria-hidden': 'true' },
    url ? h('img', { class: 'ach-picture', src: url, alt: '', loading: 'lazy', decoding: 'async' }) : (user.name || '?').slice(0, 1).toUpperCase());
}

/**
 * The tile on your own profile is the way to set your picture: a click picks
 * an image, which is shrunk to fit 256x256 here, never cropped, before it is uploaded.
 */
function ownTile(el, ctx, user, redraw) {
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-hidden': 'true' });
  const status = h('span', { class: 'ach-picture-status', role: 'status' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    status.textContent = 'Uploading…';
    try { await ctx.setPicture(file); redraw(); } catch (e) { status.textContent = e.message; }
  });
  const pick = h('button', { type: 'button', class: 'ach-picture-pick', title: user.avatar ? 'Change your badge' : 'Add a badge', 'aria-label': user.avatar ? 'Change your badge' : 'Add a badge', on: { click: () => input.click() } },
    tile(ctx, user, 'ach-tile ach-tile-big'), h('span', { class: 'ach-picture-hint', 'aria-hidden': 'true' }, user.avatar ? 'CHANGE' : 'ADD'));
  const change = h('button', { type: 'button', class: 'achievements-link', on: { click: () => input.click() } }, user.avatar ? 'change badge' : 'add a badge');
  const remove = user.avatar ? h('button', { type: 'button', class: 'achievements-link', on: { click: async () => {
    try { await ctx.removePicture(); redraw(); } catch (e) { status.textContent = e.message; }
  } } }, 'remove badge') : null;
  // The tile goes in the tile's place; the links go under the name, beside it.
  return { tile: h('div', { class: 'ach-picture-own' }, pick, input), actions: h('p', { class: 'ach-picture-actions' }, change, remove, status) };
}

/** One cell per achievement, lit when unlocked. */
export function meter(flags) {
  const n = flags.filter(Boolean).length;
  return h('div', { class: 'ach-meter', role: 'img', 'aria-label': `${n} of ${flags.length} unlocked` },
    flags.map((on) => h('span', { class: on ? 'is-lit' : null })));
}
/** "4 of 22 unlocked" beside "20 of 315 points". */
export function progress(got, total, points, totalPoints) {
  return h('div', { class: 'ach-progress' },
    h('span', {}, `${got} of ${total} unlocked`),
    h('span', {}, h('span', { class: 'ach-pts' }, String(points)), ` of ${totalPoints} points`));
}
/**
 * A game's head: its icon and title (a link, or plain for the loaded game), meter and
 * progress, and on the title line the versions, attract mode and refresh
 * buttons it is given. A game with high scores and no achievements says so instead.
 */
export function gameHead(ctx, game, achievements, isUnlocked, { link = false, versions = [], url = null, attract = null, refresh = null } = {}) {
  const title = h('h3', { class: 'ach-game-title' }, gameIcon(game.id, 24), link ? gameLink(ctx, game) : h('span', {}, game.title));
  const buttons = [versions.length ? versionButton() : null, attract ? attractButton(attract) : null, refresh ? refreshButton(refresh) : null].filter(Boolean);
  const top = buttons.length ? [h('div', { class: 'ach-game-top' }, title, ...buttons), ...(versions.length ? [versionCard(versions, game.title, url)] : [])] : [title];
  if (!achievements.length) return h('div', { class: 'ach-game' }, ...top, h('p', { class: 'achievements-note' }, 'This game has high scores, and no achievements yet.'));
  const got = achievements.filter(isUnlocked);
  const pts = (list) => list.reduce((n, a) => n + (a.points || 0), 0);
  return h('div', { class: 'ach-game' }, ...top,
    meter(achievements.map(isUnlocked)),
    progress(got.length, achievements.length, pts(got), pts(achievements)));
}

/** Shows the game's high-score screen as attract mode cycles it after a game (attract.js). */
export function attractButton(show) {
  return h('button', {
    type: 'button', class: 'ach-info-btn ach-attract-btn', 'aria-label': 'Show the high-score screen', title: 'Show the high-score screen',
    on: { click: () => show() },
  }, icon(['M3 4h18v12H3z', 'M8 20h8M12 16v4', 'M7 8h6M7 11h10'], 18));
}

/** Fetches the game's standings and checks again, spinning until they are in. */
export function refreshButton(refresh) {
  return h('button', {
    type: 'button', class: 'ach-info-btn ach-refresh-btn', 'aria-label': 'Refresh', title: 'Refresh',
    on: { click: async (e) => {
      const b = e.currentTarget;
      if (b.classList.contains('is-busy')) return;
      b.classList.add('is-busy');
      try { await refresh(); } finally { b.classList.remove('is-busy'); }
    } },
  }, icon(['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'], 18));
}

// The versions of a game a set is for, behind an info button on the title line: the button opens
// a card right under it, which ends with a link to a page about the game, opening in a new window.
let versionCards = 0;
function versionButton() {
  const id = `ach-versions-${++versionCards}`;
  return h('button', {
    type: 'button', class: 'ach-info-btn', 'aria-expanded': 'false', 'aria-controls': id, 'aria-label': 'Which version of the game', title: 'Which version of the game',
    on: { click: (e) => { const b = e.currentTarget, card = document.getElementById(id); const open = card.hidden; card.hidden = !open; b.setAttribute('aria-expanded', String(open)); } },
  }, icon(['M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18z', 'M12 11v6', 'M12 7.5v.01'], 18));
}
function versionCard(versions, title, url) {
  let site = url;
  try { site = new URL(url).hostname.replace(/^www\./, ''); } catch {}
  return h('div', { class: 'ach-versions', id: `ach-versions-${versionCards}`, hidden: true },
    h('p', {}, 'Achievements need this version of the game:'),
    h('ul', {}, versions.map((v) => h('li', {}, v))),
    ...(url ? [h('a', { class: 'ach-about', href: url, target: '_blank', rel: 'noopener noreferrer', title: `${title} on ${site}`, 'aria-label': `About the game: ${title} on ${site}, opens in a new window` },
      'About the game', icon(['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'], 12))] : []));
}

// A row on either screen: the top three in the C64 face, ranks in gold, silver and bronze; the rest
// in the regular face, a step quieter; the reader's own in reverse video.
const rankRow = (rank, isMe) => `${rank <= 3 ? `is-podium is-rank-${rank}` : 'is-rest'}${isMe ? ' is-me' : ''}`;
// No rank: the player's own best is being checked before it takes a place.
const rankCell = (rank) => h('span', { class: 'ach-rank' }, rank == null ? '' : ordinal(rank).toUpperCase());

/**
 * A leaderboard as the game's own high-score screen: the top rows, then the
 * reader's own row in reverse video when it is further down. While a game is
 * on, `live` is its running score, shown in a NOW row at the bottom.
 */
export function highScoreScreen(ctx, gameTitle, board, standings, live = null) {
  const me = ctx.me();
  const entries = standings?.entries ?? [];
  const row = (rank, user, value, isMe) => h('li', { class: `${rankRow(rank, isMe)}${rank == null ? ' is-checking' : ''}` },
    rankCell(rank),
    h('span', { class: 'ach-screen-name' }, user?.id != null ? h('button', { type: 'button', class: 'ach-screen-link', on: { click: () => ctx.go({ type: 'profile', id: user.id }) } }, user.name) : user?.name ?? '',
      rank == null && isMe ? h('span', { class: 'ach-checking' }, ' (check)') : null),
    h('span', {}, ctx.format(value, board.format)),
    isMe ? h('span', { class: 'sr-only' }, ' (you)') : null);
  const rows = entries.map((e) => row(e.rank, e.user ?? { name: e.name }, e.value, !!me && e.user?.id === me.id));
  const mineShown = me && entries.some((e) => e.user?.id === me.id);
  if (standings?.me && !mineShown) rows.push(h('li', { class: 'ach-screen-gap', 'aria-hidden': 'true' }, '...'), row(standings.me.checking ? null : standings.me.rank, me, standings.me.value, true));
  const players = standings?.players ?? entries.length;
  const now = live == null ? null : h('p', { class: 'ach-screen-live', 'data-board': String(board.id), 'aria-live': 'off' },
    h('span', {}, 'NOW'), h('span', {}, me?.name ?? 'YOU'), h('span', { class: 'ach-screen-live-value' }, ctx.format(live, board.format)));
  // The game's name is already above it: the screen names only the board.
  const heading = board.title;
  return h('section', { class: 'ach-screen', 'aria-label': `${gameTitle}: ${board.title}` },
    h('div', { class: 'ach-screen-head' }, h('span', {}, heading)),
    standings == null ? h('p', { class: 'ach-screen-foot' }, 'LOADING...')
      : entries.length ? h('ol', {}, rows) : h('p', { class: 'ach-screen-foot' }, 'NO SCORES YET'),
    now,
    standings && entries.length ? h('p', { class: 'ach-screen-foot' }, players === 1 ? '1 PLAYER' : `${players} PLAYERS`) : null);
}

/**
 * Trophy Hunters: a game's players by achievement points, as a second
 * high-score screen. A star marks a finished set; the reader's own row is lit,
 * and shown under the others when further down.
 */
export function hallOfFame(ctx, gameTitle, top) {
  const me = ctx.me();
  const row = (rank, user, unlocked, points, complete, isMe) => h('li', { class: rankRow(rank, isMe) },
    rankCell(rank),
    h('span', { class: 'ach-screen-name' }, user?.id != null ? h('button', { type: 'button', class: 'ach-screen-link', on: { click: () => ctx.go({ type: 'profile', id: user.id }) } }, user.name) : user?.name ?? '',
      complete ? h('span', { class: 'ach-fame-star', title: 'Every achievement', 'aria-label': ', every achievement' }, ' ★') : null),
    h('span', { class: 'ach-fame-bar', role: 'img', 'aria-label': `${unlocked} of ${top.total} achievements`, title: `${unlocked} of ${top.total} achievements` },
      h('span', { style: `width: ${top.total ? Math.round((100 * unlocked) / top.total) : 0}%` })),
    h('span', { class: 'ach-fame-num', 'aria-label': `${points} points` }, String(points)),
    isMe ? h('span', { class: 'sr-only' }, ' (you)') : null);
  const entries = top?.entries ?? [];
  const rows = entries.map((e) => row(e.rank, e.user, e.unlocked, e.points, e.complete, !!me && e.user.id === me.id));
  if (top?.me && me && !entries.some((e) => e.user.id === me.id)) rows.push(h('li', { class: 'ach-screen-gap', 'aria-hidden': 'true' }, '...'), row(top.me.rank, me, top.me.unlocked, top.me.points, top.me.complete, true));
  const foot = top ? `${top.players === 1 ? '1 PLAYER' : `${top.players} PLAYERS`}${top.complete ? `, ${top.complete} COMPLETE` : ''}` : '';
  return h('section', { class: 'ach-screen ach-fame', 'aria-label': `${gameTitle}: trophy hunters` },
    h('div', { class: 'ach-screen-head' }, h('span', {}, 'Trophy hunters')),
    top == null ? h('p', { class: 'ach-screen-foot' }, 'LOADING...')
      : entries.length ? h('ol', {}, rows) : h('p', { class: 'ach-screen-foot' }, 'NO ONE YET'),
    top && entries.length ? h('p', { class: 'ach-screen-foot' }, foot) : null);
}

/** Achievements with a badge: a trophy when unlocked, its number while locked. */
export function achievementList(achievements, isUnlocked, unlockedAt = () => null, checking = () => false) {
  return h('ul', { class: 'ach-list achievements-list' }, achievements.map((a, i) => {
    const got = isUnlocked(a);
    const at = got ? unlockedAt(a) : null;
    // The player's own unlock the server flagged: it counts in public once checked.
    const check = got && checking(a);
    return h('li', { class: `ach-item ${got ? 'is-unlocked' : 'is-locked'}` },
      h('span', { class: 'ach-badge', 'aria-hidden': 'true' }, got ? trophyIcon(15) : String(i + 1)),
      h('span', { class: 'ach-what' },
        h('strong', {}, a.title),
        h('span', { class: 'ach-desc' }, a.description),
        at ? h('span', { class: 'ach-when' }, `Unlocked ${ago(at)}`) : null,
        check ? h('span', { class: 'ach-checking' }, 'Being checked') : null,
        h('span', { class: 'sr-only' }, got ? ' Unlocked.' : ' Locked.')),
      h('span', { class: 'ach-pts' }, String(a.points)));
  }));
}

/** One activity row: an unlock or a new best. `withGame` names the game too. */
/** One unlock or new best, as the activity feeds and the chat show it. */
export function activityItem(ctx, x, withGame) {
  const inGame = withGame ? [' in ', gameLink(ctx, x.game, 'achievements-link ach-event-game')] : [];
  const what = x.kind === 'unlock'
    ? [playerLink(ctx, x.user), ' unlocked ', h('b', {}, x.achievement.title), ...inGame]
    // A game's one Hiscores goes unnamed: "scored 034600 in Commando". Others are named: "on Hiscores (Game A)", "on Fewest Moves".
    : [playerLink(ctx, x.user), ' scored ', h('b', {}, ctx.format(x.value, x.leaderboard.format)), x.leaderboard.title === 'Hiscores' ? '' : ` on ${x.leaderboard.title}`, ...inGame];
  return h('li', { class: `ach-event achievements-activity-item is-${x.kind}` },
    tile(ctx, x.user),
    h('span', { class: 'ach-event-text achievements-activity-text' }, ...what),
    x.kind === 'unlock' ? h('span', { class: 'ach-pts' }, `+${x.achievement.points}`) : h('span', {}),
    h('time', { class: 'ach-when-ago', datetime: new Date(x.at).toISOString() }, ago(x.at)));
}

/**
 * The activity feed into `el`: everyone's, or one game's with `hash`. MORE
 * pages back; once paged, a refresh would lose the place (`el._paged`).
 */
export async function renderActivity(el, ctx, { hash = null, withGame = !hash } = {}) {
  const gen = (el._gen = (el._gen || 0) + 1);
  try {
    const first = await ctx.api.activity({ hash });
    if (gen !== el._gen) return;
    const list = h('ol', { class: 'ach-feed achievements-activity', 'aria-label': 'Activity' });
    // The feed comes a page at a time; LOAD MORE brings the next, older one.
    const more = h('button', { type: 'button', class: 'btn achievements-more' }, 'LOAD MORE');
    let last = null;
    const add = (page) => {
      list.append(...page.items.map((x) => activityItem(ctx, x, withGame)));
      last = page.items.at(-1)?.id ?? last;
      more.hidden = !page.more;
    };
    more.addEventListener('click', async () => {
      more.disabled = true;
      more.textContent = 'Loading…';
      el._paged = true;
      try { add(await ctx.api.activity({ hash, before: last })); } catch (e) { more.replaceWith(failed(e)); }
      more.disabled = false;
      more.textContent = 'LOAD MORE';
    });
    add(first);
    el._paged = false;
    el.replaceChildren(...(first.items.length ? [list, more] : [note(hash ? 'Nothing has happened in this game yet. Play it, and what you unlock shows here.' : 'Nothing has happened yet. Load a game from GAMES and play.')]));
  } catch (e) {
    if (gen === el._gen) el.replaceChildren(failed(e));
  }
}

// Titles compared without case or accents: "Pac-Man" finds "pac man", "Éclair" finds "eclair".
const fold = (t) => String(t).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Every game with achievements, with a field that narrows the list by title. */
export async function renderGames(el, ctx) {
  const gen = (el._gen = (el._gen || 0) + 1);
  try {
    const { games: all } = await ctx.api.games();
    if (gen !== el._gen) return;
    const games = gameOrder(all, ctx.loaded?.() ?? null);
    if (!games.length) { el.replaceChildren(note('No games have achievements yet.')); return; }
    const list = h('ul', { class: 'ach-games achievements-games' });
    const count = h('p', { class: 'achievements-note ach-games-count', role: 'status', 'aria-live': 'polite' });
    const field = h('input', {
      type: 'search', class: 'prompt-input ach-games-filter', id: 'achievements-games-filter', placeholder: 'Filter games',
      'aria-label': 'Filter games by title', autocomplete: 'off', spellcheck: 'false', value: el._filter ?? '',
    });
    const show = (reveal = false) => {
      el._filter = field.value;
      if (!field.value && layered) { popEscapeLayer(layer); layered = false; }
      const words = fold(field.value).split(' ').filter(Boolean);
      const shown = games.filter((g) => { const t = fold(g.title); return words.every((w) => t.includes(w)); });
      const loaded = ctx.loaded?.() ?? null;
      list.replaceChildren(...shown.map((g) => h('li', {}, gameCard(ctx, g, (g.hashes ?? [g.hash]).includes(loaded)))));
      revealOnScroll(list, reveal);
      count.textContent = words.length ? (shown.length ? `${shown.length} of ${games.length} games.` : 'No games match.') : `${games.length} games. Load one and play: what you unlock is saved to your account.`;
    };
    // While it holds text, the filter is the top Esc layer: Esc clears it, and
    // the next Esc closes the window as usual.
    // A hidden or replaced field never claims it.
    const layer = { close: () => { field.value = ''; show(); }, isOpen: () => !!field.value && field.isConnected && field.offsetParent !== null };
    let layered = false;
    field.addEventListener('input', () => {
      show();
      if (field.value && !layered) { pushEscapeLayer(layer); layered = true; }
    });
    show(true);
    // The guide says how to ask for a game, or add one. A new tab keeps the game running here.
    const missing = h('a', { class: 'achievements-link ach-games-missing', href: '/docs/guide-achievements.html#missing-a-game', target: '_blank', rel: 'noopener' }, 'Missing a game?');
    el.replaceChildren(h('div', { class: 'ach-games-bar' }, field, missing), count, list);
    if (field.value) { pushEscapeLayer(layer); layered = true; }
    // Shown again as it was (the window keeps the list): text in the filter claims Esc again.
    el._shown = () => { if (field.value) { pushEscapeLayer(layer); layered = true; } };
  } catch (e) {
    if (gen === el._gen) el.replaceChildren(failed(e));
  }
}

/**
 * Rows draw in as they scroll into view, a few raster lines at a time, the
 * ones arriving together one after another. Filtering shows its rows at once.
 */
function revealOnScroll(list, reveal) {
  list._reveal?.disconnect();
  list._reveal = null;
  const motion = !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  list.classList.toggle('ach-reveal', reveal && motion && 'IntersectionObserver' in globalThis);
  if (!list.classList.contains('ach-reveal')) return;
  const io = new IntersectionObserver((entries) => {
    let n = 0;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.style.setProperty('--reveal-delay', `${Math.min(n++, 8) * 50}ms`);
      e.target.classList.add('is-in');
      io.unobserve(e.target);
    }
  });
  for (const li of list.children) io.observe(li);
  list._reveal = io;
}

/**
 * A game as a row in GAMES: its pixel icon (or initial), title and the reader's count, with a thin
 * meter under them, and for a game the reader has played, when they last did (where it fits beside
 * the title). The whole row opens the game's page, which has the rest.
 */
function gameCard(ctx, g, isLoaded) {
  const got = g.mine?.unlocked ?? 0;
  // A game the reader has played (an unlock or a score) has its count in amber.
  const played = got > 0 || !!g.mine?.last;
  const icon = gameIcon(g.id, 24);
  return h('button', { type: 'button', class: `ach-card ${playerHue(g.id)}${isLoaded ? ' is-loaded' : ''}`, on: { click: () => ctx.go({ type: 'game', hash: g.hash }) } },
    h('span', { class: `ach-tile${icon ? ' has-icon' : ''}`, 'aria-hidden': 'true' }, icon ?? g.title.replace(/^the\s+/i, '').slice(0, 1).toUpperCase()),
    h('span', { class: 'ach-card-name' }, h('span', { class: 'ach-games-title' }, g.title),
      isLoaded ? h('span', { class: 'ach-card-loaded' }, 'LOADED') : null,
      g.mine?.last ? h('em', { class: 'ach-card-when' }, `(last played ${agoShort(g.mine.last)})`) : null),
    g.achievements
      ? h('span', { class: `ach-card-count${played ? ' is-started' : ''}`, 'aria-label': `${got} of ${g.achievements} unlocked` }, `${got}/${g.achievements}`)
      : h('span', { class: `ach-card-count${played ? ' is-started' : ''}` }, 'scores'),
    g.achievements ? h('span', { class: 'ach-card-bar', 'aria-hidden': 'true' }, h('span', { style: `width: ${Math.round((100 * got) / g.achievements)}%` })) : null);
}

/**
 * The GAMES list's order: the loaded game first, then the games you have played (unlocked something
 * in, or posted a score to) by the share of their achievements you have unlocked, then the rest.
 * Ties go alphabetically.
 */
export function gameOrder(games, loadedHash = null) {
  const isLoaded = (g) => (g.hashes ?? [g.hash]).includes(loadedHash);
  const rank = (g) => (isLoaded(g) ? 2 : g.mine?.unlocked > 0 || g.mine?.last ? 1 : 0);
  const share = (g) => (rank(g) === 1 && g.achievements ? (g.mine?.unlocked ?? 0) / g.achievements : 0);
  return [...games].sort((a, b) => rank(b) - rank(a) || share(b) - share(a) || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

/** A game's page: its head, the versions the set is for, leaderboards, achievements and activity. */
export async function renderGamePage(el, ctx, hash) {
  const gen = (el._gen = (el._gen || 0) + 1);
  try {
    const g = await ctx.api.game(hash);
    const [boards, top] = await Promise.all([
      Promise.all(g.leaderboards.map((l) => ctx.api.leaderboard(hash, l.id, 5).catch(() => null))),
      g.achievements.length ? ctx.api.top(hash, 10).catch(() => ({ total: g.achievements.length, players: 0, complete: 0, entries: [] })) : null,
    ]);
    if (gen !== el._gen) return;
    const at = new Map((g.unlocks ?? g.unlocked.map((id) => ({ id, at: null }))).map((u) => [u.id, u.at]));
    const isUnlocked = (a) => at.has(a.id);
    const labels = (g.files ?? []).map((f) => f.label).filter(Boolean);
    const feed = h('div', { class: 'achievements-feed' }, note('Loading…'));
    el.replaceChildren(...[
      gameHead(ctx, g.game, g.achievements, isUnlocked, { versions: labels, url: g.game.url }),
      ...g.leaderboards.map((l, i) => highScoreScreen(ctx, g.game.title, l, boards[i] ?? { entries: [], players: 0 })),
      g.achievements.length ? hallOfFame(ctx, g.game.title, top) : null,
      ...(g.achievements.length ? [heading('Your achievements'), achievementList(g.achievements, isUnlocked, (a) => at.get(a.id))] : []),
      heading('Activity'), feed,
    ].filter(Boolean));
    renderActivity(feed, ctx, { hash, withGame: false });
  } catch (e) {
    if (gen === el._gen) el.replaceChildren(failed(e));
  }
}

/** A player's profile: who, since when and how many points, then each game with its meter and best scores. */
export async function renderProfile(el, ctx, id) {
  const gen = (el._gen = (el._gen || 0) + 1);
  try {
    const p = await ctx.api.profile(id);
    if (gen !== el._gen) return;
    const since = new Date(p.user.since).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
    const own = p.user.id === ctx.me()?.id && ctx.setPicture ? ownTile(el, ctx, p.user, () => renderProfile(el, ctx, id)) : null;
    el.replaceChildren(
      h('div', { class: 'ach-profile' },
        own ? own.tile : tile(ctx, p.user, 'ach-tile ach-tile-big'),
        h('div', {}, h('h3', { class: 'ach-profile-name' }, p.user.name),
          h('p', { class: 'ach-profile-since' }, `Playing since ${since}. `, h('span', { class: 'ach-pts' }, String(p.points)), ' points.'),
          own ? own.actions : null)),
      heading('Games'),
      ...(p.games.length ? p.games.map((g) => {
        const mine = new Set(g.achievements.map((a) => a.id));
        return h('div', { class: 'ach-played' },
          h('h4', { class: 'ach-played-title' }, gameLink(ctx, g)),
          ...(g.total ? [meter((g.ids ?? []).map((aid) => mine.has(aid))), progress(g.unlocked, g.total, g.points, g.totalPoints)] : []),
          ...g.scores.map((x) => h('div', { class: 'ach-best' }, h('span', {}, x.title), h('span', {}, `${ctx.format(x.value, x.format)}, ${ordinal(x.rank)}`))));
      }) : [note('No achievements yet.')]));
  } catch (e) {
    if (gen === el._gen) el.replaceChildren(failed(e));
  }
}
