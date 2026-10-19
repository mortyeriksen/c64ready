// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/chat/window.js — the chat window. On a desktop it floats over the app,
// dragged by its title bar and resized from its edges, and remembers where it
// was; on a phone (or a short landscape screen with touch) it fills the
// screen, follows the on-screen keyboard and closes with the Back button.
// Three views: the nickname, the lobby (rooms about what is loaded, a room of
// your own, and every open room, which anyone may join) and the room. Loaded lazily by
// start.js the first time the chat is opened, so the app does not carry it.

import { LIMITS, topicKey } from '../../server/protocol.mjs';
import { createChatConnection, chatServerUrl } from './connection.js';
import { loadedItems } from '../media/now-loaded.js';
import { openAssembly64File, searchAssembly64 } from '../assembly64/start.js';
import { pushEscapeLayer, popEscapeLayer } from '../ui/escape-stack.js';
import { confirmDialog } from '../ui/dialogs.js';

const NICK_KEY = 'c64emu.chat.nick';
const RECT_KEY = 'c64emu.chat.rect';
const RESUME_KEY = 'c64emu.chat.resume';
const MIN_W = 300, MIN_H = 340;
const FULL_QUERY = '(max-width: 680px), (pointer: coarse) and (max-height: 520px)';

const ERRORS = {
  NICK_INVALID: 'Pick another nickname: that one is empty, too long or reserved.',
  NICK_TAKEN: 'Someone in that room already uses this nickname.',
  BLOCKED_WORD: 'That name is not allowed.',
  NAME_INVALID: 'Give the room a name (up to 32 characters).',
  NOT_FOUND: 'That room has closed.',
  FULL: 'That room is full.',
  BANNED: 'You were removed from that room.',
  RATE_LIMITED: 'Slow down a little and try again.',
  TOO_MANY_ROOMS: 'The chat is busy right now. Try again later.',
  MUTED: 'The host has muted you.',
  TEXT_INVALID: 'Messages are up to 280 characters.',
  NOT_OWNER: 'Only the host can do that.',
  OFFLINE: 'Not connected. Trying again…',
  TIMEOUT: 'The chat server did not answer. Try again.',
};
const errorText = (e) => ERRORS[e?.code] || 'Something went wrong. Try again.';

const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* blocked */ } },
};
const session = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
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
// One of eight name colours, the same for a member every time.
// The emoji picker: everyday faces and gestures, and a few for the C64.
const EMOJI = [
  ['😀', 'grinning'], ['😂', 'laughing'], ['😉', 'winking'], ['😎', 'cool'], ['🤔', 'thinking'], ['😮', 'surprised'], ['😢', 'sad'], ['😡', 'angry'],
  ['👍', 'thumbs up'], ['👎', 'thumbs down'], ['👏', 'applause'], ['🙌', 'hooray'], ['🙏', 'thank you'], ['💪', 'strong'], ['🤘', 'rock on'], ['👋', 'wave'],
  ['❤️', 'heart'], ['🔥', 'fire'], ['⭐', 'star'], ['🎉', 'party'], ['💯', 'hundred'], ['✅', 'done'], ['❓', 'question'], ['💀', 'game over'],
  ['🕹️', 'joystick'], ['🎮', 'game controller'], ['👾', 'space invader'], ['💾', 'floppy disk'], ['📼', 'cassette'], ['🎵', 'music'], ['🏆', 'trophy'], ['🚀', 'rocket'],
];

const hue = (id) => { let x = 0; for (const c of String(id)) x = (x * 31 + c.charCodeAt(0)) >>> 0; return `chat-c${x % 8}`; };

/**
 * @param {object} o
 * @param {(n: number) => void} o.onUnread    unread messages while the window is closed
 * @param {(open: boolean) => void} [o.onOpenChange]
 * @param {() => void} [o.onClose]            focus goes back to the machine
 */
