// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/chat.mjs — the chat: guest sessions, rooms held in memory, the lobby
// that lists every room for anyone to join, moderation by each room's members,
// and the admin's live view. A room and its last messages go when its last
// member leaves (or has been gone for the grace period), or when the process
// restarts. With a chat log (server/log.mjs), every message and every join,
// leave and moderation step is also written there, with the IP address.
//
// Wire format: JSON text frames. A client request is { t, id?, ...fields } and
// is answered { t: 'ok', id, ... } or { t: 'err', id, code }. Pushed events:
// welcome, lobby, room, msg, del, notice, kicked, closed, banned, replaced.

import crypto from 'node:crypto';
import fs from 'node:fs';
import nodePath from 'node:path';
import { acceptWebSocket, refuseUpgrade } from './ws.mjs';
import { clientAddress, addressKey, addressHasher, isLoopbackOrigin, Bucket, Admission } from './address.mjs';
import {
  PROTOCOL, LIMITS, CODE_ALPHABET, CODE_LENGTH, cleanText, cleanName, cleanTopic, isReservedNick,
  isRoomCode, topicKey, wordFilter,
} from './protocol.mjs';
import { createAdminGate, adminAsset, ADMIN_HEADERS } from './admin.mjs';
import { isLogFile } from './log.mjs';

export const DEFAULTS = Object.freeze({
  helloTimeoutMs: 5000,
  graceMs: 60_000,
  idleRoomMs: 4 * 3600_000,
  maxRoomMs: 24 * 3600_000,
  unusedSessionMs: 5 * 60_000,
  pingMs: 25_000,
  maxSessions: 5000,
  maxConnections: 2000,
  maxRooms: 500,
  maxReports: 200,
  lobbySize: 200,
});

class ChatError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new ChatError(code); };

/**
 * @param {object} o
 * @param {string[]} [o.origins]        sites whose pages may connect (pages on this computer always may)
 * @param {number} [o.trustProxy]       proxies in front that append X-Forwarded-For (Railway: 2)
 * @param {{user: string, passwordSha256: string}|null} [o.admin]   enables /admin
 * @param {(text: string) => void} [o.notify]   told about each report
 * @param {string[]} [o.blockedWords]
 * @param {ReturnType<import('./log.mjs').createChatLog>|null} [o.chatLog]   where events are logged
 * @param {() => number} [o.now]
 * @param {boolean} [o.manualClock]     no timer: the caller runs tick() (tests)
 * @param {Partial<typeof DEFAULTS>} [o.limits]
 */
