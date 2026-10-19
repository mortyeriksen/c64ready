// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/admin/admin.js — the SYSOP console: every room, a live feed of every
// message, the reports and the bans, over the server's /admin/live socket.

const $ = (id) => document.getElementById(id);
const FEED_MAX = 500;

const rooms = new Map();     // code → room summary with history
let feed = [];               // { room, m } or { room, notice } across all rooms, oldest first
let reports = [];
let bans = [];
let selected = null;         // room code, or null for the live feed
let ws = null;
let nextId = 1;
let failures = 0;

function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function button(label, onClick, cls) {
  const b = el('button', label, cls);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
const time = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const roomName = (code) => rooms.get(code)?.name ?? code;

function act(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ...msg, id: nextId++ }));
}
function ban(addr, label) {
  const hours = Number(prompt(`Ban ${label} (${addr}) for how many hours? (1 to 720)`, '24'));
  if (!hours) return;
  const reason = prompt('Reason (only you see it)', '') ?? '';
  act({ t: 'ban', addr, hours, reason });
}

function pushFeed(entry) {
  feed.push(entry);
  if (feed.length > FEED_MAX) feed = feed.slice(-FEED_MAX);
}

// ── Rendering ──────────────────────────────────────────────────────────────
function renderStats() {
  let people = 0;
  for (const r of rooms.values()) people += r.members.length;
  $('stats').textContent = `${rooms.size} room${rooms.size === 1 ? '' : 's'} · ${people} in rooms · ${reports.length} report${reports.length === 1 ? '' : 's'}`;
}

function renderRooms() {
  const list = $('room-list');
  list.replaceChildren();
  $('all-rooms').setAttribute('aria-pressed', String(selected === null));
  const sorted = [...rooms.values()].sort((a, b) => b.members.length - a.members.length);
  for (const r of sorted) {
    const li = el('li');
    const b = button('', () => select(r.code), 'room-item');
    b.setAttribute('aria-pressed', String(selected === r.code));
    b.append(el('span', r.name));
    const n = reports.filter((x) => x.room.code === r.code).length;
    if (n) b.append(el('span', `${n} report${n === 1 ? '' : 's'}`, 'badge rep'));
    b.append(el('div', `${r.code} · ${r.members.length} here${r.topic ? ` · ${r.topic.title}` : ''}`, 'meta'));
    li.append(b);
    list.append(li);
  }
  renderStats();
}

function messageItem(code, m, withRoom) {
  const li = el('li', null, m.sysop ? 'is-sysop' : '');
  li.append(el('span', time(m.at), 'meta'));
  if (withRoom) li.append(el('span', `[${roomName(code)}]`, 'tag'));
  const member = rooms.get(code)?.members.find((x) => x.id === m.from.id);
  li.append(el('span', m.from.nick, 'who'));
  if (member) li.append(el('span', member.addr, 'addr'));
  li.append(el('span', m.text, 'text'));
  li.append(button('delete', () => act({ t: 'delete', room: code, n: m.n })));
  return li;
}