export function createChatWindow({ onUnread, onOpenChange, onClose }) {
  const st = {
    view: 'join', nick: storage.get(NICK_KEY) || '', me: null, room: null, log: [], lobby: [],
    hidden: new Set(), pendingCode: null, banner: '', status: 'offline', unread: 0, peopleOpen: false,
  };
  const conn = createChatConnection({ url: chatServerUrl(), onEvent, onStatus });

  // ── Skeleton ─────────────────────────────────────────────────────────────
  const closeBtn = h('button', { type: 'button', class: 'chat-close', 'aria-label': 'Close chat', title: 'Close (you stay in the room)' }, '✕');
  const titleEl = h('span', { class: 'chat-title' }, 'CHAT');
  const statusEl = h('span', { class: 'chat-status', role: 'status' });
  const head = h('div', { class: 'chat-head' }, titleEl, statusEl, closeBtn);
  const body = h('div', { class: 'chat-body' });
  const handles = ['e', 's', 'w', 'se', 'sw'].map((d) => h('div', { class: `chat-resize chat-resize-${d}`, 'data-dir': d, 'aria-hidden': 'true' }));
  const win = h('div', { class: 'chat-window', role: 'dialog', 'aria-label': 'Chat', hidden: true }, head, body, ...handles);
  document.body.append(win);

  // ── Views ────────────────────────────────────────────────────────────────
  const joinNick = h('input', { class: 'chat-input', maxlength: String(LIMITS.nick), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Nickname', placeholder: 'Nickname' });
  const joinNote = h('p', { class: 'chat-note' });
  const joinErr = h('p', { class: 'chat-error', role: 'alert' });
  const joinBtn = h('button', { type: 'submit', class: 'btn chat-primary' }, 'CONTINUE');
  const joinView = h('form', { class: 'chat-view chat-view-join', onsubmit: (e) => { e.preventDefault(); submitNick(); } },
    h('p', { class: 'chat-intro' }, 'Talk with other C64 READY users. No sign-up, just a nickname.'),
    h('ul', { class: 'chat-facts' },
      h('li', {}, 'Messages are logged with your IP address and kept for 90 days, so abuse can be investigated.'),
      h('li', {}, 'Rooms are moderated: hosts, members and the C64 READY admin can remove people. A room closes when everyone has left.')),
    h('label', { class: 'chat-label' }, 'Nickname', joinNick), joinNote, joinErr, joinBtn);

  const lobbyWho = h('span', { class: 'chat-who' });
  const lobbyBanner = h('p', { class: 'chat-banner', role: 'status', hidden: true });
  const chips = h('div', { class: 'chat-chips' });
  const newName = h('input', { class: 'chat-input', maxlength: String(LIMITS.roomName), autocomplete: 'off', placeholder: 'Room name', 'aria-label': 'Room name' });
  const lobbyErr = h('p', { class: 'chat-error', role: 'alert' });
  const roomsList = h('ul', { class: 'chat-rooms' });
  const lobbyView = h('div', { class: 'chat-view chat-view-lobby', hidden: true },
    h('div', { class: 'chat-row chat-who-row' }, lobbyWho, h('button', { type: 'button', class: 'chat-link', onclick: () => show('join') }, 'change')),
    lobbyBanner,
    h('h3', { class: 'chat-h' }, 'Start a room about…'), chips,
    h('form', { class: 'chat-row', onsubmit: (e) => { e.preventDefault(); create(newName.value, null); } },
      newName, h('button', { type: 'submit', class: 'btn' }, 'CREATE')),
    lobbyErr,
    h('h3', { class: 'chat-h' }, 'Rooms'), roomsList);

  const topicEl = h('div', { class: 'chat-topic', hidden: true });
  const peopleBtn = h('button', { type: 'button', class: 'btn chat-small', 'aria-expanded': 'false', onclick: () => { st.peopleOpen = !st.peopleOpen; renderRoom(); } }, 'PEOPLE');
  const leaveBtn = h('button', { type: 'button', class: 'btn chat-small', onclick: leave }, 'LEAVE');
  const people = h('div', { class: 'chat-people', hidden: true });
  const log = h('ol', { class: 'chat-log', 'aria-live': 'polite', 'aria-label': 'Messages' });
  const say = h('input', { class: 'chat-input', maxlength: String(LIMITS.text), autocomplete: 'off', 'aria-label': 'Message', placeholder: 'Message', enterkeyhint: 'send' });
  const sendBtn = h('button', { type: 'submit', class: 'btn chat-primary' }, 'SEND');
  const emojiBtn = h('button', { type: 'button', class: 'btn chat-emoji-btn', 'aria-label': 'Emoji', title: 'Emoji', 'aria-haspopup': 'true', 'aria-expanded': 'false', onclick: () => toggleEmoji() }, '🙂');
  const emojiPanel = h('div', { class: 'chat-emoji', role: 'group', 'aria-label': 'Emoji', hidden: true },
    EMOJI.map(([e, name]) => h('button', { type: 'button', class: 'chat-emoji-pick', title: name, 'aria-label': name, onclick: () => insertEmoji(e) }, e)));
  const sayNote = h('p', { class: 'chat-note chat-say-note', hidden: true });
  const roomView = h('div', { class: 'chat-view chat-view-room', hidden: true },
    h('div', { class: 'chat-row chat-room-bar' }, peopleBtn, leaveBtn),
    topicEl, people, log, sayNote, emojiPanel,
    h('form', { class: 'chat-row chat-compose', onsubmit: (e) => { e.preventDefault(); send(); } }, say, emojiBtn, sendBtn));

  body.append(joinView, lobbyView, roomView);

  // ── Rendering ────────────────────────────────────────────────────────────
  function show(view) {
    st.view = view;
    if (view !== 'room') closeEmoji();
    joinView.hidden = view !== 'join';
    lobbyView.hidden = view !== 'lobby';
    roomView.hidden = view !== 'room';
    if (view === 'join') {
      joinNick.value = st.nick;
      joinNote.textContent = st.pendingCode ? 'Pick a nickname to join that room.' : '';
      joinBtn.textContent = st.pendingCode ? 'JOIN ROOM' : 'CONTINUE';
    }
    if (view === 'lobby') { renderLobby(); conn.request('lobby', { on: true }).catch(() => {}); }
    else if (conn.status === 'online') conn.request('lobby', { on: false }).catch(() => {});
    if (view === 'room') renderRoom();
    renderHead();
    focusView();
  }

  function focusView() {
    if (win.hidden || win.classList.contains('is-full')) return;   // no surprise keyboard on a phone
    const target = st.view === 'join' ? joinNick : st.view === 'room' ? say : null;
    target?.focus();
  }

  function renderHead() {
    // In a room the title names it, in the same face: "Chat about Commando".
    const title = st.view === 'room' && st.room ? `Chat about ${st.room.name}` : 'CHAT';
    titleEl.textContent = title;
    titleEl.title = title === 'CHAT' ? '' : title;
    const s = { connecting: 'connecting…', offline: 'offline', replaced: 'open in another tab', banned: 'banned', old: 'reload to update' }[st.status];
    statusEl.textContent = st.view === 'join' || st.status === 'online' ? '' : s || '';
  }

  function chipsFor() {
    const items = loadedItems();
    chips.replaceChildren();
    if (!items.length) chips.append(h('p', { class: 'chat-note' }, 'Load a disk, cartridge or tape, and you can start a room about it here.'));
    for (const it of items) {
      chips.append(h('button', { type: 'button', class: 'chat-chip', onclick: () => create(it.title, { title: it.title, kind: it.kind, a64: it.a64 || undefined }) },
        h('span', { class: 'chat-chip-title' }, it.title), h('span', { class: 'chat-chip-meta' }, it.label)));
    }
    return items;
  }

  function renderLobby() {
    lobbyWho.textContent = `You are ${st.nick}`;
    lobbyBanner.hidden = !st.banner;
    lobbyBanner.textContent = st.banner;
    const loadedKeys = new Set(chipsFor().map((it) => topicKey({ title: it.title, kind: it.kind, a64: it.a64 })));
    roomsList.replaceChildren();
    const rooms = [...st.lobby].sort((a, b) => (loadedKeys.has(b.key) - loadedKeys.has(a.key)) || b.count - a.count);
    if (!rooms.length) roomsList.append(h('li', { class: 'chat-note' }, st.status === 'online' ? 'No rooms right now. Start one!' : 'Connecting…'));
    for (const r of rooms) {
      const match = loadedKeys.has(r.key);
      roomsList.append(h('li', { class: `chat-room${match ? ' is-match' : ''}` },
        h('div', { class: 'chat-room-text' },
          h('span', { class: 'chat-room-name' }, r.name),
          h('span', { class: 'chat-room-meta' }, [r.topic?.title, `${r.count} here`, match ? 'you have this loaded' : null].filter(Boolean).join(' · '))),
        h('button', { type: 'button', class: 'btn chat-small', onclick: () => join(r.code) }, 'JOIN')));
    }
  }

  function messageItem(m) {
    if (m.notice) return h('li', { class: 'chat-notice' }, m.notice);
    if (st.hidden.has(m.from.id)) return h('li', { class: 'chat-notice' }, `A message from ${m.from.nick} is hidden.`);
    const cls = ['chat-msg', m.from.id === st.me ? 'is-me' : '', m.sysop ? 'is-sysop' : ''].filter(Boolean).join(' ');
    return h('li', { class: cls, 'data-n': String(m.n) },
      h('span', { class: 'chat-time' }, time(m.at)),
      h('span', { class: `chat-nick ${m.sysop ? '' : hue(m.from.id)}` }, m.from.nick),
      h('span', { class: 'chat-text' }, m.text));
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

  function renderTopic() {
    const t = st.room?.topic;
    topicEl.hidden = !t;
    topicEl.replaceChildren();
    if (!t) return;
    const have = loadedItems().some((it) => topicKey({ title: it.title, kind: it.kind, a64: it.a64 }) === st.room.key);
    topicEl.append(h('span', { class: 'chat-topic-text' }, `About ${t.title}`));
    if (have) topicEl.append(h('span', { class: 'chat-topic-have' }, 'loaded'));
    else if (t.a64) topicEl.append(h('button', { type: 'button', class: 'btn chat-small', onclick: () => loadTopic(t) }, `LOAD ${t.title.toUpperCase()}`));
    else topicEl.append(h('button', { type: 'button', class: 'btn chat-small', onclick: () => searchAssembly64(t.title) }, 'FIND ON ASSEMBLY64'));
  }

  function renderPeople() {
    const r = st.room;
    people.hidden = !st.peopleOpen;
    peopleBtn.setAttribute('aria-expanded', String(st.peopleOpen));
    peopleBtn.textContent = `PEOPLE ${r.members.length}`;
    if (!st.peopleOpen) return;
    const host = r.owner === st.me;
    people.replaceChildren();
    for (const m of r.members) {
      const me = m.id === st.me;
      const tags = [m.id === r.owner ? 'host' : null, me ? 'you' : null, m.muted ? 'muted' : null, m.here ? null : 'away'].filter(Boolean).join(', ');
      const row = h('div', { class: `chat-person${m.here ? '' : ' is-away'}` },
        h('span', { class: `chat-nick ${hue(m.id)}` }, m.nick), tags ? h('span', { class: 'chat-person-tags' }, tags) : null);
      if (!me) {
        const actions = h('div', { class: 'chat-person-actions' });
        actions.append(h('button', { type: 'button', class: 'chat-link', onclick: () => { st.hidden.has(m.id) ? st.hidden.delete(m.id) : st.hidden.add(m.id); renderLog(); renderPeople(); } },
          st.hidden.has(m.id) ? 'show' : 'hide'));
        if (host) {
          actions.append(h('button', { type: 'button', class: 'chat-link', onclick: () => act('mute', { member: m.id, on: !m.muted }) }, m.muted ? 'unmute' : 'mute'));
          actions.append(h('button', { type: 'button', class: 'chat-link chat-danger', onclick: () => kick(m) }, 'remove'));
        } else {
          actions.append(h('button', { type: 'button', class: 'chat-link', onclick: () => act('vote', { member: m.id }) }, `vote to remove${m.votes ? ` (${m.votes}/${m.need})` : ''}`));
        }
        actions.append(h('button', { type: 'button', class: 'chat-link chat-danger', onclick: () => report(m) }, 'report'));
        row.append(actions);
      }
      people.append(row);
    }
  }

  function renderCompose() {
    const meMember = st.room?.members.find((m) => m.id === st.me);
    const note = st.status !== 'online' ? ERRORS.OFFLINE : meMember?.muted ? ERRORS.MUTED : '';
    sayNote.hidden = !note;
    sayNote.textContent = note;
    say.disabled = sendBtn.disabled = emojiBtn.disabled = !!note;
    if (note) closeEmoji();
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
  win.addEventListener('pointerdown', (e) => {
    if (!emojiPanel.hidden && !emojiPanel.contains(e.target) && !emojiBtn.contains(e.target)) closeEmoji();
  });

  function renderRoom() {
    if (!st.room) return;
    renderTopic();
    renderPeople();
    renderCompose();
    renderHead();
  }

  // ── Server events ────────────────────────────────────────────────────────
  function enterRoom(room) {
    st.room = room;
    st.log = room.history.map((m) => ({ ...m }));
    st.peopleOpen = false;
    st.banner = '';
    session.set(RESUME_KEY, '1');
    renderLog();
    show('room');
  }

  function leftRoom(banner) {
    st.room = null;
    st.log = [];
    st.banner = banner || '';
    session.set(RESUME_KEY, null);
    if (st.view === 'room') show('lobby');
  }

  function onEvent(e) {
    switch (e.t) {
      case 'welcome':
        st.me = e.id;
        if (e.room) { if (!st.room || st.room.code !== e.room.code || st.view !== 'room') enterRoom(e.room); else { st.room = e.room; mergeHistory(e.room.history); renderRoom(); } }
        else {
          if (st.room) leftRoom('The room closed while you were away.');
          else session.set(RESUME_KEY, null);
          if (st.pendingCode && st.nick) { const code = st.pendingCode; st.pendingCode = null; join(code); }
          else if (st.view === 'lobby') show('lobby');
        }
        break;
      case 'lobby':
        st.lobby = e.rooms;
        if (st.view === 'lobby') renderLobby();
        break;
      case 'room':
        if (st.room?.code === e.room.code) { st.room = { ...e.room, history: [] }; renderRoom(); }
        break;
      case 'msg':
        if (st.room?.code !== e.room) break;
        appendLog(e.m);
        if (e.m.from.id !== st.me && (win.hidden || document.hidden)) { st.unread++; onUnread?.(st.unread); }
        break;
      case 'notice':
        if (st.room?.code === e.room) appendLog({ notice: e.text });
        break;
      case 'del': {
        if (st.room?.code !== e.room || !Number.isSafeInteger(e.n)) break;
        st.log = st.log.filter((m) => m.n !== e.n);
        log.querySelector(`[data-n="${e.n}"]`)?.remove();
        break;
      }
      case 'kicked':
        if (st.room?.code === e.room) leftRoom(e.by === 'sysop' ? 'The C64 READY admin removed you from the room.' : e.by === 'vote' ? 'The room voted to remove you.' : 'The host removed you from the room.');
        break;
      case 'closed':
        if (st.room?.code === e.room) leftRoom(e.reason === 'sysop' ? 'The C64 READY admin closed the room.' : e.reason === 'idle' ? 'The room closed after hours without messages.' : 'The room closed.');
        break;
      case 'banned':
        leftRoom('The C64 READY admin has banned this connection from the chat for a while.');
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
    if (s === 'replaced' && st.room) leftRoom('The chat was opened in another tab.');
    renderHead();
    if (st.view === 'room') renderCompose();
    if (st.view === 'lobby') renderLobby();
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  function submitNick() {
    const nick = joinNick.value.replace(/\s+/g, ' ').trim();
    if (!nick || [...nick].length > LIMITS.nick) { joinErr.textContent = ERRORS.NICK_INVALID; return; }
    joinErr.textContent = '';
    st.nick = nick;
    storage.set(NICK_KEY, nick);
    if (st.room) { show('room'); return; }
    if (conn.status === 'online' && st.pendingCode) { const code = st.pendingCode; st.pendingCode = null; join(code); return; }
    show('lobby');
    conn.connect();
  }

  async function create(name, topic) {
    lobbyErr.textContent = '';
    try {
      const r = await conn.request('create', { nick: st.nick, name: String(name || '').trim().slice(0, LIMITS.roomName), topic });
      newName.value = '';
      enterRoom(r.room);
    } catch (e) { lobbyErr.textContent = errorText(e); if (e.code === 'NICK_INVALID' || e.code === 'BLOCKED_WORD') show('join'); }
  }

  async function join(code) {
    lobbyErr.textContent = '';
    try {
      const r = await conn.request('join', { nick: st.nick, code });
      enterRoom(r.room);
    } catch (e) {
      // A nickname that room cannot take: pick another, and the join is tried again.
      if (e.code === 'NICK_TAKEN' || e.code === 'NICK_INVALID' || e.code === 'BLOCKED_WORD') { st.pendingCode = code; show('join'); joinErr.textContent = errorText(e); return; }
      if (st.view !== 'lobby') show('lobby');
      lobbyErr.textContent = errorText(e);
    }
  }

  async function send() {
    const text = say.value.trim();
    if (!text) return;
    try {
      await conn.request('say', { text });
      say.value = '';
      closeEmoji();
    } catch (e) { sayNote.hidden = false; sayNote.textContent = errorText(e); }
  }

  async function act(t, fields) {
    try { await conn.request(t, fields); } catch (e) { appendLog({ notice: errorText(e) }); }
  }

  async function kick(m) {
    if (await confirmDialog(`Remove ${m.nick} from the room? They cannot come back while it is open.`, { title: 'Remove', okLabel: 'REMOVE' })) act('kick', { member: m.id });
  }

  async function report(m) {
    const ok = await confirmDialog(`Report ${m.nick} to the C64 READY admin? The room's recent messages go with the report.`, { title: 'Report', okLabel: 'REPORT' });
    if (!ok) return;
    try { await conn.request('report', { member: m.id }); appendLog({ notice: `Thanks. ${m.nick} was reported. You can also hide or vote to remove them.` }); }
    catch (e) { appendLog({ notice: errorText(e) }); }
  }

  async function leave() {
    try { await conn.request('leave'); } catch { /* the server drops us anyway after the grace period */ }
    leftRoom('');
  }

  async function loadTopic(t) {
    try { await openAssembly64File(t.a64); renderTopic(); }
    catch (e) { appendLog({ notice: `Could not load it: ${e.message}` }); }
  }

  // ── Window: open, close, place ───────────────────────────────────────────
  const full = window.matchMedia?.(FULL_QUERY);
  let rect = (() => {
    try { const r = JSON.parse(storage.get(RECT_KEY) || 'null'); return r && [r.x, r.y, r.w, r.h].every(Number.isFinite) ? r : null; } catch { return null; }
  })();
  let pushedHistory = false;
  const layer = { close: () => close(), isOpen: () => !win.hidden };

  const clampRect = (r) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(Math.max(MIN_W, r.w), vw - 16);
    const hgt = Math.min(Math.max(MIN_H, r.h), vh - 16);
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
    const isFull = !!full?.matches;
    win.classList.toggle('is-full', isFull);
    if (isFull) { win.style.left = win.style.top = win.style.width = win.style.height = ''; syncViewport(); }
    else place(clampRect(rect || { w: 380, h: 540, x: window.innerWidth - 404, y: 80 }));
  }
  // A phone's keyboard shrinks the visual viewport, not the layout one: the window follows it.
  function syncViewport() {
    const vv = window.visualViewport;
    if (!vv || !win.classList.contains('is-full')) return;
    win.style.setProperty('--chat-vh', `${vv.height}px`);
    win.style.setProperty('--chat-top', `${vv.offsetTop}px`);
  }
  window.visualViewport?.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('scroll', syncViewport);
  full?.addEventListener?.('change', () => { if (!win.hidden) applyMode(); });
  window.addEventListener('resize', () => { if (!win.hidden && !win.classList.contains('is-full') && rect) place(clampRect(rect)); });
  // The phone's Back button closes the chat rather than leaving the app.
  window.addEventListener('popstate', () => { if (pushedHistory) { pushedHistory = false; if (!win.hidden) close(true); } });

  // Drag by the title bar and resize from the edges. The window's rect is read
  // once when a gesture starts, so moving the pointer never forces layout.
  let gesture = null;
  const startGesture = (e, dir) => {
    if (win.classList.contains('is-full') || e.button > 0) return;
    gesture = { dir, x0: e.clientX, y0: e.clientY, r: { ...rect } };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const moveGesture = (e) => {
    if (!gesture) return;
    const dx = e.clientX - gesture.x0, dy = e.clientY - gesture.y0, r = gesture.r, d = gesture.dir;
    let next;
    if (d === 'move') next = { ...r, x: r.x + dx, y: r.y + dy };
    else {
      next = { ...r };
      if (d.includes('e')) next.w = r.w + dx;
      if (d.includes('s')) next.h = r.h + dy;
      if (d.includes('w')) { const w = Math.max(MIN_W, r.w - dx); next.x = r.x + r.w - w; next.w = w; }
    }
    place(clampRect(next));
  };
  const endGesture = () => { if (!gesture) return; gesture = null; storage.set(RECT_KEY, JSON.stringify(rect)); };
  head.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) startGesture(e, 'move'); });
  for (const el of [head, ...handles]) {
    el.addEventListener('pointermove', moveGesture);
    el.addEventListener('pointerup', endGesture);
    el.addEventListener('pointercancel', endGesture);
  }
  for (const hd of handles) hd.addEventListener('pointerdown', (e) => startGesture(e, hd.dataset.dir));

  closeBtn.addEventListener('click', () => close());
  // Clicks inside stay inside: the app's own click handlers (focus the screen) must not fire.
  win.addEventListener('pointerdown', (e) => e.stopPropagation());
  window.addEventListener('c64-media', () => {
    if (win.hidden) return;
    if (st.view === 'lobby') renderLobby();
    else if (st.view === 'room') renderTopic();
  });

  function open() {
    const wasHidden = win.hidden;
    win.hidden = false;
    applyMode();
    if (wasHidden && win.classList.contains('is-full')) { history.pushState({ c64chat: true }, ''); pushedHistory = true; }
    pushEscapeLayer(layer);
    st.unread = 0;
    onUnread?.(0);
    onOpenChange?.(true);
    if (!st.nick) { show('join'); return; }
    conn.connect();
    show(st.room ? 'room' : 'lobby');
  }

  function close(fromHistory = false) {
    if (win.hidden) return;
    closeEmoji();
    win.hidden = true;
    popEscapeLayer(layer);
    if (pushedHistory && !fromHistory) { pushedHistory = false; history.back(); }
    onOpenChange?.(false);
    onClose?.();
  }

  return {
    open,
    close,
    toggle: () => (win.hidden ? open() : close()),
    isOpen: () => !win.hidden,
    /** Reconnect in the background after a reload, so the room and the unread count carry on. */
    resume() { if (conn.hasSession()) conn.connect(); },
    el: win,
  };
}