export function createChatServer({
  origins = [], trustProxy = 0, admin = null, notify = null, blockedWords = [], chatLog = null,
  now = Date.now, manualClock = false, limits = {}, log = () => {},
} = {}) {
  const L = { ...DEFAULTS, ...limits };
  const words = wordFilter(blockedWords);
  const hashAddr = addressHasher();
  const gate = admin ? createAdminGate({ ...admin, now }) : null;
  const admission = new Admission({ rate: 2, burst: 10, globalRate: 50, globalBurst: 100, now });

  const sessions = new Map();   // token → session
  const byId = new Map();       // public id → session
  const rooms = new Map();      // code → room
  const conns = new Set();      // every open socket, users and admins
  const pending = new Set();    // user sockets that have not said hello
  const lobbySubs = new Set();  // sessions watching the lobby
  const adminConns = new Set();
  const bans = new Map();       // address id → { addr, until, reason, at }
  let reports = [];
  let lobbyDirty = false;
  let lastPing = now();
  let lastLogSweep = now();

  const randomId = (bytes) => crypto.randomBytes(bytes).toString('hex');
  const record = (event) => { try { chatLog?.write(event); } catch (e) { log(`chat log: ${e.message}`); } };
  const who = (s, nick) => ({ id: s.id, nick: nick ?? s.room?.members.get(s.id)?.nick ?? s.nick, ip: s.ip });
  const send = (conn, msg) => conn?.send(JSON.stringify(msg));

  // ── Views ────────────────────────────────────────────────────────────────
  const memberView = (room, m) => ({ id: m.id, nick: m.nick, muted: m.muted, here: m.connected, votes: voteCount(room, m), need: votesNeeded(room, m) });
  const roomView = (room) => ({
    code: room.code, name: room.name, topic: room.topic, key: room.key,
    owner: room.owner, createdAt: room.createdAt, members: [...room.members.values()].map((m) => memberView(room, m)),
  });
  const joinView = (room) => ({ ...roomView(room), history: room.history });
  const adminSummary = (room) => ({
    ...roomView(room), lastMessageAt: room.lastMessageAt,
    members: [...room.members.values()].map((m) => ({ ...memberView(room, m), addr: m.session.addrId })),
  });
  const lobbyState = () => ({
    t: 'lobby',
    rooms: [...rooms.values()]
      .sort((a, b) => b.members.size - a.members.size || b.createdAt - a.createdAt)
      .slice(0, L.lobbySize)
      .map((r) => ({ code: r.code, name: r.name, topic: r.topic, key: r.key, count: r.members.size })),
    online: [...rooms.values()].flatMap((r) => [...r.members.values()].filter((m) => m.connected).map((m) => m.nick)),
  });
  const banList = () => [...bans.values()];

  // ── Fan-out ──────────────────────────────────────────────────────────────
  function broadcast(room, msg) {
    const data = JSON.stringify(msg);
    for (const m of room.members.values()) m.session.conn?.send(data);
  }
  function adminBroadcast(msg) {
    if (!adminConns.size) return;
    const data = JSON.stringify(msg);
    for (const c of adminConns) c.send(data);
  }
  function pushRoom(room) {
    broadcast(room, { t: 'room', room: roomView(room) });
    adminBroadcast({ t: 'room', room: adminSummary(room) });
    lobbyDirty = true;
  }
  function notice(room, text) {
    broadcast(room, { t: 'notice', room: room.code, text });
    adminBroadcast({ t: 'notice', room: room.code, text });
  }
  function addMessage(room, from, text, sysop = false) {
    const m = { n: ++room.n, from, text, at: now() };
    if (sysop) m.sysop = true;
    room.history.push(m);
    if (room.history.length > LIMITS.history) room.history.shift();
    room.lastMessageAt = m.at;
    broadcast(room, { t: 'msg', room: room.code, m });
    adminBroadcast({ t: 'msg', room: room.code, m });
    return m;
  }

  // ── Rooms ────────────────────────────────────────────────────────────────
  function newCode() {
    for (;;) {
      const bytes = crypto.randomBytes(CODE_LENGTH);
      let code = '';
      for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (!rooms.has(code)) return code;
    }
  }
  function addMember(room, s, nick) {
    // A mute outlives the membership, like a kick: leaving and coming back keeps it.
    const muted = room.mutedIds.has(s.id) || room.mutedAddr.has(s.addrId);
    room.members.set(s.id, { id: s.id, session: s, nick, joinedAt: now(), muted, connected: !!s.conn, goneAt: s.conn ? null : now() });
    s.room = room;
  }
  // Muting a member mutes their session and their address for the room's
  // lifetime, and so every member at that address, now and when they rejoin.
  function setMuted(room, m, on) {
    const addr = m.session.addrId;
    if (on) { room.mutedIds.add(m.id); room.mutedAddr.add(addr); }
    else { room.mutedIds.delete(m.id); room.mutedAddr.delete(addr); }
    for (const x of room.members.values()) if (x.id === m.id || x.session.addrId === addr) x.muted = on;
  }
  function transferOwner(room) {
    const all = [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    const next = all.find((m) => m.connected) || all[0];
    room.owner = next.id;
    notice(room, `${next.nick} is now the host`);
  }
  function removeMember(room, id, text) {
    const m = room.members.get(id);
    if (!m) return;
    room.members.delete(id);
    if (m.session.room === room) m.session.room = null;
    room.votes.delete(id);
    for (const voters of room.votes.values()) voters.delete(id);
    if (!room.members.size) { closeRoom(room, 'empty'); return; }
    if (room.owner === id) transferOwner(room);
    if (text) notice(room, text);
    pushRoom(room);
  }
  function kickMember(room, id, by) {
    const m = room.members.get(id);
    if (!m) return;
    room.banned.add(id);
    room.bannedAddr.add(m.session.addrId);
    record({ ev: 'kick', room: room.code, by, ...who(m.session, m.nick) });
    send(m.session.conn, { t: 'kicked', room: room.code, by });
    const how = by === 'vote' ? ' by vote' : by === 'sysop' ? ' by SYSOP' : '';
    removeMember(room, id, `${m.nick} was removed${how}`);
  }
  function closeRoom(room, reason) {
    if (room.closed) return;
    room.closed = true;
    record({ ev: 'closed', room: room.code, reason });
    rooms.delete(room.code);
    for (const m of room.members.values()) {
      if (m.session.room === room) m.session.room = null;
      send(m.session.conn, { t: 'closed', room: room.code, reason });
    }
    room.members.clear();
    lobbyDirty = true;
    adminBroadcast({ t: 'closed', room: room.code, reason });
  }
  function leaveCurrent(s) {
    if (s.room) record({ ev: 'leave', room: s.room.code, ...who(s) });
    if (s.room) removeMember(s.room, s.id, `${s.room.members.get(s.id)?.nick ?? 'Someone'} left`);
  }
  // Votes are counted by address, not by session, so one person with several
  // connections is one voter, and nobody at the target's own address counts.
  // Removing someone takes a majority of the other addresses present, and never
  // fewer than two: a lone newcomer cannot vote anyone out, the host included.
  function votesNeeded(room, target) {
    const here = new Set();
    for (const m of room.members.values()) if (m.connected && m.session.addrId !== target.session.addrId) here.add(m.session.addrId);
    return Math.max(2, Math.floor(here.size / 2) + 1);
  }
  function voteCount(room, target) {
    const addrs = new Set();
    for (const id of room.votes.get(target.id) ?? []) {
      const addr = room.members.get(id)?.session.addrId;
      if (addr && addr !== target.session.addrId) addrs.add(addr);
    }
    return addrs.size;
  }

  function validNick(value) {
    const nick = cleanName(value, LIMITS.nick);
    if (!nick || isReservedNick(nick)) fail('NICK_INVALID');
    if (words.blocks(nick)) fail('BLOCKED_WORD');
    return nick;
  }
  function memberOf(s) {
    const room = s.room;
    if (!room) fail('NOT_IN_ROOM');
    return { room, me: room.members.get(s.id) };
  }
  function ownerOf(s) {
    const r = memberOf(s);
    if (r.room.owner !== s.id) fail('NOT_OWNER');
    return r;
  }
  function targetIn(room, id, s) {
    const target = typeof id === 'string' ? room.members.get(id) : null;
    if (!target) fail('NOT_FOUND');
    if (target.id === s.id) fail('BAD_REQUEST');
    return target;
  }

  // ── Requests from the app ────────────────────────────────────────────────
  const HANDLERS = {
    lobby(s, msg) {
      if (msg.on === false) { lobbySubs.delete(s); return {}; }
      lobbySubs.add(s);
      send(s.conn, lobbyState());
      return {};
    },
    create(s, msg) {
      const nick = validNick(msg.nick);
      const name = cleanName(msg.name, LIMITS.roomName);
      if (!name) fail('NAME_INVALID');
      const topic = msg.topic == null ? null : cleanTopic(msg.topic);
      if (words.blocks(name) || (topic && words.blocks(topic.title))) fail('BLOCKED_WORD');
      if (!s.createBucket.take()) fail('RATE_LIMITED');
      if (rooms.size >= L.maxRooms) fail('TOO_MANY_ROOMS');
      leaveCurrent(s);
      const t = now();
      const room = {
        code: newCode(), name, topic, key: topicKey(topic), owner: s.id,
        members: new Map(), votes: new Map(), banned: new Set(), bannedAddr: new Set(), mutedIds: new Set(), mutedAddr: new Set(),
        history: [], n: 0, createdAt: t, lastMessageAt: t, closed: false,
      };
      rooms.set(room.code, room);
      addMember(room, s, nick);
      record({ ev: 'create', room: room.code, name, topic: topic?.title ?? null, ...who(s, nick) });
      lobbyDirty = true;
      adminBroadcast({ t: 'room', room: adminSummary(room) });
      return { room: joinView(room) };
    },
    join(s, msg) {
      const room = isRoomCode(msg.code) ? rooms.get(msg.code) : null;
      if (!room) fail('NOT_FOUND');
      if (s.room === room) return { room: joinView(room) };
      if (room.banned.has(s.id) || room.bannedAddr.has(s.addrId)) fail('BANNED');
      if (room.members.size >= LIMITS.roomSize) fail('FULL');
      const nick = validNick(msg.nick);
      const folded = nick.toLowerCase();
      for (const m of room.members.values()) if (m.nick.toLowerCase() === folded) fail('NICK_TAKEN');
      leaveCurrent(s);
      addMember(room, s, nick);
      record({ ev: 'join', room: room.code, ...who(s, nick) });
      notice(room, `${nick} joined`);
      pushRoom(room);
      return { room: joinView(room) };
    },
    leave(s) {
      leaveCurrent(s);
      return {};
    },
    say(s, msg) {
      const { room, me } = memberOf(s);
      if (me.muted) fail('MUTED');
      const text = cleanText(msg.text);
      if (!text) fail('TEXT_INVALID');
      if (!s.sayBucket.take()) fail('RATE_LIMITED');
      const m = addMessage(room, { id: s.id, nick: me.nick }, words.mask(text));
      // The words as written, before any are starred out.
      record({ ev: 'msg', room: room.code, n: m.n, ...who(s, me.nick), text });
      return { n: m.n };
    },
    kick(s, msg) {
      const { room } = ownerOf(s);
      kickMember(room, targetIn(room, msg.member, s).id, 'owner');
      return {};
    },
    mute(s, msg) {
      const { room } = ownerOf(s);
      const target = targetIn(room, msg.member, s);
      setMuted(room, target, !!msg.on);
      record({ ev: 'mute', room: room.code, on: target.muted, by: s.id, ...who(target.session, target.nick) });
      pushRoom(room);
      return {};
    },
    vote(s, msg) {
      const { room } = memberOf(s);
      const target = targetIn(room, msg.member, s);
      let voters = room.votes.get(target.id);
      if (!voters) room.votes.set(target.id, voters = new Set());
      voters.add(s.id);
      record({ ev: 'vote', room: room.code, target: target.id, ...who(s) });
      if (voteCount(room, target) >= votesNeeded(room, target)) kickMember(room, target.id, 'vote');
      else pushRoom(room);
      return {};
    },
    report(s, msg) {
      const { room, me } = memberOf(s);
      if (!s.reportBucket.take()) fail('RATE_LIMITED');
      const wanted = Array.isArray(msg.messages) ? new Set(msg.messages.filter(Number.isSafeInteger).slice(0, LIMITS.reportMessages)) : null;
      const picked = wanted?.size ? room.history.filter((m) => wanted.has(m.n)) : room.history.slice(-LIMITS.reportMessages);
      const target = typeof msg.member === 'string' ? (room.members.get(msg.member)?.session ?? byId.get(msg.member)) : null;
      const report = {
        id: randomId(4), at: now(), room: { code: room.code, name: room.name },
        reporter: { id: s.id, nick: me.nick, addr: s.addrId },
        target: target ? { id: target.id, nick: room.members.get(target.id)?.nick ?? target.nick, addr: target.addrId } : null,
        messages: picked.map((m) => ({ ...m, addr: byId.get(m.from.id)?.addrId ?? null })),
      };
      reports.push(report);
      if (reports.length > L.maxReports) reports.shift();
      record({ ev: 'report', room: room.code, report: report.id, target: report.target?.id ?? null, ...who(s, me.nick) });
      adminBroadcast({ t: 'report', report });
      try { notify?.(`C64 READY chat: a report from room "${room.name}". Open the admin console.`); } catch { /* best effort */ }
      return {};
    },
  };

  function newSession(conn) {
    const s = {
      token: crypto.randomBytes(18).toString('base64url'), id: randomId(4),
      addrKey: conn.addrKey, addrId: conn.addrId, ip: conn.ip, conn: null, room: null, nick: '',
      disconnectedAt: null,
      events: new Bucket(20, 60, now),
      sayBucket: new Bucket(1, 5, now),
      createBucket: new Bucket(1 / 30, 3, now),
      reportBucket: new Bucket(1 / 60, 3, now),
    };
    sessions.set(s.token, s);
    byId.set(s.id, s);
    return s;
  }
  function deleteSession(s) {
    if (s.room) removeMember(s.room, s.id, `${s.room.members.get(s.id)?.nick ?? 'Someone'} left`);
    lobbySubs.delete(s);
    sessions.delete(s.token);
    byId.delete(s.id);
  }

  function hello(conn, msg) {
    if (msg.v !== PROTOCOL) { send(conn, { t: 'err', code: 'OLD_CLIENT' }); conn.close(4000, 'old client'); return; }
    let s = typeof msg.token === 'string' ? sessions.get(msg.token) : null;
    if (s && s.conn && s.conn !== conn) {
      const old = s.conn;
      send(old, { t: 'replaced' });
      old.close(4001, 'replaced');
    }
    if (!s) {
      if (sessions.size >= L.maxSessions) { conn.close(1013, 'full'); return; }
      s = newSession(conn);
    }
    s.conn = conn;
    s.addrKey = conn.addrKey;
    s.addrId = conn.addrId;
    s.ip = conn.ip;
    record({ ev: 'connect', id: s.id, ip: s.ip });
    s.disconnectedAt = null;
    conn.session = s;
    pending.delete(conn);
    const m = s.room?.members.get(s.id);
    if (m) { m.connected = true; m.goneAt = null; }
    send(conn, { t: 'welcome', v: PROTOCOL, token: s.token, id: s.id, room: s.room ? joinView(s.room) : null });
    if (m) pushRoom(s.room);
  }

  function disconnected(s) {
    s.conn = null;
    s.disconnectedAt = now();
    lobbySubs.delete(s);
    const m = s.room?.members.get(s.id);
    if (m) { m.connected = false; m.goneAt = now(); pushRoom(s.room); }
  }

  function onUserMessage(conn, text) {
    let msg;
    try { msg = JSON.parse(text); } catch { conn.close(1008, 'bad message'); return; }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') { conn.close(1008, 'bad message'); return; }
    const s = conn.session;
    if (!(s ? s.events : conn.events).take()) return;
    if (!s) {
      if (msg.t === 'hello') hello(conn, msg);
      else conn.close(1008, 'hello first');
      return;
    }
    const id = typeof msg.id === 'number' || (typeof msg.id === 'string' && msg.id.length <= 32) ? msg.id : undefined;
    const handler = Object.hasOwn(HANDLERS, msg.t) ? HANDLERS[msg.t] : null;
    try {
      if (!handler) fail('BAD_REQUEST');
      const out = handler(s, msg);
      if (id !== undefined) send(conn, { t: 'ok', id, ...out });
    } catch (e) {
      if (!(e instanceof ChatError)) log(`chat: ${msg.t} failed: ${e.stack || e}`);
      if (id !== undefined) send(conn, { t: 'err', id, code: e instanceof ChatError ? e.code : 'INTERNAL' });
    }
  }

  function allowedOrigin(origin) {
    return origin === undefined || origins.includes(origin) || isLoopbackOrigin(origin);
  }

  function userUpgrade(req, sock, head) {
    if (!allowedOrigin(req.headers.origin)) { refuseUpgrade(sock, 403, 'Forbidden'); return; }
    const ip = clientAddress(req, trustProxy);
    const key = addressKey(ip);
    const addrId = hashAddr(key);
    const ban = bans.get(addrId);
    if (ban && ban.until > now()) { refuseUpgrade(sock, 403, 'Forbidden'); return; }
    if (conns.size >= L.maxConnections) { refuseUpgrade(sock, 503, 'Service Unavailable'); return; }
    if (!admission.take(key)) { refuseUpgrade(sock, 429, 'Too Many Requests'); return; }
    const conn = acceptWebSocket(req, sock, head, { maxPayload: 4096 });
    if (!conn) return;
    conn.ip = ip;
    conn.addrKey = key;
    conn.addrId = addrId;
    conn.session = null;
    conn.events = new Bucket(5, 10, now);
    conn.deadline = now() + L.helloTimeoutMs;
    conns.add(conn);
    pending.add(conn);
    conn.onmessage = (text) => onUserMessage(conn, text);
    conn.onclose = () => {
      conns.delete(conn);
      pending.delete(conn);
      const s = conn.session;
      if (s && s.conn === conn) disconnected(s);
    };
  }

  // ── Admin ────────────────────────────────────────────────────────────────
  function banAddress(addr, hours, reason) {
    bans.set(addr, { addr, until: now() + hours * 3600_000, reason, at: now() });
    record({ ev: 'ban', addr, hours, reason });
    for (const s of [...sessions.values()]) {
      if (s.addrId !== addr) continue;
      record({ ev: 'banned', ...who(s) });
      if (s.room) kickMember(s.room, s.id, 'sysop');
      send(s.conn, { t: 'banned' });
      s.conn?.close(4003, 'banned');
      deleteSession(s);
    }
    for (const c of [...pending]) if (c.addrId === addr) c.close(4003, 'banned');
    adminBroadcast({ t: 'bans', bans: banList() });
  }

  const ADMIN_ACTIONS = {
    delete(msg) {
      const room = rooms.get(msg.room) ?? fail('NOT_FOUND');
      const at = room.history.findIndex((m) => m.n === msg.n);
      if (at < 0) fail('NOT_FOUND');
      room.history.splice(at, 1);
      record({ ev: 'delete', room: room.code, n: msg.n, by: 'sysop' });
      broadcast(room, { t: 'del', room: room.code, n: msg.n });
      adminBroadcast({ t: 'del', room: room.code, n: msg.n });
    },
    kick(msg) {
      const room = rooms.get(msg.room) ?? fail('NOT_FOUND');
      if (!room.members.has(msg.member)) fail('NOT_FOUND');
      kickMember(room, msg.member, 'sysop');
    },
    mute(msg) {
      const room = rooms.get(msg.room) ?? fail('NOT_FOUND');
      const m = room.members.get(msg.member) ?? fail('NOT_FOUND');
      setMuted(room, m, !!msg.on);
      record({ ev: 'mute', room: room.code, on: m.muted, by: 'sysop', ...who(m.session, m.nick) });
      pushRoom(room);
    },
    close(msg) {
      const room = rooms.get(msg.room) ?? fail('NOT_FOUND');
      closeRoom(room, 'sysop');
    },
    say(msg) {
      const room = rooms.get(msg.room) ?? fail('NOT_FOUND');
      const text = cleanText(msg.text) ?? fail('TEXT_INVALID');
      const m = addMessage(room, { id: 'sysop', nick: 'SYSOP' }, text, true);
      record({ ev: 'msg', room: room.code, n: m.n, id: 'sysop', nick: 'SYSOP', ip: null, text });
    },
    ban(msg) {
      if (typeof msg.addr !== 'string' || !/^[0-9a-f]{12}$/.test(msg.addr)) fail('BAD_REQUEST');
      const hours = Math.min(720, Math.max(1, Math.round(Number(msg.hours) || 24)));
      banAddress(msg.addr, hours, cleanText(msg.reason ?? '', 100) ?? '');
    },
    unban(msg) {
      bans.delete(msg.addr);
      record({ ev: 'unban', addr: msg.addr });
      adminBroadcast({ t: 'bans', bans: banList() });
    },
    dismiss(msg) {
      reports = reports.filter((r) => r.id !== msg.report);
      adminBroadcast({ t: 'reports', reports });
    },
  };

  function onAdminMessage(conn, text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      if (!Object.hasOwn(ADMIN_ACTIONS, msg.t)) fail('BAD_REQUEST');
      ADMIN_ACTIONS[msg.t](msg);
      send(conn, { t: 'ok', id: msg.id });
    } catch (e) {
      if (!(e instanceof ChatError)) log(`chat admin: ${msg.t} failed: ${e.stack || e}`);
      send(conn, { t: 'err', id: msg.id, code: e instanceof ChatError ? e.code : 'INTERNAL' });
    }
  }

  function adminUpgrade(req, sock, head) {
    if (!gate) { refuseUpgrade(sock, 404, 'Not Found'); return; }
    if (!gate.tokenFrom(req)) { refuseUpgrade(sock, 401, 'Unauthorized'); return; }
    let sameHost = false;
    try { sameHost = new URL(req.headers.origin).host === req.headers.host; } catch { /* no or bad Origin */ }
    if (!sameHost) { refuseUpgrade(sock, 403, 'Forbidden'); return; }
    const conn = acceptWebSocket(req, sock, head, { maxPayload: 16384, maxBuffered: 8 << 20 });
    if (!conn) return;
    conns.add(conn);
    adminConns.add(conn);
    conn.onmessage = (text) => onAdminMessage(conn, text);
    conn.onclose = () => { conns.delete(conn); adminConns.delete(conn); };
    send(conn, {
      t: 'snapshot', now: now(),
      rooms: [...rooms.values()].map((r) => ({ ...adminSummary(r), history: r.history })),
      bans: banList(), reports,
    });
  }

  // The console's Logs page lists the log files to download, one per day.
  function logRoute(path) {
    if (path === '/admin/logs' || path === '/admin/logs/') return { list: true };
    const m = /^\/admin\/logs\/([^/]+)$/.exec(path);
    return m && chatLog && isLogFile(m[1]) ? { file: m[1] } : null;
  }
  function logsPage() {
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const files = chatLog ? chatLog.files() : [];
    const rows = files.map((f) => `<li><a href="/admin/logs/${esc(f.name)}" download>${esc(f.name)}</a> <span class="meta">${Math.ceil(f.size / 1024)} KB</span></li>`).join('');
    const note = chatLog
      ? `One file per day (UTC), kept ${chatLog.days} days. Each line is one event as JSON: messages, joins, leaves and moderation, with the IP address.`
      : 'Logging is off. Set CHAT_LOG_DIR to a persistent directory to turn it on.';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Chat logs</title>`
      + `<link rel="stylesheet" href="/admin/admin.css"></head><body class="logs"><h1>Chat logs</h1><p class="meta">${esc(note)}</p>`
      + `<ul class="list">${rows || '<li class="meta">No log files yet.</li>'}</ul><p><a href="/admin">Back to the console</a></p></body></html>`;
  }

  function serveAdmin(req, res, path) {
    if (!gate) return false;
    const asset = adminAsset(path);
    const logs = asset ? null : logRoute(path);
    if (!asset && !logs) return false;
    const verdict = gate.authorize(req, addressKey(clientAddress(req, trustProxy)));
    if (verdict === 'limited') { res.writeHead(429, { 'Retry-After': '600', ...ADMIN_HEADERS }).end(); return true; }
    if (verdict !== 'ok') {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="C64 READY chat admin", charset="UTF-8"', ...ADMIN_HEADERS }).end();
      return true;
    }
    if (logs?.list) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...ADMIN_HEADERS }).end(logsPage()); return true; }
    if (logs?.file) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="${logs.file}"`, ...ADMIN_HEADERS });
      fs.createReadStream(nodePath.join(chatLog.dir, logs.file)).on('error', () => res.end()).pipe(res);
      return true;
    }
    const headers = { 'Content-Type': asset.type, ...ADMIN_HEADERS };
    if (asset.page) {
      const secure = !!req.socket.encrypted || (trustProxy > 0 && req.headers['x-forwarded-proto'] === 'https');
      headers['Set-Cookie'] = gate.cookie(gate.issueToken(), secure);
    }
    res.writeHead(200, headers).end(asset.body);
    return true;
  }

  // ── Housekeeping ─────────────────────────────────────────────────────────
  function tick() {
    const t = now();
    for (const c of [...pending]) if (t >= c.deadline) c.close(4002, 'hello timeout');
    if (t - lastPing >= L.pingMs) {
      lastPing = t;
      for (const c of [...conns]) c.ping();
    }
    for (const room of [...rooms.values()]) {
      for (const m of [...room.members.values()]) {
        if (!m.connected && t - m.goneAt >= L.graceMs) {
          record({ ev: 'leave', room: room.code, gone: true, ...who(m.session, m.nick) });
          removeMember(room, m.id, `${m.nick} left`);
        }
      }
      if (room.closed) continue;
      if (t - room.lastMessageAt >= L.idleRoomMs) closeRoom(room, 'idle');
      else if (t - room.createdAt >= L.maxRoomMs) closeRoom(room, 'expired');
    }
    for (const s of [...sessions.values()]) {
      if (!s.conn && !s.room && t - s.disconnectedAt >= L.unusedSessionMs) deleteSession(s);
    }
    let bansChanged = false;
    for (const [addr, ban] of bans) if (ban.until <= t) { bans.delete(addr); bansChanged = true; }
    if (bansChanged) adminBroadcast({ t: 'bans', bans: banList() });
    gate?.sweep();
    admission.sweep();
    if (chatLog && t - lastLogSweep >= 3600_000) { lastLogSweep = t; chatLog.sweep(); }
    if (lobbyDirty) {
      lobbyDirty = false;
      if (lobbySubs.size) {
        const data = JSON.stringify(lobbyState());
        for (const s of lobbySubs) s.conn?.send(data);
      }
    }
  }
  const timer = manualClock ? null : setInterval(tick, 1000);
  timer?.unref?.();

  return {
    /** Handles /chat and /admin/live upgrades; returns false for any other path. */
    handleUpgrade(req, sock, head) {
      const path = String(req.url || '').split('?')[0];
      if (path === '/chat') { userUpgrade(req, sock, head); return true; }
      if (path === '/admin/live') { adminUpgrade(req, sock, head); return true; }
      return false;
    },
    /** Handles /health and the admin pages; returns false for any other path. */
    handleRequest(req, res) {
      const path = String(req.url || '').split('?')[0];
      if (req.method !== 'GET' && req.method !== 'HEAD') return false;
      if (path === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('ok'); return true; }
      return serveAdmin(req, res, path);
    },
    tick,
    stats: () => ({ sessions: sessions.size, connections: conns.size, rooms: rooms.size }),
    close() {
      if (timer) clearInterval(timer);
      for (const c of [...conns]) c.close(1001, 'server stopping');
    },
  };
}
