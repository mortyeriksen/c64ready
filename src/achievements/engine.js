// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/achievements/engine.js — achievements for whatever is loaded. When the
// media change (the `c64-media` event), each loaded file is hashed by rcheevos
// and compared, here, with the hashes of the games that have sets (fetched
// once, the same list for everyone): a file's hash leaves the browser only when
// it is one of those. The first match becomes the game, and
// its achievements (those not yet unlocked) and leaderboards are handed to
// rcheevos. After every emulated frame, `frame(ram)` lets rcheevos read the
// C64's RAM and acts on what it reports: an unlock is saved to the account, a
// finished leaderboard attempt posts its value.
//
// rcheevos and the server are only touched once something is loaded, and a
// frame costs nothing while no loaded game has a set.

import { loadRcheevos, EVENT } from './rcheevos.js';
import { loadedFiles } from '../media/now-loaded.js';
import { createGamesApi } from './api.js';

/**
 * @param {object} o
 * @param {{ token: string|null, user: object|null }} o.account  the signed-in account (src/account/account.js)
 * @param {string} o.base               the API's address (apiBase())
 * @param {(e: object) => void} [o.onChange]       the game, its achievements or unlocks changed
 * @param {(e: object) => void} [o.onUnlock]       { achievement, saved, signedIn, complete }: complete, { id, title, count, points }, when it was the set's last
 * @param {(e: object) => void} [o.onLeaderboard]  { type: 'started'|'updated'|'canceled'|'submitted', leaderboard, value, result? }
 * @param {(e: object) => void} [o.onSoftcore]     { reason, quiet }: play stopped counting in public, until the next reset
 * @param {(e: object) => void} [o.onNotice]       { title, text }: a set's notice became true, such as a trainer that keeps the game from counting
 * @param {() => void} [o.onGameOver]              the set's game over became true: a game ended
 * @param {(e: object) => void} [o.onChallenge]    { achievement, state: 'live'|'out' }: a challenge (trigger marked T:) can be earned, or no longer
 * @param {() => void} [o.onSessionLost]           the server no longer knows the session (401): the account should be checked again
 */
// A score's leading zeros as no-break spaces, by how many: made once.
const BLANKS = Array.from({ length: 16 }, (_, i) => '\u00a0'.repeat(i));

