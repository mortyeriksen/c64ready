// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/chat/window.js — the chat, the CHAT tab of the Achievements window
// (src/online/window.js): one channel for everyone signed in, named by their
// account. A message can mention games with achievements (`@Bomb Jack`,
// picked from a list as you type), each a link to its page. Unlocks and new
// best scores are in the ACTIVITY tab, not here. Members hide, report or vote out a member. The window
// mounts it and tells it when it shows and hides; it is loaded the first time
// the CHAT tab opens, so the app does not carry it.

import { LIMITS } from '../../server/protocol.mjs';
import { createChatConnection, chatServerUrl } from './connection.js';
import { pushEscapeLayer, popEscapeLayer } from '../ui/escape-stack.js';
import { playerHue, gameIcon } from '../achievements/browse.js';
import { confirmDialog } from '../ui/dialogs.js';

const RESUME_KEY = 'c64emu.chat.resume';

const ERRORS = {
  FULL: 'The chat is full right now. Try again later.',
  BANNED: 'You were removed from the chat for an hour.',
  RATE_LIMITED: 'Slow down a little and try again.',
  MUTED: 'The admin has muted you.',
  TEXT_INVALID: 'Messages are up to 280 characters.',
  OFFLINE: 'Not connected. Trying again…',
  TIMEOUT: 'The chat server did not answer. Try again.',
};
const errorText = (e) => ERRORS[e?.code] || 'Something went wrong. Try again.';

const session = {
  set(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { /* blocked */ } },
};

function h(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c);
  return n;
}
const time = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const until = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// The emoji picker: everyday faces and gestures, and a few for the C64.
const EMOJI = [
  ['😀', 'grinning'], ['😂', 'laughing'], ['😉', 'winking'], ['😎', 'cool'], ['🤔', 'thinking'], ['😮', 'surprised'], ['😢', 'sad'], ['😡', 'angry'],
  ['👍', 'thumbs up'], ['👎', 'thumbs down'], ['👏', 'applause'], ['🙌', 'hooray'], ['🙏', 'thank you'], ['💪', 'strong'], ['🤘', 'rock on'], ['👋', 'wave'],
  ['❤️', 'heart'], ['🔥', 'fire'], ['⭐', 'star'], ['🎉', 'party'], ['💯', 'hundred'], ['✅', 'done'], ['❓', 'question'], ['💀', 'game over'],
  ['🕹️', 'joystick'], ['🎮', 'game controller'], ['👾', 'space invader'], ['💾', 'floppy disk'], ['📼', 'cassette'], ['🎵', 'music'], ['🏆', 'trophy'], ['🚀', 'rocket'],
];

// A member's colour follows their account, so it matches the achievements' activity feed.
const hue = (who) => playerHue(who.uid ?? who.id);

/**
 * The mentions in `text`: at each '@', the longest of `games`' titles that
 * follows it, in any case ("@Commando Arcade" is Commando Arcade, not Commando).
 * [{ start, end, game }], in order.
 */
export function findMentions(text, games) {
  const lower = text.toLowerCase();
  const byLength = [...games].sort((a, b) => b.title.length - a.title.length);
  const found = [];
  for (let i = lower.indexOf('@'); i !== -1; i = lower.indexOf('@', i + 1)) {
    const g = byLength.find((x) => lower.startsWith(x.title.toLowerCase(), i + 1));
    if (g) { found.push({ start: i, end: i + 1 + g.title.length, game: g }); i += g.title.length; }
  }
  return found;
}

/**
 * @param {object} o
 * @param {HTMLElement} o.container          the CHAT tab's panel
 * @param {(n: number) => void} o.onUnread    unread messages while the chat is not shown
 * @param {{ user: object|null, token: string|null }} o.account  the signed-in account: chatting needs one, and its name is the name in the chat
 * @param {() => void} [o.onSignIn]           shows where to sign in
 * @param {() => boolean} [o.isFull]          the window fills a phone's screen
 * @param {() => Promise<{id: string, title: string}[]>} [o.games]  the games with achievements, which a message can mention
 * @param {() => string|null} [o.loadedGame]  the loaded game's id, first in the list of mentions
 * @param {(id: string) => void} [o.onGame]    a mention was clicked: show that game
 * @param {(user: object) => HTMLElement} [o.player]  a player, as the activity names them: badge or tile, a link to their profile
 */
