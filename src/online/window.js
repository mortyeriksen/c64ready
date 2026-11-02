// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/online/window.js — the Achievements window behind the header's ACHIEVEMENTS button
// (and the fullscreen toolbar's trophy), a floating window
// (src/ui/floating-window.js) that stays open beside the game. Five tabs:
// GAME, the loaded game's achievements and leaderboards
// (src/achievements/engine.js); ACTIVITY, what everyone (or this game's
// players) recently earned; CHAT (src/chat/window.js, loaded the first time
// it shows); GAMES, every game with achievements; and ACCOUNT, passkey
// sign-in, sign-up, sign-out and deletion. Names and games open a profile or a
// game page over the tab, with a way back (src/achievements/browse.js).

import { createAccount, passkeysSupported } from '../account/account.js';
import { CHAT_SERVER, chatServerUrl } from '../chat/connection.js';
import { pushEscapeLayer, popEscapeLayer } from '../ui/escape-stack.js';
import { confirmDialog } from '../ui/dialogs.js';
import { floatingWindow, resizeHandles, fillsScreen } from '../ui/floating-window.js';
import { LIMITS } from '../../server/protocol.mjs';
import { h, renderActivity, renderGames, renderGamePage, renderProfile, gameHead, highScoreScreen, achievementList, playerChip, hallOfFame } from '../achievements/browse.js';

const TABS = ['game', 'activity', 'chat', 'games', 'account'];
const POLL_MS = 30_000;
const CHAT_RESUME_KEY = 'c64emu.chat.resume';

/** A browser's passkey refusal, said plainly. */
function passkeyMessage(e) {
  if (e?.name === 'NotAllowedError') return 'The passkey request was cancelled or timed out.';
  if (e?.name === 'InvalidStateError') return 'This device already holds a passkey for that account.';
  if (e?.name === 'SecurityError') return 'Passkeys need a secure page (https or localhost).';
  return e?.message || 'Something went wrong. Try again.';
}

/**
 * @param {object} o
 * @param {HTMLElement[]} o.buttons  open and close the window: ACHIEVEMENTS in the header, and the
 *   fullscreen toolbar's trophy. A button with `data-tab` opens it on that tab.
 * @param {{ toggle: (which: 'all'|'game') => Promise<void>, state: () => string|null, hasGame: () => boolean }} [o.testToasts]
 *   on a dev server, TEST TOAST and TEST GAME after its name: each turns a cycle of sample toasts on and off,
 *   every kind or the loaded game's own, one at a time
 */