export function createAchievementEngine({ account, base, fetchImpl = (...a) => fetch(...a), loadRc = loadRcheevos, onChange = () => {}, onUnlock = () => {}, onLeaderboard = () => {}, onNotice = () => {}, onGameOver = () => {}, onChallenge = () => {}, onSoftcore = () => {}, onSessionLost = () => {}, log = (...a) => console.warn(...a) } = {}) {
  let rc = null, rcLoading = null;
  let game = null;               // { hash, id, title, files, achievements, leaderboards, notices, gameOver, notice, unlocked: Map id → when }
  // Why this machine's play no longer counts in public, or null while it is hardcore: a save
  // state was loaded, or a set's notice saw a trainer. Kept until the machine is reset, so a
  // state loaded before its game is found still counts against it.
  let softcore = null;
  // A notice runs in rcheevos as an achievement under an id of its own, far
  // above any set's: it is shown, never unlocked or saved, and armed again.
  const NOTICE_BASE = 1_000_000_000;
  // A set's game over runs the same way, under the one id no notice takes.
  const GAME_OVER_ID = NOTICE_BASE;
  let active = false;       // rcheevos holds this game's conditions
  // Challenges: id → { state: 'live'|'out', at }. Live while rcheevos has the achievement primed
  // (only its T: trigger is left), out when it is no longer and did not trigger.
  const challenges = new Map();
  let challenged = false;   // a challenge changed this frame: one onChange after its events
  const hashes = new WeakMap();   // file bytes → hash, so a medium is hashed once
  const lookups = new Map();      // hash → Promise<game JSON | null>
  let known = null;               // Promise<Set of hashes with a set>
  let knownAt = 0;                // when it was fetched: after KNOWN_MS a load fetches it again
  const KNOWN_MS = 10 * 60_000;
  let generation = 0;
  let enabled = true;       // off: nothing loaded is hashed or looked up, and no game is kept

  // The account's unlocks of a game, id → when (unlocked this session: now).
  const unlockMap = (data) => new Map((data.unlocks ?? data.unlocked.map((id) => ({ id, at: null }))).map((u) => [u.id, u.at]));
  // The account's unlocks the server flagged: they count once an admin has checked them.
  const checkingOf = (data) => new Set((data.unlocks ?? []).filter((u) => u.checking).map((u) => u.id));
  const getRc = () => rc ? Promise.resolve(rc) : (rcLoading ||= loadRc().then((r) => (rc = r)));

  const api = createGamesApi({ base, account, fetchImpl });
  const call = api.request;
  /**
   * The hashes that have achievement sets, or null when they cannot be fetched (tried again next time).
   * Kept for KNOWN_MS, so a game given a set meanwhile is found without a reload.
   */
  function knownHashes() {
    if (known && Date.now() - knownAt > KNOWN_MS) known = null;
    if (!known) knownAt = Date.now();
    known ??= api.games().then((r) => new Set(r.games.flatMap((g) => g.hashes ?? [g.hash])))
      .catch((e) => { log(`achievements: the list of games failed: ${e.message}`); known = null; return null; });
    return known;
  }
  /** A game's set and this account's unlocks: null when it has none (404), undefined when the server cannot be reached. */
  function lookup(hash) {
    if (!lookups.has(hash)) {
      lookups.set(hash, call('GET', `/games/${hash}`).catch((e) => {
        if (e.status === 404) return null;
        log(`achievements: lookup failed: ${e.message}`);
        lookups.delete(hash);
        return undefined;
      }));
    }
    return lookups.get(hash);
  }
  // A failed fetch is no answer: what is loaded is looked at again a little later.
  let retry = null;
  function retryLater() {
    if (retry) return;
    retry = setTimeout(() => { retry = null; mediaChanged().catch((e) => log(`achievements: ${e.message}`)); }, 30_000);
    retry.unref?.();   // in Node (tests), a pending retry does not hold the process open
  }

  // Unlocks and scores not saved yet (signed out, or the server out of reach):
  // [{ hash, kind, id, value?, uid }]. `uid` is the account that earned it, or
  // null when earned signed out. An account's own are posted when it is next
  // signed in here; those earned signed out go to whoever signs in next.
  const unsaved = [];
  let accountTurn = 0;   // counts changes of account, so an older one's answer is dropped
  function keepUnsaved(entry) {
    if (unsaved.length < 200) unsaved.push(entry);
  }
  const isMine = (e) => e.uid === null || e.uid === account.user?.id;
  async function postUnsaved() {
    const uid = account.user?.id;
    const mine = unsaved.filter(isMine);
    if (!mine.length) return;
    for (const e of mine) unsaved.splice(unsaved.indexOf(e), 1);
    const opened = new Set();
    for (let i = 0; i < mine.length; i++) {
      // The account changed while these were posted: the rest wait for their own account.
      if (account.user?.id !== uid) { mine.slice(i).forEach(keepUnsaved); return; }
      const e = mine[i];
      // The game opened as this account first, so the server has it in play; its answer is fetched again after.
      if (!opened.has(e.hash)) {
        opened.add(e.hash);
        await lookup(e.hash);
        lookups.delete(e.hash);
        if (account.user?.id !== uid) { mine.slice(i).forEach(keepUnsaved); return; }
      }
      try {
        // `held`: earned before, so it comes in a run, just after the game was opened.
        if (e.kind === 'unlock') await call('POST', `/games/${e.hash}/unlocks`, { achievementId: e.id, hardcore: e.hardcore === true, held: true });
        else await call('POST', `/games/${e.hash}/leaderboards/${e.id}/entries`, { value: e.value, hardcore: e.hardcore === true, held: true });
      } catch (err) {
        // Kept while the server is out of reach or the session is gone; any other refusal is final.
        if (retryable(err)) keepUnsaved(e);
        if (lost(err)) { mine.slice(i + 1).forEach(keepUnsaved); onSessionLost(); return; }
      }
    }
  }
  /** The account's unlocks of a game: the server's, and this page's still on their way. */
  function unlocksOf(data, hash) {
    const map = unlockMap(data);
    for (const e of unsaved) if (e.kind === 'unlock' && e.hash === hash && isMine(e) && !map.has(e.id)) map.set(e.id, e.at ?? null);
    return map;
  }
  // An answer that will not come for this session (401: signed out elsewhere,
  // deleted, or banned) keeps the result for the account and checks the session again.
  const lost = (e) => e.status === 401;
  const retryable = (e) => !e.status || e.status >= 500 || e.status === 429 || lost(e);

  /** Hands rcheevos the game's not-yet-unlocked achievements and its leaderboards. */
  function activate() {
    rc.clear();
    active = false;
    challenges.clear();
    if (!game) return;
    for (const a of game.achievements) {
      if (game.unlocked.has(a.id)) continue;
      const code = rc.activateAchievement(a.id, a.memaddr);
      if (code !== 0) log(`achievements: "${a.title}" does not parse (rcheevos ${code})`);
    }
    for (const n of game.notices) {
      const code = rc.activateAchievement(NOTICE_BASE + n.id, n.memaddr);
      if (code !== 0) log(`achievements: a notice does not parse (rcheevos ${code})`);
    }
    if (game.gameOver && rc.activateAchievement(GAME_OVER_ID, game.gameOver) !== 0) log('achievements: the game over does not parse');
    for (const l of game.leaderboards) {
      const code = rc.activateLeaderboard(l.id, l.definition);
      if (code !== 0) log(`achievements: leaderboard "${l.title}" does not parse (rcheevos ${code})`);
    }
    active = true;
  }

  /**
   * Finds the game among the loaded files (cartridge, drives, tape, RAM program):
   * the one being played. A cartridge with a set while it is in the port, as
   * the machine runs it; else the medium put in last. So a cartridge inserted
   * with a disk game in the drive takes over, and a disk put in under a
   * cartridge does not. Ejecting everything keeps the game: a program loaded
   * from tape or disk runs on without it. Another file of the same game (a
   * tape's second side, the next disk) keeps rcheevos's state, so a game in
   * progress carries on. A different file without a set ends the game.
   */
  // Whether a hash is one of the game's files (a tape's other side, a disk's).
  const isGameFile = (hash) => !!game && (hash === game.hash || !!game.files?.some((x) => x.hash === hash));
  // The loaded file that holds the game, if one does (hashes as computed by mediaChanged).
  const heldBy = () => loadedFiles().find((f) => isGameFile(hashes.get(f.bytes)));
  // How surely a file is the one being played: a cartridge first, then the last put in.
  const playRank = (f) => (f.slot === 'cart' ? 1e9 : 0) + f.loadedAt;

  async function mediaChanged() {
    const gen = ++generation;
    if (!enabled) return;
    const files = loadedFiles();
    if (files.length) {
      const r = await getRc();
      if (gen !== generation) return;
      for (const f of files) if (!hashes.has(f.bytes)) { const hash = r.hash(f.bytes); if (hash) hashes.set(f.bytes, hash); }
    }
    const held = heldBy();
    // Files more surely being played than the game's own, and not of it: another game, perhaps.
    const rivals = files.filter((f) => !isGameFile(hashes.get(f.bytes)) && (!held || playRank(f) > playRank(held))).sort((a, b) => playRank(b) - playRank(a));
    // Still the game, perhaps from another of its files.
    const keep = () => {
      if (held.slot !== game.slot || hashes.get(held.bytes) !== game.hash) { game.slot = held.slot; game.hash = hashes.get(held.bytes); onChange(snapshot()); }
    };
    if (held && !rivals.length) { keep(); return; }
    // A cartridge's game ends when it leaves the port: the machine resets with it.
    // A disk's or tape's game runs on from memory when it is ejected.
    if (!held && game?.slot === 'cart') setGame(null);
    if (!files.length) return;
    const sets = await knownHashes();
    if (gen !== generation) return;
    if (!sets) { if (held) keep(); retryLater(); return; }   // no answer: the game in hand stays
    for (const f of rivals) {
      const hash = hashes.get(f.bytes);
      if (!hash || !sets.has(hash)) continue;   // no set: the hash stays here
      // A game loaded anew gets its set as the server has it now (a corrected set
      // reaches the next load, not only the next page); while it stays in, the copy is kept.
      lookups.delete(hash);
      const data = await lookup(hash);
      if (gen !== generation) return;      // the media changed again meanwhile
      if (data === undefined) { retryLater(); return; }
      if (data) {
        setGame({ hash, slot: f.slot, id: data.game.id, title: data.game.title, files: data.files ?? [], achievements: data.achievements, leaderboards: data.leaderboards, notices: data.notices ?? [], gameOver: data.gameOver ?? null, notice: null, unlocked: unlocksOf(data, hash), checking: checkingOf(data) });
        return;
      }
    }
    // None of them has a set: the game in hand stays while its file is in, else it ends.
    if (gen !== generation) return;
    if (held) keep(); else setGame(null);
  }
  function setGame(g) {
    game = g;
    if (rc) activate();
    onChange(snapshot());
  }

  async function unlocked(id) {
    const a = game.achievements.find((x) => x.id === id);
    if (!a) return;
    const at = Date.now();
    game.unlocked.set(id, at);
    rc.deactivateAchievement(id);
    let saved = false, signedIn = !!account.user, checking = false;
    const hash = game.hash, uid = account.user?.id ?? null, hardcore = !softcore;
    lookups.delete(hash);   // the cached answer predates this unlock
    if (account.user) {
      try {
        const res = await call('POST', `/games/${hash}/unlocks`, { achievementId: id, hardcore });
        saved = true;
        if (res?.flagged) { checking = true; game?.checking?.add(id); }
        if (unsaved.length) postUnsaved();
      }
      catch (e) {
        log(`achievements: unlock not saved: ${e.message}`);
        if (retryable(e)) keepUnsaved({ hash, kind: 'unlock', id, at, uid, hardcore });
        if (lost(e)) { signedIn = false; onSessionLost(); }
      }
    } else keepUnsaved({ hash, kind: 'unlock', id, at, uid, hardcore });
    // The last of the set: the whole game is done.
    const complete = game.achievements.every((x) => game.unlocked.has(x.id))
      ? { id: game.id, title: game.title, count: game.achievements.length, points: game.achievements.reduce((n, x) => n + (x.points ?? 0), 0) }
      : null;
    onUnlock({ achievement: a, saved, signedIn, complete, softcore, checking });
    onChange(snapshot());
  }
  async function submitted(id, value) {
    const l = game.leaderboards.find((x) => x.id === id);
    if (!l) return;
    let result = null, signedIn = !!account.user;
    const hash = game.hash, uid = account.user?.id ?? null;
    // A softcore score goes on no board: it is not posted at all.
    if (softcore) { onLeaderboard({ type: 'submitted', leaderboard: l, value, result: null, signedIn, softcore }); return; }
    if (account.user) {
      try { result = await call('POST', `/games/${hash}/leaderboards/${id}/entries`, { value, hardcore: true }); }
      catch (e) {
        log(`achievements: score not saved: ${e.message}`);
        if (retryable(e)) keepUnsaved({ hash, kind: 'score', id, value, uid, hardcore: true });
        if (lost(e)) { signedIn = false; onSessionLost(); }
      }
    } else keepUnsaved({ hash, kind: 'score', id, value, uid, hardcore: true });
    onLeaderboard({ type: 'submitted', leaderboard: l, value, result, signedIn });
  }

  /** A notice came true: shown until the next reset, and armed again for the next time. */
  function noticed(id) {
    const n = game.notices.find((x) => x.id === id);
    if (!n) return;
    rc.deactivateAchievement(NOTICE_BASE + id);
    rc.activateAchievement(NOTICE_BASE + id, n.memaddr);
    const shown = n.title ? `${n.title}: ${n.text}` : n.text;
    if (game.notice === shown) return;
    game.notice = shown;
    onNotice({ title: n.title ?? '', text: n.text });
    taint(n.title || n.text, true);
    onChange(snapshot());
  }

  /** Whether this frame's `events` unlock `id`: a loop, so the frame allocates no closure. */
  function triggeredIn(events, id) {
    for (let i = 0; i < events.length; i++) if (events[i].type === EVENT.ACHIEVEMENT_TRIGGERED && events[i].id === id) return true;
    return false;
  }

  /** A challenge can be earned again, or no longer. */
  function challenge(id, state) {
    const a = game.achievements.find((x) => x.id === id);
    if (!a || (state === 'out' && challenges.get(id)?.state !== 'live')) return;
    challenges.set(id, { state, at: Date.now() });
    onChallenge({ achievement: a, state });
    challenged = true;
  }

  /** The game ended: told, and armed again for the next game. */
  function gameOver() {
    rc.deactivateAchievement(GAME_OVER_ID);
    rc.activateAchievement(GAME_OVER_ID, game.gameOver);
    onGameOver();
  }

  /** Play stops counting in public until the next reset, saying why; `quiet` when a notice already said so. */
  function taint(reason, quiet = false) {
    if (softcore) return;
    softcore = reason;
    onSoftcore({ reason, quiet });
    if (game) onChange(snapshot());
  }

  function snapshot() {
    return game ? {
      id: game.id, title: game.title, hash: game.hash,
      files: game.files,
      achievements: game.achievements.map((a) => ({ id: a.id, title: a.title, description: a.description, points: a.points, unlocked: game.unlocked.has(a.id), unlockedAt: game.unlocked.get(a.id) ?? null, checking: game.checking?.has(a.id) ?? false, challenge: challenges.get(a.id)?.state ?? null, challengeAt: challenges.get(a.id)?.at ?? null })),
      leaderboards: game.leaderboards.map((l) => ({ id: l.id, title: l.title, description: l.description, format: l.format, lowerIsBetter: l.lowerIsBetter })),
      notice: game.notice,
      softcore,
      notices: game.notices.map((n) => ({ title: n.title ?? '', text: n.text })),
      gameOver: !!game.gameOver,
    } : null;
  }

  globalThis.addEventListener?.('c64-media', () => { if (enabled) mediaChanged().catch((e) => log(`achievements: ${e.message}`)); });

  return {
    get game() { return snapshot(); },
    /** Whether achievements are on (Options ▸ Other). */
    get enabled() { return enabled; },
    /** Turns achievements off (the game, if any, is let go) or on (what is loaded is looked at again). */
    setEnabled(on) {
      enabled = !!on;
      if (enabled) { onChange(snapshot()); mediaChanged().catch((e) => log(`achievements: ${e.message}`)); return; }
      generation++;
      if (game) setGame(null); else onChange(snapshot());
    },
    mediaChanged,
    /** After each emulated frame: rcheevos reads `ram` (the C64's 64 KB). */
    frame(ram) {
      if (!active) return;
      const events = rc.doFrame(ram);
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.type === EVENT.ACHIEVEMENT_TRIGGERED && e.id === GAME_OVER_ID) gameOver();
        else if (e.type === EVENT.ACHIEVEMENT_TRIGGERED && e.id >= NOTICE_BASE) noticed(e.id - NOTICE_BASE);
        else if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) { challenges.delete(e.id); unlocked(e.id); }
        else if (e.type === EVENT.ACHIEVEMENT_PRIMED && e.id < NOTICE_BASE) challenge(e.id, 'live');
        // An unlock unprimes it in the same frame, just before it triggers.
        else if (e.type === EVENT.ACHIEVEMENT_UNPRIMED && e.id < NOTICE_BASE && !triggeredIn(events, e.id)) challenge(e.id, 'out');
        else if (e.type === EVENT.LBOARD_TRIGGERED) submitted(e.id, e.value);
        else if (e.type === EVENT.LBOARD_STARTED || e.type === EVENT.LBOARD_UPDATED || e.type === EVENT.LBOARD_CANCELED) {
          const l = game.leaderboards.find((x) => x.id === e.id);
          if (l) onLeaderboard({ type: e.type === EVENT.LBOARD_STARTED ? 'started' : e.type === EVENT.LBOARD_CANCELED ? 'canceled' : 'updated', leaderboard: l, value: e.value });
        }
      }
      // Challenges changed together, as a game start arms several, draw once.
      if (challenged) { challenged = false; onChange(snapshot()); }
    },
    /**
     * A reset machine: every achievement waits for its conditions to be false
     * again, and a notice is cleared. With none of the game's files still
     * loaded, nothing of it is left to play, and the game ends.
     */
    reset() {
      // A reset machine plays clean again.
      softcore = null;
      if (!active) return;
      if (game && !heldBy()) { setGame(null); return; }
      rc.reset();
      const changed = challenges.size > 0 || !!game?.notice;
      challenges.clear();
      if (game) game.notice = null;
      if (changed) onChange(snapshot());
    },
    /** The account changed: its unlocks are fetched again, and the set re-armed. */
    async accountChanged() {
      const turn = ++accountTurn;
      // Every cached answer holds the previous account's unlocks.
      lookups.clear();
      if (account.user && unsaved.length) await postUnsaved();
      const g = game;
      if (!g) return;
      const data = await lookup(g.hash);
      // Only for the game it was fetched for, and only the latest change of
      // account: a different game, or a later sign-in or -out, may have come meanwhile.
      if (!data || game !== g || turn !== accountTurn) return;
      // This account's unlocks, with what it unlocked here that is still on its way.
      g.unlocked = unlocksOf(data, g.hash);
      g.checking = checkingOf(data);
      activate();
      onChange(snapshot());
    },
    /**
     * Asks the server again which of the game's unlocks are still being checked, as after an admin
     * approved them. Only that changes: the set stays armed as it is, so a game in progress carries on.
     */
    async refreshChecks() {
      const g = game;
      if (!g || !account.user) return;
      lookups.delete(g.hash);
      const data = await lookup(g.hash);
      if (!data || game !== g) return;
      const next = checkingOf(data);
      if ([...next].join() === [...(g.checking ?? [])].join()) return;
      g.checking = next;
      onChange(snapshot());
    },
    /** Something that should not count in public happened, such as a save state loaded: until the next reset. */
    taint,
    /** Why play does not count in public now, or null. */
    get softcore() { return softcore; },
    /** The games API, as the same account. */
    api,
    /** A leaderboard's top entries (`limit`, default 10) and the account's own. */
    leaderboard(id, limit) { return game ? api.leaderboard(game.hash, id, limit) : Promise.resolve(null); },
    /** Loads rcheevos, so values can be formatted before any game is found. */
    load: () => getRc().then(() => {}),
    /** A file's hash, as a loaded file is hashed to find its game, or null. */
    hash: (bytes) => getRc().then((r) => r.hash(bytes)),
    /** A value in its leaderboard's format, as rcheevos writes it. */
    /**
     * A value as shown. A score's leading zeros (rcheevos pads it to six digits) become no-break
     * spaces, as wide as a digit in the fonts it is shown in, so columns of scores stay lined up.
     * In a sentence, trim it.
     */
    format(value, format) {
      const text = rc ? rc.formatValue(value, format) : String(value);
      if (format !== 'SCORE') return text;
      // A running score comes every frame: the zeros are counted, the blanks made once.
      let z = 0;
      while (z < text.length - 1 && text.charCodeAt(z) === 48 && text.charCodeAt(z + 1) >= 48 && text.charCodeAt(z + 1) <= 57) z++;
      return z ? BLANKS[z] + text.slice(z) : text;
    },
  };
}