export function createChatPane({ container, onUnread, account, onSignIn = () => {}, isFull = () => false, games = async () => [], loadedGame = () => null, onGame = () => {}, player = null }) {
  const st = {
    view: 'signin', me: null, channel: null, log: [], out: '',
    hidden: new Set(), status: 'offline', unread: 0, peopleOpen: false,
  };
  // The games a message can mention, fetched once; [] until they arrive.
  let known = [];
  const knowGames = () => games().then((list) => { known = list.map((g) => ({ id: g.id, title: g.title })); }, () => {});
  const conn = createChatConnection({ url: chatServerUrl(), onEvent, onStatus, accountToken: () => account.token });

  // ── Skeleton ─────────────────────────────────────────────────────────────
  let visible = false;
  const titleEl = h('span', { class: 'chat-title' }, 'CHAT');
  const statusEl = h('span', { class: 'chat-status', role: 'status' });
  const bar = h('div', { class: 'chat-bar' }, titleEl, statusEl);
  const body = h('div', { class: 'chat-body' });
  container.append(bar, body);

  const signinView = h('div', { class: 'chat-view chat-view-signin' },
    h('p', { class: 'chat-intro' }, 'Talk with everyone playing on C64 READY. Sign in to chat: your username is your name in the chat.'),
    h('ul', { class: 'chat-facts' },
      h('li', {}, 'Messages are logged with your account and IP address and kept for 90 days, so abuse can be investigated.'),
      h('li', {}, 'The chat is moderated: members can vote someone out for an hour, and the admin can mute, remove and ban.')),
    h('button', { type: 'button', class: 'btn chat-primary', onclick: () => onSignIn() }, 'SIGN IN'));

  const outNote = h('p', { class: 'chat-banner', role: 'status', hidden: true });
  const peopleBtn = h('button', { type: 'button', class: 'btn chat-small', 'aria-expanded': 'false', onclick: () => { st.peopleOpen = !st.peopleOpen; renderPeople(); } }, 'PEOPLE');
  const people = h('div', { class: 'chat-people', hidden: true });
  const log = h('ol', { class: 'chat-log', 'aria-live': 'polite', 'aria-label': 'Messages' });
  const say = h('input', { class: 'chat-input', maxlength: String(LIMITS.text), autocomplete: 'off', 'aria-label': 'Message', placeholder: 'Message. Type @ for a game', enterkeyhint: 'send',
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': 'chat-mention-list' });
  const mentionList = h('ul', { class: 'chat-mentions', id: 'chat-mention-list', role: 'listbox', 'aria-label': 'Games', hidden: true });
  const sendBtn = h('button', { type: 'submit', class: 'btn chat-primary' }, 'SEND');
  const emojiBtn = h('button', { type: 'button', class: 'btn chat-emoji-btn', 'aria-label': 'Emoji', title: 'Emoji', 'aria-haspopup': 'true', 'aria-expanded': 'false', onclick: () => toggleEmoji() }, '🙂');
  const emojiPanel = h('div', { class: 'chat-emoji', role: 'group', 'aria-label': 'Emoji', hidden: true },
    EMOJI.map(([e, name]) => h('button', { type: 'button', class: 'chat-emoji-pick', title: name, 'aria-label': name, onclick: () => insertEmoji(e) }, e)));
  const sayNote = h('p', { class: 'chat-note chat-say-note', hidden: true });
  const channelView = h('div', { class: 'chat-view chat-view-channel', hidden: true },
    h('div', { class: 'chat-row chat-room-bar' }, peopleBtn),
    outNote, people, log, sayNote, emojiPanel, mentionList,
    h('form', { class: 'chat-row chat-compose', onsubmit: (e) => { e.preventDefault(); send(); } }, say, emojiBtn, sendBtn));

  body.append(signinView, channelView);

  // ── Rendering ────────────────────────────────────────────────────────────
  function show(view) {
    st.view = view;
    if (view !== 'channel') closeEmoji();
    signinView.hidden = view !== 'signin';
    channelView.hidden = view !== 'channel';
    if (view === 'channel') renderChannel();
    renderHead();
  }

  function renderHead() {
    const s = { connecting: 'connecting…', offline: 'offline', replaced: 'open on another device', banned: 'banned', old: 'reload to update' }[st.status];
    const here = st.channel ? st.channel.members.filter((m) => m.here).length : 0;
    statusEl.textContent = st.view === 'signin' ? '' : st.status === 'online' ? (st.channel ? `${here} online` : '') : s || '';
  }

  /** A message's text, its mentions drawn as links to their games, in each game's colour. */
  function messageText(m) {
    const out = h('span', { class: 'chat-text' });
    let at = 0;
    for (const { start, end, game } of findMentions(m.text, m.games ?? [])) {
      out.append(m.text.slice(at, start), h('button', { type: 'button', class: `chat-mention ${playerHue(game.id)}`, title: `${game.title}: achievements and high scores`, onclick: () => onGame(game.id) },
        gameIcon(game.id, 12), game.title));
      at = end;
    }
    out.append(m.text.slice(at));
    return out;
  }

  function messageItem(m) {
    if (m.notice) return h('li', { class: 'chat-notice' }, m.notice);
    if (st.hidden.has(m.from.id)) return h('li', { class: 'chat-notice' }, `A message from ${m.from.nick} is hidden.`);
    const cls = ['chat-msg', m.from.id === st.me ? 'is-me' : '', m.sysop ? 'is-sysop' : ''].filter(Boolean).join(' ');
    return h('li', { class: cls, 'data-n': String(m.n) },
      h('span', { class: 'chat-time' }, time(m.at)),
      !m.sysop && player && m.from.uid
        ? h('span', { class: 'chat-nick' }, player({ id: m.from.uid, name: m.from.nick, avatar: m.from.avatar || 0 }))
        : h('span', { class: `chat-nick ${m.sysop ? '' : hue(m.from)}` }, m.from.nick),
      messageText(m));
  }

  function renderLog() {
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.replaceChildren(...st.log.map(messageItem));
    if (!st.log.length) log.append(h('li', { class: 'chat-notice' }, 'No messages yet. Say hello!'));
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  function appendLog(entry) {
    st.log.push(entry);
    if (st.log.length > 200) st.log.shift();
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    if (st.log.length === 1) log.replaceChildren();
    log.append(messageItem(entry));
    while (log.childElementCount > 200) log.firstElementChild.remove();
    if (atBottom || entry.from?.id === st.me) log.scrollTop = log.scrollHeight;
  }

  function renderPeople() {
    const ch = st.channel;
    people.hidden = !st.peopleOpen || !ch;
    peopleBtn.setAttribute('aria-expanded', String(st.peopleOpen));
    peopleBtn.textContent = ch ? `PEOPLE ${ch.members.filter((m) => m.here).length}` : 'PEOPLE';
    if (!st.peopleOpen || !ch) return;
    people.replaceChildren();
    for (const m of [...ch.members].sort((a, b) => b.here - a.here || a.nick.localeCompare(b.nick))) {
      const me = m.id === st.me;
      const tags = [me ? 'you' : null, m.muted ? 'muted' : null, m.here ? null : 'away'].filter(Boolean).join(', ');
      const row = h('div', { class: `chat-person${m.here ? '' : ' is-away'}` },
        h('span', { class: `chat-nick ${hue(m)}` }, m.nick), tags ? h('span', { class: 'chat-person-tags' }, tags) : null);
      if (!me) {
        row.append(h('div', { class: 'chat-person-actions' },
          h('button', { type: 'button', class: 'chat-link', onclick: () => { st.hidden.has(m.id) ? st.hidden.delete(m.id) : st.hidden.add(m.id); renderLog(); renderPeople(); } },
            st.hidden.has(m.id) ? 'show' : 'hide'),
          h('button', { type: 'button', class: 'chat-link', onclick: () => vote(m) }, `vote to remove${m.votes ? ` (${m.votes}/${m.need})` : ''}`),
          h('button', { type: 'button', class: 'chat-link chat-danger', onclick: () => report(m) }, 'report')));
      }
      people.append(row);
    }
  }

  function renderCompose() {
    const meMember = st.channel?.members.find((m) => m.id === st.me);
    const note = st.status !== 'online' ? ERRORS.OFFLINE : !st.channel ? '' : meMember?.muted ? ERRORS.MUTED : '';
    sayNote.hidden = !note;
    sayNote.textContent = note;
    say.disabled = sendBtn.disabled = emojiBtn.disabled = !!note || !st.channel;
    if (note) { closeEmoji(); closeMentions(); }
  }

  function renderChannel() {
    outNote.hidden = !st.out;
    // Taken over by another device or tab: this one takes it back. Else join again.
    const again = st.status === 'replaced'
      ? h('button', { type: 'button', class: 'chat-link', onclick: () => conn.connect() }, 'use it here')
      : h('button', { type: 'button', class: 'chat-link', onclick: rejoin }, 'try again');
    outNote.replaceChildren(st.out, ...(st.out && !st.channel ? [' ', again] : []));
    renderPeople();
    renderCompose();
    renderHead();
  }

  // The emoji picker opens over the messages, just above the message box. Esc
  // or a click anywhere else closes it before anything else; a pick goes in at
  // the cursor and closes it.
  const emojiLayer = { close: () => closeEmoji(), isOpen: () => !emojiPanel.hidden };
  function toggleEmoji() {
    if (!emojiPanel.hidden) { closeEmoji(); return; }
    emojiPanel.hidden = false;
    emojiBtn.setAttribute('aria-expanded', 'true');
    pushEscapeLayer(emojiLayer);
  }
  function closeEmoji() {
    if (emojiPanel.hidden) return;
    emojiPanel.hidden = true;
    emojiBtn.setAttribute('aria-expanded', 'false');
    popEscapeLayer(emojiLayer);
  }
  function insertEmoji(e) {
    const start = say.selectionStart ?? say.value.length;
    const end = say.selectionEnd ?? start;
    const next = say.value.slice(0, start) + e + say.value.slice(end);
    if (next.length > say.maxLength) return;
    say.value = next;
    closeEmoji();
    say.focus();
    say.setSelectionRange(start + e.length, start + e.length);
  }
  container.addEventListener('pointerdown', (e) => {
    if (!emojiPanel.hidden && !emojiPanel.contains(e.target) && !emojiBtn.contains(e.target)) closeEmoji();
    if (!mentionList.hidden && !mentionList.contains(e.target) && e.target !== say) closeMentions();
  });

  // Mentions: '@' and the start of a title, just before the cursor, lists the
  // matching games (the loaded one first). Up and down move, Enter or Tab picks,
  // Esc closes. A pick replaces what was typed with "@Title ".
  let picks = [], pickAt = 0, query = null;
  const mentionLayer = { close: () => closeMentions(), isOpen: () => !mentionList.hidden };
  function typedMention() {
    const before = say.value.slice(0, say.selectionStart ?? say.value.length);
    const m = /(?:^|\s)@([^@]{0,24})$/.exec(before);
    return m ? { text: m[1], start: before.length - m[1].length - 1 } : null;
  }
  function updateMentions() {
    query = typedMention();
    if (!query || !known.length) { closeMentions(); return; }
    const q = query.text.toLowerCase().trimStart();
    const loaded = loadedGame();
    picks = known.filter((g) => g.title.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || g.title.toLowerCase().startsWith(q))
      .sort((a, b) => (b.id === loaded) - (a.id === loaded) || a.title.localeCompare(b.title)).slice(0, 6);
    if (!picks.length) { closeMentions(); return; }
    pickAt = Math.min(pickAt, picks.length - 1);
    mentionList.replaceChildren(...picks.map((g, i) => h('li', { role: 'option', id: `chat-mention-${i}`, class: `chat-mention-pick${i === pickAt ? ' is-active' : ''}`, 'aria-selected': String(i === pickAt),
      onpointerdown: (e) => { e.preventDefault(); pick(i); } },
      h('span', { class: playerHue(g.id) }, gameIcon(g.id, 14)), g.title, g.id === loaded ? h('span', { class: 'chat-mention-loaded' }, 'loaded') : null)));
    say.setAttribute('aria-activedescendant', `chat-mention-${pickAt}`);
    if (mentionList.hidden) { mentionList.hidden = false; say.setAttribute('aria-expanded', 'true'); pushEscapeLayer(mentionLayer); }
  }
  function closeMentions() {
    pickAt = 0;
    if (mentionList.hidden) return;
    mentionList.hidden = true;
    say.setAttribute('aria-expanded', 'false');
    say.removeAttribute('aria-activedescendant');
    popEscapeLayer(mentionLayer);
  }
  function pick(i) {
    const g = picks[i];
    if (!g || !query) return;
    const end = say.selectionStart ?? say.value.length;
    const insert = `@${g.title} `;
    const next = say.value.slice(0, query.start) + insert + say.value.slice(end);
    if (next.length > say.maxLength) return;
    say.value = next;
    const caret = query.start + insert.length;
    say.focus();
    say.setSelectionRange(caret, caret);
    closeMentions();
  }
  say.addEventListener('input', () => { pickAt = 0; updateMentions(); });
  say.addEventListener('click', updateMentions);
  say.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== say) closeMentions(); }, 0));
  say.addEventListener('keydown', (e) => {
    if (mentionList.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      pickAt = (pickAt + (e.key === 'ArrowDown' ? 1 : picks.length - 1)) % picks.length;
      updateMentions();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      pick(pickAt);
    }
  });

  // ── Server events ────────────────────────────────────────────────────────
  function entered(channel) {
    st.channel = channel;
    st.out = '';
    st.log = channel.history.map((m) => ({ ...m }));
    session.set(RESUME_KEY, '1');
    renderLog();
    if (st.view === 'channel') renderChannel();
  }
  function keptOut(text) {
    st.channel = null;
    st.out = text;
    session.set(RESUME_KEY, null);
    if (st.view === 'channel') renderChannel();
  }

  function onEvent(e) {
    switch (e.t) {
      case 'welcome':
        st.me = e.id;
        if (e.room) {
          if (st.channel) { st.channel = e.room; mergeHistory(e.room.history); if (st.view === 'channel') renderChannel(); }
          else entered(e.room);
        } else keptOut(e.banned ? `You were removed from the chat until ${until(e.banned)}.` : e.full ? ERRORS.FULL : '');
        break;
      case 'room':
        if (st.channel) { st.channel = { ...e.room, history: [] }; if (st.view === 'channel') renderChannel(); }
        break;
      case 'msg':
        appendLog(e.m);
        if (e.m.from.id !== st.me && (!visible || document.hidden)) { st.unread++; onUnread?.(st.unread); }
        break;
      case 'notice':
        appendLog({ notice: e.text });
        break;
      case 'del': {
        if (!Number.isSafeInteger(e.n)) break;
        st.log = st.log.filter((m) => m.n !== e.n);
        log.querySelector(`[data-n="${e.n}"]`)?.remove();
        break;
      }
      case 'kicked':
        keptOut(`${e.by === 'sysop' ? 'The admin removed you' : 'The chat voted to remove you'}${e.until ? ` until ${until(e.until)}` : ''}.`);
        break;
      case 'banned':
        keptOut('The admin has banned this connection from the chat for a while.');
        break;
    }
  }

  function mergeHistory(history) {
    const seen = new Set(st.log.filter((m) => m.n).map((m) => m.n));
    for (const m of history) if (!seen.has(m.n)) st.log.push(m);
    st.log.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
    renderLog();
  }

  function onStatus(s) {
    st.status = s;
    if (s === 'replaced') keptOut('The chat is open on another device or tab.');
    if (s === 'signin') { st.channel = null; show('signin'); return; }
    if (st.view === 'channel') renderChannel();
    else renderHead();
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  async function send() {
    const text = say.value.trim();
    if (!text) return;
    const ids = [...new Set(findMentions(text, known).map((x) => x.game.id))].slice(0, LIMITS.mentions);
    try {
      await conn.request('say', { text, ...(ids.length ? { games: ids } : {}) });
      say.value = '';
      closeEmoji();
      closeMentions();
      renderCompose();
      say.focus();   // SEND clicked: the next line is typed here, as after Enter
    } catch (e) { sayNote.hidden = false; sayNote.textContent = errorText(e); }
  }

  async function rejoin() {
    try { entered((await conn.request('join')).room); } catch (e) { keptOut(errorText(e)); }
  }

  async function vote(m) {
    const ok = await confirmDialog(`Vote to remove ${m.nick} from the chat? When most of the others here agree, they are kept out for an hour.`, { title: 'Vote to remove', okLabel: 'VOTE' });
    if (!ok) return;
    try {
      const r = await conn.request('vote', { member: m.id });
      if (r.removed) return;   // the chat's own notice says so
      appendLog({ notice: r.counted
        ? `You voted to remove ${m.nick}: ${r.votes} of the ${r.need} votes needed.`
        : `Your vote to remove ${m.nick} does not count: you are on the same network as them, and a network has one vote.` });
    } catch (e) { appendLog({ notice: errorText(e) }); }
  }

  async function report(m) {
    const ok = await confirmDialog(`Report ${m.nick} to the admin? The chat's recent messages go with the report.`, { title: 'Report', okLabel: 'REPORT' });
    if (!ok) return;
    try { await conn.request('report', { member: m.id }); appendLog({ notice: `Thanks. ${m.nick} was reported. You can also hide them, or vote to remove them.` }); }
    catch (e) { appendLog({ notice: errorText(e) }); }
  }

  // ── Shown and hidden ─────────────────────────────────────────────────────
  /** The tab came into view: unread is cleared, and the channel shows. */
  function shown() {
    if (visible) return;
    visible = true;
    st.unread = 0;
    onUnread?.(0);
    if (!account.user) { show('signin'); return; }
    if (!known.length) knowGames();
    conn.connect();
    show('channel');
  }

  /**
   * The account changed: a different account connects afresh, signing out
   * leaves the chat. The first account seen (restored after a reload) keeps
   * the tab's place in the chat.
   */
  // Unknown (undefined) only while a stored session is still being checked.
  let knownUser = account.user ? account.user.id : account.token ? undefined : null;
  function accountChanged() {
    const id = account.user?.id ?? null;
    if (knownUser === undefined || id === knownUser) { knownUser = id; if (!id && visible) show('signin'); return; }
    knownUser = id;
    // Leave first, so the old account is not left in the chat as away.
    const leaving = st.channel && conn.status === 'online' ? conn.request('leave', {}, 2000).catch(() => {}) : Promise.resolve();
    st.channel = null; st.log = []; st.out = '';
    session.set(RESUME_KEY, null);
    if (!account.user) show('signin');
    leaving.then(() => {
      conn.close();
      conn.forget();
      if (account.user && visible) { conn.connect(); show('channel'); }
    });
  }

  /** The tab or the window closed: messages count as unread again. */
  function hidden() {
    if (!visible) return;
    visible = false;
    closeEmoji();
    closeMentions();
  }

  return {
    shown,
    hidden,
    accountChanged,
    /** Reconnect in the background after a reload, so the unread count carries on. */
    resume() { if (conn.hasSession() && account.token) conn.connect(); },
    /** In the chat: the window shows it first. */
    inRoom: () => !!st.channel,
    el: container,
  };
}