function renderFeed() {
  const list = $('feed');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.replaceChildren();
  if (selected === null) {
    for (const e of feed) {
      if (e.m) list.append(messageItem(e.room, e.m, true));
      else { const li = el('li'); li.append(el('span', `[${roomName(e.room)}]`, 'tag'), el('span', e.notice, 'notice')); list.append(li); }
    }
  } else {
    for (const m of rooms.get(selected)?.history ?? []) list.append(messageItem(selected, m, false));
  }
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function renderRoomHead() {
  const r = selected && rooms.get(selected);
  $('room-head').hidden = !r;
  $('say').hidden = !r;
  $('feed-h').textContent = r ? 'Messages' : 'Live feed';
  if (!r) return;
  $('room-name').textContent = r.name;
  $('room-meta').textContent = `${r.code}${r.topic ? ` · ${r.topic.title}` : ''} · opened ${time(r.createdAt)}`;
  const list = $('members');
  list.replaceChildren();
  for (const m of r.members) {
    const li = el('li', null, m.here ? '' : 'away');
    li.append(el('span', `${m.nick}${m.id === r.owner ? ' (host)' : ''}${m.muted ? ' (muted)' : ''}`), el('span', m.addr, 'addr'));
    li.append(button(m.muted ? 'unmute' : 'mute', () => act({ t: 'mute', room: r.code, member: m.id, on: !m.muted })));
    li.append(button('kick', () => act({ t: 'kick', room: r.code, member: m.id })));
    li.append(button('ban', () => ban(m.addr, m.nick), 'danger'));
    list.append(li);
  }
}

function renderReports() {
  const list = $('reports');
  list.replaceChildren();
  if (!reports.length) list.append(el('li', 'None.', 'meta'));
  for (const r of [...reports].reverse()) {
    const li = el('li');
    li.append(el('div', `${time(r.at)} · room "${r.room.name}" (${r.room.code})`, 'meta'));
    li.append(el('div', `${r.reporter.nick} reported ${r.target ? r.target.nick : 'the room'}`));
    const msgs = el('ul', null, 'report-msgs');
    for (const m of r.messages) msgs.append(el('li', `${m.from.nick}${m.addr ? ` [${m.addr}]` : ''}: ${m.text}`));
    li.append(msgs);
    const row = el('div', null, 'row');
    if (rooms.has(r.room.code)) row.append(button('open room', () => select(r.room.code)));
    if (r.target?.addr) row.append(button(`ban ${r.target.nick}`, () => ban(r.target.addr, r.target.nick), 'danger'));
    row.append(button('dismiss', () => act({ t: 'dismiss', report: r.id })));
    li.append(row);
    list.append(li);
  }
}

function renderBans() {
  const list = $('bans');
  list.replaceChildren();
  if (!bans.length) list.append(el('li', 'None.', 'meta'));
  for (const b of bans) {
    const li = el('li');
    li.append(el('div', `${b.addr} until ${new Date(b.until).toLocaleString()}`));
    if (b.reason) li.append(el('div', b.reason, 'meta'));
    li.append(button('unban', () => act({ t: 'unban', addr: b.addr })));
    list.append(li);
  }
}

function renderAll() { renderRooms(); renderRoomHead(); renderFeed(); renderReports(); renderBans(); }

function select(code) {
  selected = code;
  renderAll();
}

// ── Live socket ────────────────────────────────────────────────────────────
function onEvent(e) {
  switch (e.t) {
    case 'snapshot':
      rooms.clear();
      feed = [];
      for (const r of e.rooms) {
        rooms.set(r.code, r);
        for (const m of r.history) pushFeed({ room: r.code, m });
      }
      feed.sort((a, b) => a.m.at - b.m.at);
      reports = e.reports;
      bans = e.bans;
      if (selected && !rooms.has(selected)) selected = null;
      renderAll();
      break;
    case 'room': {
      const old = rooms.get(e.room.code);
      rooms.set(e.room.code, { ...e.room, history: old?.history ?? [] });
      renderRooms();
      if (selected === e.room.code) renderRoomHead();
      break;
    }
    case 'closed':
      pushFeed({ room: e.room, notice: `room closed (${e.reason})` });
      if (selected === e.room) selected = null;
      renderFeed();
      rooms.delete(e.room);
      renderAll();
      break;
    case 'msg': {
      const r = rooms.get(e.room);
      if (r) { r.history.push(e.m); if (r.history.length > 50) r.history.shift(); }
      pushFeed({ room: e.room, m: e.m });
      if (selected === null || selected === e.room) renderFeed();
      break;
    }
    case 'del': {
      const r = rooms.get(e.room);
      if (r) r.history = r.history.filter((m) => m.n !== e.n);
      feed = feed.filter((x) => !(x.room === e.room && x.m?.n === e.n));
      renderFeed();
      break;
    }
    case 'notice':
      pushFeed({ room: e.room, notice: e.text });
      if (selected === null) renderFeed();
      break;
    case 'report':
      reports.push(e.report);
      renderReports(); renderRooms();
      break;
    case 'reports':
      reports = e.reports;
      renderReports(); renderRooms();
      break;
    case 'bans':
      bans = e.bans;
      renderBans();
      break;
    case 'err':
      $('stats').textContent = `Action refused: ${e.code}`;
      break;
  }
}

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/admin/live`);
  ws.addEventListener('open', () => { failures = 0; });
  ws.addEventListener('message', (m) => { try { onEvent(JSON.parse(m.data)); } catch { /* ignore a bad event */ } });
  ws.addEventListener('close', () => {
    $('stats').textContent = 'disconnected, retrying…';
    // A refused socket usually means the console cookie expired: reloading asks for the password again.
    if (++failures >= 3) location.reload();
    else setTimeout(connect, 2000);
  });
}

$('all-rooms').addEventListener('click', () => select(null));
$('close-room').addEventListener('click', () => {
  if (selected && confirm(`Close room "${roomName(selected)}" for everyone?`)) act({ t: 'close', room: selected });
});
$('say').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('say-text').value.trim();
  if (!text || !selected) return;
  act({ t: 'say', room: selected, text });
  $('say-text').value = '';
});
connect();