export function initOnline({ buttons, win, closeBtn, account = createAccount(), engine = null, testToasts = null }) {
  buttons = buttons.filter(Boolean);
  if (!buttons.length || !win) return null;
  // Talking to anything but the production server (the dev server's own, or an override) says so in the
  // title, unless c64emu.hideDevServer is set (the guide's screenshots, taken against a dev server).
  let hideDev = false;
  try { hideDev = localStorage.getItem('c64emu.hideDevServer') === '1'; } catch { /* storage blocked */ }
  if (chatServerUrl() !== CHAT_SERVER && !hideDev) {
    const title = win.querySelector('.online-title');
    title?.append(h('span', { class: 'online-dev' }, ' (dev server)'));
    if (testToasts) {
      const all = h('button', { type: 'button', class: 'btn online-dev-test', 'aria-pressed': 'false', title: 'Cycle through every kind of toast in turn, on and off' }, 'TEST TOAST');
      const game = h('button', { type: 'button', class: 'btn online-dev-test', 'aria-pressed': 'false', title: "Cycle through the loaded game's own toasts: each achievement, its scores and notices, on and off" }, 'TEST GAME');
      const show = () => {
        const on = testToasts.state();
        for (const [b, which, label] of [[all, 'all', 'TEST TOAST'], [game, 'game', 'TEST GAME']]) {
          b.setAttribute('aria-pressed', String(on === which));
          b.textContent = on === which ? `${label}: ON` : label;
        }
      };
      all.addEventListener('click', async () => { await testToasts.toggle('all'); show(); });
      game.addEventListener('click', async () => {
        if (!testToasts.hasGame() && testToasts.state() !== 'game') { game.textContent = 'NO GAME LOADED'; setTimeout(show, 1500); return; }
        game.textContent = 'TEST GAME…';
        await testToasts.toggle('game'); show();
      });
      title?.after(all, game);
    }
  }
  const gameEl = win.querySelector('#achievements-game');
  const accountEl = win.querySelector('#achievements-account');
  const chatEl = win.querySelector('#online-chat');
  const scrollBody = win.querySelector('.online-body');
  const panels = {
    game: gameEl, account: accountEl, chat: chatEl,
    activity: win.querySelector('#achievements-activity'),
    games: win.querySelector('#achievements-games'),
  };
  const detailEl = win.querySelector('#achievements-detail');
  const tabButtons = new Map([...win.querySelectorAll('[role=tab][data-tab]')].map((b) => [b.dataset.tab, b]));
  let checked = false, busy = false, error = '';
  let standings = new Map();   // leaderboard id → { entries, me } for the loaded game
  let standingsFor = null;     // the game being fetched
  let standingsOf = null;      // the game `standings` holds
  let top = null;              // the loaded game's Hall of Fame
  let topUnlocked = -1;        // how many achievements were unlocked when it was fetched
  let loadingStandings = false;
  const live = new Map();      // leaderboard id → the running score while a game is on
  let tab = null;              // the tab chosen in this session; until then, by what is loaded
  let detail = [];             // profiles and game pages opened over the tab, newest last
  let activityScope = 'all';   // 'all' or 'game'
  let poll = null;
  let opener = buttons[0];

  // ── CHAT ────────────────────────────────────────────────────────────────
  // Loaded the first time the tab shows, so the app neither carries the chat
  // nor contacts its server until then. A tab that was in a room before a
  // reload reconnects by itself and keeps counting unread messages.
  let chat = null, chatLoading = null;
  function ensureChat() {
    if (chat) return Promise.resolve(chat);
    chatLoading ??= import('../chat/window.js').then(({ createChatPane }) => {
      chat = createChatPane({
        container: chatEl, onUnread: setUnread, isFull: () => win.classList.contains('is-full'),
        account, onSignIn: () => selectTab('account'),
        // Players look and click as in the activity feed.
        player: (user) => playerChip(ctx, user),
        // A message mentions games with achievements, and a mention opens the
        // game's page under GAMES.
        games: listGames,
        loadedGame: () => engine?.game?.id ?? null,
        onGame: async (id) => {
          const g = (await listGames()).find((x) => x.id === id);
          if (!g) return;
          tab = 'games';
          detail = [{ type: 'game', hash: g.hash }];
          showView();
        },
      });
      return chat;
    });
    return chatLoading;
  }
  // The games with achievements, fetched once while the window lives; a failed fetch is tried again next time.
  let gameList = null;
  function listGames() {
    gameList ??= (ctx.api ? ctx.api.games().then((r) => r.games) : Promise.resolve([])).catch((e) => { gameList = null; throw e; });
    return gameList;
  }
  function setUnread(n) {
    const tabBadge = tabButtons.get('chat')?.querySelector('.online-tab-badge');
    if (tabBadge) { tabBadge.textContent = n > 99 ? '99+' : String(n); tabBadge.hidden = !n; }
    for (const b of buttons) {
      const badge = b.querySelector('.chat-badge');
      if (badge) { badge.textContent = n > 99 ? '99+' : String(n); badge.hidden = !n; }
      const name = b.dataset.tab === 'chat' ? 'Chat' : 'Achievements';
      b.setAttribute('aria-label', n ? `${name}, ${n} unread chat message${n === 1 ? '' : 's'}` : name);
    }
  }
  let resume = false;
  try { resume = sessionStorage.getItem(CHAT_RESUME_KEY) === '1'; } catch { /* storage blocked */ }
  if (resume) ensureChat().then((c) => c.resume());

  const ctx = {
    api: engine?.api,
    format: (v, f) => engine?.format(v, f) ?? String(v),
    go: (view) => { detail.push(view); showView(); },
    me: () => account.user,
    pictureUrl: (u) => account.pictureUrl?.(u) ?? null,
    setPicture: (file) => account.setPicture(file),
    removePicture: () => account.removePicture(),
    loaded: () => engine?.game?.hash ?? null,
  };

  const handles = resizeHandles();
  win.append(...handles);
  const frame = floatingWindow({
    win, head: win.querySelector('.float-head'), handles, rectKey: 'c64emu.online.rect', minH: 340, dockKey: 'c64emu.online.dock',
    // Fullscreen splits the screen: the picture beside the window, never under it.
    dockWhen: () => document.body.classList.contains('fullscreen-mode'),
    // On a desktop it opens docked on the right until it is floated once.
    dockedFirst: true,
    initial: () => ({ w: 400, h: Math.min(600, window.innerHeight - 96), x: window.innerWidth - 424, y: 80 }),
    onBack: () => close(true),
  });
  // Docking on the right, on a desktop: the button says which way it goes.
  const dockBtn = win.querySelector('#btn-online-dock');
  function syncDock() {
    if (!dockBtn) return;
    dockBtn.hidden = !frame.canDock();
    const docked = frame.isDocked();
    dockBtn.setAttribute('aria-pressed', String(docked));
    const label = docked ? 'Float the window' : 'Dock to the right';
    dockBtn.setAttribute('aria-label', label);
    dockBtn.title = label;
  }
  dockBtn?.addEventListener('click', () => { frame.setDocked(!frame.isDocked()); syncDock(); });
  globalThis.matchMedia?.('(max-width: 680px), (pointer: coarse) and (max-height: 520px)').addEventListener?.('change', () => { if (!win.hidden) syncDock(); });
  let fullscreen = document.body.classList.contains('fullscreen-mode');
  new MutationObserver(() => {
    const now = document.body.classList.contains('fullscreen-mode');
    if (now === fullscreen) return;
    fullscreen = now;
    frame.relayout();
    if (!win.hidden) syncDock();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  const escape = {
    close: () => { if (detail.length) back(); else close(); },
    isOpen: () => !win.hidden,
  };

  // Until a tab is picked: the loaded game, else the chat room, else the
  // account to sign in to, else the activity.
  const currentTab = () => tab ?? (engine?.game ? 'game' : chat?.inRoom() ? 'chat' : account.user ? 'activity' : 'account');

  function open(withTab = null) {
    if (withTab) { tab = withTab; detail = []; }
    // The tab it opens on stays put while it is open, so signing in does not move away.
    tab ??= currentTab();
    if (!win.hidden) { showView(); return; }
    frame.show();
    syncDock();
    for (const b of buttons) b.setAttribute('aria-expanded', 'true');
    pushEscapeLayer(escape);
    render();
    showView();
    if (!checked) { checked = true; account.restore().finally(render); }
    // Values are formatted by rcheevos: load it before the first standings show.
    engine?.load?.().then(() => { if (!win.hidden && !['account', 'chat'].includes(currentTab())) showView(); }).catch(() => {});
  }
  function close(fromHistory = false) {
    if (win.hidden) return;
    frame.hide(fromHistory);
    popEscapeLayer(escape);
    stopPoll();
    chat?.hidden();
    for (const b of buttons) b.setAttribute('aria-expanded', 'false');
    // Back to the machine, as after any window over the screen.
    const screen = document.getElementById('screen');
    if (screen && !opener?.isConnected) screen.focus();
    else (opener?.offsetParent ? opener : screen)?.focus();
  }
  function back() {
    detail.pop();
    showView();
  }
  // The tab button takes focus only when the keyboard moved to it (the arrow
  // keys): a click leaves the keyboard with the C64, as elsewhere in the app.
  function selectTab(name, focus = false) {
    tab = name;
    detail = [];
    showView();
    if (focus) tabButtons.get(name)?.focus();
  }

  /** Shows the chosen tab, or the newest profile or game page over it, and loads what it needs. */
  function showView() {
    const t = currentTab();
    const top = detail.at(-1);
    for (const [name, b] of tabButtons) {
      const on = name === t;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('is-active', on);
    }
    for (const [name, el] of Object.entries(panels)) if (el) el.hidden = !!top || name !== t;
    detailEl.hidden = !top;
    scrollBody.hidden = !top && t === 'chat';
    stopPoll();
    if (t !== 'chat' || top) chat?.hidden();
    if (top) {
      const body = h('div', {}, h('p', { class: 'achievements-note' }, 'Loading…'));
      // Back names where it goes: the tab, or Back to an earlier page.
      const to = detail.length > 1 ? 'Back' : { game: 'Game', activity: 'Activity', games: 'Games', chat: 'Chat', account: 'Account' }[t];
      detailEl.replaceChildren(h('button', { type: 'button', class: 'achievements-link achievements-back', on: { click: back } }, `‹ ${to}`), body);
      if (top.type === 'profile') renderProfile(body, ctx, top.id);
      else renderGamePage(body, ctx, top.hash);
      return;
    }
    if (t === 'game') { renderGame(); loadStandings(); }
    else if (t === 'activity') { renderActivityTab(); startPoll(); }
    else if (t === 'games') { panels.games.replaceChildren(h('p', { class: 'achievements-note' }, 'Loading…')); if (ctx.api) renderGames(panels.games, ctx); }
    else if (t === 'chat') ensureChat().then((c) => { if (!win.hidden && currentTab() === 'chat' && !detail.length) c.shown(); });
    else render();
  }

  // ── ACTIVITY ────────────────────────────────────────────────────────────
  const feedEl = h('div', { class: 'achievements-feed' });
  function activityQuery() {
    return activityScope === 'game' && engine?.game ? { hash: engine.game.hash, withGame: false } : {};
  }
  function renderActivityTab() {
    const game = engine?.game;
    if (!game) activityScope = 'all';
    const scope = (name, label) => h('button', {
      type: 'button', class: `btn achievements-scope${activityScope === name ? ' is-active' : ''}`, 'aria-pressed': String(activityScope === name),
      on: { click: () => { activityScope = name; renderActivityTab(); } },
    }, label);
    panels.activity.replaceChildren(
      ...(game ? [h('div', { class: 'confirm-actions achievements-scopes' }, scope('all', 'EVERYONE'), scope('game', game.title.toUpperCase()))] : []),
      feedEl);
    if (!feedEl.childElementCount) feedEl.append(h('p', { class: 'achievements-note' }, 'Loading…'));
    if (ctx.api) renderActivity(feedEl, ctx, activityQuery());
  }
  function startPoll() {
    poll = setInterval(() => {
      if (win.hidden || currentTab() !== 'activity' || detail.length || feedEl._paged || document.hidden) return;
      renderActivity(feedEl, ctx, activityQuery());
    }, POLL_MS);
  }
  function stopPoll() { clearInterval(poll); poll = null; }

  // ── GAME ────────────────────────────────────────────────────────────────
  async function loadStandings() {
    const game = engine?.game;
    if (!game) return;
    standingsFor = game.hash;
    loadingStandings = true;
    const next = new Map();
    const unlockedNow = game.achievements.filter((a) => a.unlocked).length;
    let nextTop = null;
    await Promise.all([
      ...game.leaderboards.map(async (l) => {
        try { next.set(l.id, await engine.leaderboard(l.id, 5)); } catch { next.set(l.id, { entries: [], players: 0 }); }
      }),
      game.achievements.length ? engine.api.top(game.hash, 10).then((t) => { nextTop = t; }, () => { nextTop = { total: game.achievements.length, players: 0, complete: 0, entries: [] }; }) : null,
    ]);
    loadingStandings = false;
    if (standingsFor === game.hash) { standings = next; standingsOf = game.hash; top = nextTop; topUnlocked = unlockedNow; renderGame(); }
  }

  function renderGame() {
    if (!gameEl) return;
    const game = engine?.game;
    if (engine && !engine.enabled) {
      gameEl.replaceChildren(h('h3', { class: 'ach-game-title' }, 'Achievements are off'),
        h('p', { class: 'achievements-note' }, 'Turn them on in Options ▸ Other ▸ ACHIEVEMENTS to play for achievements and high scores.'));
      return;
    }
    if (!game) {
      gameEl.replaceChildren(h('h3', { class: 'ach-game-title' }, 'No game loaded'),
        h('p', { class: 'achievements-note' }, 'No game with achievements is loaded. Pick one from GAMES, load it and play.'),
        h('div', { class: 'confirm-actions achievements-scopes' }, h('button', { type: 'button', class: 'btn', on: { click: () => selectTab('games') } }, 'SEE THE GAMES')));
      return;
    }
    const unlocked = (a) => a.unlocked;
    // A new unlock moves the player in the Hall of Fame: fetch it again.
    if (standingsOf === game.hash && !loadingStandings && game.achievements.filter(unlocked).length !== topUnlocked) loadStandings();
    gameEl.replaceChildren(...[
      gameHead(ctx, game, game.achievements, unlocked, { refresh: () => Promise.all([loadStandings(), engine.refreshChecks().catch(() => {})]) }),
      game.notice ? h('p', { class: 'ach-notice', role: 'status' }, game.notice)
        // Softcore play: what it unlocks stays the player's own, until a reset.
        : game.softcore ? h('p', { class: 'ach-notice', role: 'status' }, `Softcore: ${game.softcore}. Nothing counts in public until a reset.`) : null,
      account.user ? null : h('p', { class: 'achievements-note ach-signin-note' }, 'Signed out: sign in to keep what you unlock. ',
        h('button', { type: 'button', class: 'achievements-link', on: { click: () => selectTab('account') } }, 'Sign in')),
      ...game.leaderboards.map((l) => highScoreScreen(ctx, game.title, l, standingsOf === game.hash ? standings.get(l.id) : null, live.get(l.id) ?? null)),
      game.achievements.length ? hallOfFame(ctx, game.title, standingsOf === game.hash ? top : null) : null,
      ...(game.achievements.length ? [h('h4', { class: 'ach-h' }, 'Your achievements'), achievementList(game.achievements, unlocked, (a) => a.unlockedAt, (a) => a.checking)] : []),
    ].filter(Boolean));
  }

  // ── ACCOUNT ─────────────────────────────────────────────────────────────
  // `back` is the field to return to when the task fails. A new recovery code
  // takes the focus to COPY, so it is not missed.
  async function run(task, back = null, at = null) {
    if (busy) return;
    busy = true; error = ''; errorAt = at; render();
    try { await task(); } catch (e) { error = passkeyMessage(e); }
    busy = false; render();
    // A failed step puts the cursor back in its field; a new recovery code is
    // announced by its status region, and the keyboard stays where it was.
    if (error && back && !acct.code) accountEl.querySelector(back)?.focus();
  }

  // What the ACCOUNT tab holds between draws: a recovery code to show once,
  // the name typed for a new account, the recovery form (and what was typed in
  // it), and the account's passkeys.
  let errorAt = null;   // which action the error belongs to, so it shows next to it
  const acct = { code: '', newName: '', newPicture: null, newPictureUrl: null, recovering: false, recoverName: '', recoverCode: '', passkeys: null, passkeysFor: null };
  const shown = (r) => { acct.code = r.recoveryCode || ''; acct.recovering = false; acct.recoverCode = ''; };
  function loadPasskeys() {
    const id = account.user?.id;
    if (!id || acct.passkeysFor === id) return;
    acct.passkeysFor = id;
    account.passkeys().then((list) => { if (account.user?.id === id) { acct.passkeys = list; render(); } }).catch(() => {});
  }
  const when = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  /** A recovery code, shown once: the way back in when every passkey is lost. */
  function codePanel() {
    const copy = h('button', { class: 'btn', type: 'button', id: 'achievements-recovery-copy', on: { click: async () => {
      try { await navigator.clipboard.writeText(acct.code); copy.textContent = 'COPIED'; } catch { copy.textContent = 'SELECT AND COPY IT'; }
    } } }, 'COPY');
    // A status region, so a screen reader announces the code's one showing.
    return h('section', { class: 'ach-recovery-panel', role: 'status', 'aria-label': 'Your recovery code' },
      h('h4', { class: 'ach-h' }, 'Your recovery code'),
      h('p', { class: 'ach-recovery-code', id: 'achievements-recovery-code' }, acct.code),
      h('p', { class: 'achievements-note' }, 'Save it in your password manager or write it down. If you lose your passkey, your username and this code get you back in on a new device. It is shown only now.'),
      h('div', { class: 'confirm-actions achievements-scopes' }, copy,
        h('button', { class: 'btn', type: 'button', on: { click: () => { acct.code = ''; render(); } } }, 'I HAVE SAVED IT')));
  }

  function render() {
    const supported = passkeysSupported();
    const user = account.user;
    const err = error ? h('p', { class: 'achievements-error', role: 'alert' }, error) : null;
    let body;
    if (user && acct.code) {
      body = [h('p', { class: 'achievements-signed-in' }, 'Signed in as ', h('strong', {}, user.name)), codePanel()];
    } else if (user) {
      loadPasskeys();
      const list = acct.passkeysFor === user.id ? acct.passkeys : null;
      body = [
        h('p', { class: 'achievements-signed-in' }, 'Signed in as ', h('strong', {}, user.name)),
        h('div', { class: 'confirm-actions achievements-scopes' },
          h('button', { class: 'btn', type: 'button', on: { click: () => ctx.go({ type: 'profile', id: user.id }) } }, 'YOUR PROFILE'),
          h('button', { class: 'btn', type: 'button', disabled: busy, on: { click: () => run(() => account.signOut()) } }, 'SIGN OUT')),
        h('p', { class: 'achievements-note' }, 'Your name, achievements and best scores are public: anyone can see them in the activity feed, on the leaderboards and on your profile.'),
        h('h4', { class: 'ach-h' }, 'Passkeys'),
        list ? h('ul', { class: 'ach-passkeys' }, list.map((p, i) => h('li', {},
          h('span', {}, `Passkey ${i + 1}`, h('span', { class: 'achievements-note' }, ` added ${when(p.createdAt)}${p.lastUsedAt ? `, last used ${when(p.lastUsedAt)}` : ''}`)),
          list.length > 1 ? h('button', { class: 'achievements-link ach-passkey-remove', type: 'button', disabled: busy, on: { click: () => run(async () => {
            if (await confirmDialog(`Remove passkey ${i + 1}? The device that holds it can no longer sign in to ${user.name}.`, { title: 'Remove passkey', okLabel: 'REMOVE' })) acct.passkeys = await account.removePasskey(p.id);
          }) } }, 'remove') : null))) : h('p', { class: 'achievements-note' }, 'Loading…'),
        h('p', { class: 'achievements-note' }, 'Add a passkey on another device, or a security key, so losing one device does not lose the account.'),
        h('div', { class: 'confirm-actions achievements-scopes' },
          h('button', { class: 'btn', type: 'button', disabled: busy || !supported, on: { click: () => run(async () => { acct.passkeys = await account.addPasskey(); }) } }, 'ADD A PASSKEY')),
        h('h4', { class: 'ach-h' }, 'Recovery code'),
        h('p', { class: 'achievements-note' }, 'With your username, the recovery code adds a passkey on a new device when your others are lost. It was shown when the account was made. A new one replaces it.'),
        h('div', { class: 'confirm-actions achievements-scopes' },
          h('button', { class: 'btn', type: 'button', disabled: busy, on: { click: () => run(async () => {
            if (await confirmDialog('Make a new recovery code? The old one stops working.', { title: 'New recovery code', okLabel: 'MAKE A NEW CODE' })) acct.code = await account.newRecoveryCode();
          }) } }, 'NEW RECOVERY CODE')),
        h('h4', { class: 'ach-h' }, 'Delete'),
        h('div', { class: 'confirm-actions achievements-scopes' },
          h('button', { class: 'btn btn-danger', type: 'button', disabled: busy, on: { click: () => run(async () => {
            const sure = await confirmDialog(`Delete the account ${user.name}? Its achievements and scores go with it, and the name becomes free for anyone.`, { title: 'Delete account', okLabel: 'DELETE' });
            if (sure) await account.deleteAccount();
          }) } }, 'DELETE ACCOUNT')),
      ];
    } else if (acct.recovering) {
      const rname = h('input', { class: 'prompt-input', id: 'achievements-recover-name', maxlength: String(LIMITS.nick), autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', placeholder: 'Username', value: acct.recoverName, disabled: busy || !supported, on: { input: (e) => { acct.recoverName = e.target.value; } } });
      const rcode = h('input', { class: 'prompt-input', id: 'achievements-recover-code', maxlength: '40', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX', value: acct.recoverCode, disabled: busy || !supported, on: { input: (e) => { acct.recoverCode = e.target.value; } } });
      body = [
        h('p', { class: 'confirm-message' }, 'Lost your passkey? Your username and recovery code make a new passkey on this device and sign you in.'),
        h('form', { class: 'achievements-create', on: { submit: (e) => {
          e.preventDefault();
          if (!acct.recoverName.trim() || !acct.recoverCode.trim()) { (acct.recoverName.trim() ? rcode : rname).focus(); return; }
          run(async () => shown(await account.recover(acct.recoverName.trim(), acct.recoverCode)), '#achievements-recover-code');
        } } },
          h('label', { class: 'achievements-label', for: 'achievements-recover-name' }, 'Username'), rname,
          h('label', { class: 'achievements-label', for: 'achievements-recover-code' }, 'Recovery code'), rcode,
          h('div', { class: 'confirm-actions achievements-scopes' },
            h('button', { class: 'btn', type: 'button', on: { click: () => { acct.recovering = false; error = ''; render(); } } }, 'BACK'),
            h('button', { class: 'btn', type: 'submit', disabled: busy || !supported }, 'RECOVER'))),
      ];
    } else {
      // An optional picture, kept here until the account exists, then uploaded.
      const picked = h('input', { type: 'file', accept: 'image/*', id: 'achievements-new-picture', class: 'ach-new-picture-input', disabled: busy || !supported, on: { change: (e) => {
        const file = e.target.files?.[0] ?? null;
        if (!file) return;
        if (acct.newPictureUrl) URL.revokeObjectURL(acct.newPictureUrl);
        acct.newPicture = file;
        acct.newPictureUrl = URL.createObjectURL(file);
        render();
      } } });
      const name = h('input', { class: 'prompt-input', id: 'achievements-new-name', maxlength: String(LIMITS.nick), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'Username', value: acct.newName, disabled: busy || !supported, on: { input: (e) => { acct.newName = e.target.value; } } });
      body = [
        h('p', { class: 'confirm-message' }, 'Sign in to earn achievements, post your scores and chat. A passkey signs you in with your device\'s fingerprint, face or PIN. There is no password.'),
        supported ? null : h('p', { class: 'achievements-error' }, 'This browser cannot use passkeys.'),
        h('div', { class: 'confirm-actions achievements-signin' },
          h('button', { class: 'btn', type: 'button', disabled: busy || !supported, on: { click: () => run(() => account.signIn(), null, 'signin') } }, 'SIGN IN WITH PASSKEY'),
          h('button', { class: 'achievements-link', type: 'button', on: { click: () => { acct.recovering = true; error = ''; render(); } } }, 'Lost your passkey?')),
        errorAt === 'signin' ? err : null,
        h('form', { class: 'achievements-create', on: { submit: (e) => { e.preventDefault(); const n = acct.newName.trim(); if (n) run(async () => {
          shown(await account.register(n));
          acct.newName = '';
          const pic = acct.newPicture;
          acct.newPicture = null;
          if (acct.newPictureUrl) { URL.revokeObjectURL(acct.newPictureUrl); acct.newPictureUrl = null; }
          // The account is made either way: a picture that fails to upload can be added on the profile.
          if (pic) await account.setPicture(pic).catch(() => {});
        }, '#achievements-new-name'); else name.focus(); } } },
          h('h4', { class: 'ach-h' }, 'New here?'),
          h('label', { class: 'achievements-label', for: 'achievements-new-name' }, 'Create an account to track your progress.'),
          name,
          // Before: UPLOAD BADGE and a note. After: the badge itself, CHANGE BADGE beside it.
          h('div', { class: 'ach-new-picture' },
            acct.newPicture ? h('span', { class: 'ach-tile ach-tile-big has-picture' }, h('img', { class: 'ach-picture', src: acct.newPictureUrl, alt: 'Your badge' })) : null,
            h('label', { class: 'btn ach-new-picture-btn', for: 'achievements-new-picture' }, acct.newPicture ? 'CHANGE BADGE' : 'UPLOAD BADGE'),
            picked,
            acct.newPicture ? null : h('span', { class: 'achievements-note' }, 'Optional. You can add one later on your profile.')),
          h('div', { class: 'confirm-actions' }, h('button', { class: 'btn', type: 'submit', disabled: busy || !supported }, 'CREATE ACCOUNT'))),
        h('p', { class: 'achievements-note achievements-public' }, 'Your username, achievements and best scores are public.'),
      ];
    }
    if (!user) { acct.code = ''; acct.passkeys = null; acct.passkeysFor = null; }
    // A redraw keeps the focus on the same control (by its id), so typing or COPY is not lost.
    const focused = accountEl.contains(document.activeElement) ? document.activeElement.id : '';
    // An error shows where it happened (under SIGN IN WITH PASSKEY), else at the end.
    const placed = errorAt === 'signin' && !user && !acct.recovering;
    accountEl.replaceChildren(...body.filter(Boolean), ...(err && !placed ? [err] : []));
    if (focused) accountEl.querySelector(`#${focused}`)?.focus();
    accountEl.setAttribute('aria-busy', String(busy));
    renderGame();
  }

  // Tabs: click, or the arrow keys between them.
  for (const [name, b] of tabButtons) {
    b.addEventListener('click', () => selectTab(name));
    b.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      selectTab(TABS[(TABS.indexOf(currentTab()) + step + TABS.length) % TABS.length], true);
    });
  }
  for (const b of buttons) {
    b.addEventListener('click', () => {
      opener = b;
      const want = b.dataset.tab || null;
      if (win.hidden) open(want);
      else if (want && currentTab() !== want) open(want);
      else close();
    });
  }
  closeBtn?.addEventListener('click', () => close());
  let shownGame = engine?.game?.hash ?? null;
  // Three flashes on whichever opening button shows (the header's, or the
  // fullscreen toolbar's), to say the loaded game has achievements.
  function flashButtons() {
    for (const b of buttons) {
      if (!b.offsetParent) continue;
      b.classList.remove('is-flashing');
      void b.offsetWidth;   // restart the animation
      b.classList.add('is-flashing');
      b.addEventListener('animationend', () => b.classList.remove('is-flashing'), { once: true });
    }
  }
  return {
    open, close, account,
    isOpen: () => !win.hidden,
    /** The account signed in or out: the chat follows it. */
    accountChanged() { chat?.accountChanged(); },
    /**
     * A leaderboard attempt from the engine: started and updated carry the
     * running score, shown live; canceled clears it; submitted clears it and
     * fetches the standings (and the activity) again.
     */
    leaderboardEvent({ type, leaderboard, value }) {
      if (type === 'started' || type === 'updated') {
        const had = live.has(leaderboard.id);
        live.set(leaderboard.id, value);
        if (win.hidden || currentTab() !== 'game' || detail.length) return;
        const cell = gameEl.querySelector(`.ach-screen-live[data-board="${leaderboard.id}"] .ach-screen-live-value`);
        if (had && cell) cell.textContent = ctx.format(value, leaderboard.format);   // the hot path: one text node
        else renderGame();
        return;
      }
      live.delete(leaderboard.id);
      if (win.hidden || detail.length) return;
      if (type === 'submitted') showView();
      else if (currentTab() === 'game') renderGame();
    },
    /**
     * The account or the game changed: draw again, and refetch while open. A
     * newly loaded game with achievements brings its tab forward, and on a
     * desktop opens the window on it. On a phone, or in fullscreen, the window
     * would cover the game, so the button that opens it flashes instead.
     */
    refresh() {
      const hash = engine?.game?.hash ?? null;
      if (hash !== shownGame) {
        shownGame = hash;
        if (hash) {
          tab = null; detail = [];
          if (win.hidden) {
            if (!fillsScreen() && !document.body.classList.contains('fullscreen-mode')) { open('game'); return; }
            flashButtons();
          }
        }
      }
      render();
      if (!win.hidden && !detail.length && !['account', 'chat'].includes(currentTab())) showView();
    },
  };
}
