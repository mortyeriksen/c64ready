// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/achievements/api.js — the games API (server/games.mjs), as the signed-in
// account (src/account/account.js) or anonymously when signed out.

/**
 * @param {object} o
 * @param {string} o.base  the API's address (apiBase())
 * @param {{ token: string|null }} o.account
 */
export function createGamesApi({ base, account, fetchImpl = (...a) => fetch(...a) }) {
  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (account.token) headers.Authorization = `Bearer ${account.token}`;
    const res = await fetchImpl(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
    return data;
  }
  const q = (params) => {
    const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
    return s ? `?${s}` : '';
  };
  return {
    request,
    game: (hash) => request('GET', `/games/${hash}`),
    games: () => request('GET', '/games'),
    /** The games with each file's label too: only a folder import needs them. */
    gamesWithLabels: () => request('GET', '/games?labels=1'),
    leaderboard: (hash, id, limit) => request('GET', `/games/${hash}/leaderboards/${id}${q({ limit })}`),
    /** A game's Trophy Hunters: its players by achievement points, and the account's own place. */
    top: (hash, limit) => request('GET', `/games/${hash}/top${q({ limit })}`),
    /** Everyone's activity, or one game's when `hash` is given; `before` pages back. */
    activity: ({ hash = null, before = null } = {}) => request('GET', `${hash ? `/games/${hash}` : ''}/activity${q({ before })}`),
    profile: (id) => request('GET', `/users/${id}`),
  };
}
