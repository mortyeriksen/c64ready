// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/chat.mjs — the chat: one channel for everyone, for signed-in accounts
// (the account's name is the name in the chat). A message can mention games
// with achievements (`@Bomb Jack`); unlocks and new best scores go to the
// activity feed (server/games.mjs), not here. Members vote out a member (a majority of the other addresses
// present, for an hour), and the admin's live view mutes, removes, bans and
// deletes. The last messages are held in memory, so a restart clears them. With a chat log (server/log.mjs), every message and every join,
// leave and moderation step is also written there, with the IP address.
//
// Wire format: JSON text frames. A client request is { t, id?, ...fields } and
// is answered { t: 'ok', id, ... } or { t: 'err', id, code }. Pushed events:
// welcome, room, msg, del, notice, kicked, banned, replaced.

import crypto from 'node:crypto';
import fs from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';
import { acceptWebSocket, refuseUpgrade } from './ws.mjs';
import { clientAddress, addressKey, addressHasher, isLoopbackOrigin, Bucket, Admission } from './address.mjs';
import {
  PROTOCOL, LIMITS, cleanText, cleanMentions, mentions, wordFilter,
} from './protocol.mjs';
import { createAdminGate, adminAsset, ADMIN_HEADERS } from './admin.mjs';
import { createBans } from './bans.mjs';
import net from 'node:net';
import { isLogFile } from './log.mjs';

export const DEFAULTS = Object.freeze({
  helloTimeoutMs: 5000,
  graceMs: 60_000,
  voteBanMs: 3600_000,
  unusedSessionMs: 5 * 60_000,
  pingMs: 25_000,
  maxSessions: 5000,
  maxConnections: 2000,
  maxReports: 200,
});

class ChatError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new ChatError(code); };

/**
 * @param {object} o
 * @param {string[]} [o.origins]        sites whose pages may connect
 * @param {boolean} [o.allowLoopback]   pages on this computer may connect too (the dev server)
 * @param {number} [o.trustProxy]       proxies in front that append X-Forwarded-For (Railway: 2)
 * @param {{passkeys: object, setupKeySha256?: string, keyUsed?: Function, useKey?: Function}|null} [o.admin]   enables /admin
 * @param {(text: string) => void} [o.notify]   told about each report
 * @param {string[]} [o.blockedWords]
 * @param {ReturnType<import('./log.mjs').createChatLog>|null} [o.chatLog]   where events are logged
 * @param {(accountToken: string) => {id: number, name: string}|null} [o.authenticate]
 * @param {(id: string) => {id: string, title: string}|null} [o.findGame]  a game with achievements, by its id: what a message may mention
 * @param {(userId: number) => void} [o.removePicture]  takes an account's picture down (the admin's remove picture)
 *   the account a session token from server/accounts.mjs belongs to; without
 *   one, every hello is refused (SIGN_IN)
 * @param {() => number} [o.now]
 * @param {boolean} [o.manualClock]     no timer: the caller runs tick() (tests)
 * @param {Partial<typeof DEFAULTS>} [o.limits]
 */
export function createChatServer({
  origins = [], allowLoopback = false, trustProxy = 0, admin = null, adminData = null, bans: banStore = null, notify = null, blockedWords = [], chatLog = null,
  authenticate = null, findGame = () => null, removePicture = null, now = Date.now, manualClock = false, limits = {}, log = () => {},
} = {}) {
  const L = { ...DEFAULTS, ...limits };
  const words = wordFilter(blockedWords);
  const hashAddr = addressHasher();
  // The console signs in with its own passkeys (admin: { passkeys, setupKeySha256?, keyUsed?, useKey? }).
  // A console sign-in that ends (signed out, or run out) closes the live sockets it opened.
  const gate = admin ? createAdminGate({ ...admin, now, onRevoke: (token) => { for (const c of [...adminConns]) if (c.adminToken === token) c.close(4001, 'signed out'); } }) : null;
  const admission = new Admission({ rate: 2, burst: 10, globalRate: 50, globalBurst: 100, now });

  const sessions = new Map();   // token → session
  const byId = new Map();       // public id → session
  const rooms = new Map();      // code → room
  const conns = new Set();      // every open socket, users and admins
  const pending = new Set();    // user sockets that have not said hello
  const adminConns = new Set();
  // Address codes seen lately → { key, ip, at }: a ban from a report still finds
  // the address after its member has gone. Kept a week, and at most SEEN_MAX.
  const seenAddrs = new Map();
  const SEEN_MS = 7 * 24 * 3600_000, SEEN_MAX = 50_000;
  // Banned addresses, by key: shared with the accounts and kept in the database
  // when there is one (server/bans.mjs), else in memory.
  const bans = banStore ?? createBans({ now });
  let reports = [];
  let lastPing = now();
  let lastLogSweep = now();

  const randomId = (bytes) => crypto.randomBytes(bytes).toString('hex');
  const record = (event) => { try { chatLog?.write(event); } catch (e) { log(`chat log: ${e.message}`); } };
  const who = (s, nick) => ({ id: s.id, nick: nick ?? s.room?.members.get(s.id)?.nick ?? s.nick, ip: s.ip });
  const send = (conn, msg) => conn?.send(JSON.stringify(msg));

  // ── Views ────────────────────────────────────────────────────────────────
  const memberView = (room, m) => ({ id: m.id, uid: m.uid, nick: m.nick, muted: m.muted, here: m.connected, votes: voteCount(room, m), need: votesNeeded(room, m) });
  const roomView = (room) => ({
    code: room.code, name: room.name, topic: room.topic, key: room.key,
    owner: room.owner, createdAt: room.createdAt, members: [...room.members.values()].map((m) => memberView(room, m)),
  });
  const joinView = (room) => ({ ...roomView(room), history: room.history });
  const adminSummary = (room) => ({
    ...roomView(room), lastMessageAt: room.lastMessageAt,
    members: [...room.members.values()].map((m) => ({ ...memberView(room, m), addr: m.session.addrId })),
  });
  // For the console: each ban with its address code (as the members list shows it), the address and its key.
  const banList = () => bans.list().map((b) => ({ addr: hashAddr(b.key), key: b.key, ip: b.ip, until: b.until, reason: b.reason, at: b.at }));

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
  }
  function notice(room, text) {
    broadcast(room, { t: 'notice', room: room.code, text });
    adminBroadcast({ t: 'notice', room: room.code, text });
  }
  function addMessage(room, from, text, sysop = false, games = null) {
    const m = { n: ++room.n, from, text, at: now() };
    if (sysop) m.sysop = true;
    if (games?.length) m.games = games;
    room.history.push(m);
    if (room.history.length > LIMITS.history) room.history.shift();
    room.lastMessageAt = m.at;
    broadcast(room, { t: 'msg', room: room.code, m });
    adminBroadcast({ t: 'msg', room: room.code, m });
    return m;
  }

  // ── The channel ──────────────────────────────────────────────────────────
  // One room that never closes and has no host. The admin console still sees
  // it as a room, under the code CHAT.
  const channel = {
    code: 'CHAT', name: 'C64 READY', topic: null, key: '', owner: null,
    members: new Map(), votes: new Map(),
    banned: new Map(), bannedAddr: new Map(), bannedUid: new Map(),   // → until
    mutedIds: new Set(), mutedUid: new Set(),
    history: [], n: 0, createdAt: now(), lastMessageAt: now(),
  };
  rooms.set(channel.code, channel);
  function addMember(room, s, nick) {
    // A mute outlives the membership, like a kick: leaving and coming back keeps it.
    const muted = room.mutedIds.has(s.id) || room.mutedUid.has(s.user.id);
    room.members.set(s.id, { id: s.id, uid: s.user.id, session: s, nick, joinedAt: now(), muted, connected: !!s.conn, goneAt: s.conn ? null : now() });
    s.room = room;
  }
  // Muting a member mutes their session and their account for the room's
  // lifetime, also when they rejoin. Others at the same address are not
  // touched: the address-wide block is a ban.
  function setMuted(room, m, on) {
    if (on) { room.mutedIds.add(m.id); room.mutedUid.add(m.uid); }
    else { room.mutedIds.delete(m.id); room.mutedUid.delete(m.uid); }
    for (const x of room.members.values()) if (x.id === m.id || x.uid === m.uid) x.muted = on;
  }
  function removeMember(room, id, text) {
    const m = room.members.get(id);
    if (!m) return;
    room.members.delete(id);
    if (m.session.room === room) m.session.room = null;
    room.votes.delete(id);
    for (const voters of room.votes.values()) voters.delete(id);
    if (text) notice(room, text);
    pushRoom(room);
  }
  // A removal keeps the session and the account out for an hour. A vote keeps
  // the address out too, so a new account from it cannot walk back in; the
  // admin's removal leaves others at a shared address alone (a ban covers it).
  function kickMember(room, id, by) {
    const m = room.members.get(id);
    if (!m) return;
    const until = now() + L.voteBanMs;
    room.banned.set(id, until);
    if (by === 'vote') room.bannedAddr.set(m.session.addrId, until);
    room.bannedUid.set(m.uid, until);
    record({ ev: 'kick', room: room.code, by, ...who(m.session, m.nick) });
    send(m.session.conn, { t: 'kicked', room: room.code, by, until });
    const how = by === 'vote' ? ' by vote' : by === 'sysop' ? ' by SYSOP' : '';
    removeMember(room, id, `${m.nick} was removed${how}`);
  }
  /** Until when `s` is kept out of the channel, or 0. */
  function bannedUntil(room, s) {
    const t = now();
    const until = Math.max(room.banned.get(s.id) ?? 0, room.bannedAddr.get(s.addrId) ?? 0, room.bannedUid.get(s.user.id) ?? 0);
    return until > t ? until : 0;
  }
  /**
   * Puts `s` in the channel, unless kept out; returns { room } or { banned, until }
   * or { full }. An account is in the chat once, on the device it was last
   * opened on: the newest session takes the place over, and an older one still
   * connected is told and closed (one that dropped, waiting out its grace
   * period, simply goes).
   */
  function joinChannel(s) {
    if (s.room) return { room: s.room };
    const until = bannedUntil(channel, s);
    if (until) return { banned: true, until };
    for (const m of [...channel.members.values()]) {
      if (m.uid !== s.user.id || m.id === s.id) continue;
      const old = m.session;
      record({ ev: 'replaced', room: channel.code, ...who(old, m.nick) });
      send(old.conn, { t: 'replaced' });
      old.conn?.close(4001, 'replaced');
      deleteSession(old);
    }
    if (channel.members.size >= LIMITS.channelSize) return { full: true };
    addMember(channel, s, s.user.name);
    record({ ev: 'join', room: channel.code, ...who(s) });
    pushRoom(channel);
    return { room: channel };
  }
  function leaveCurrent(s) {
    if (s.room) record({ ev: 'leave', room: s.room.code, ...who(s) });
    if (s.room) removeMember(s.room, s.id, null);
  }
  // Votes are counted by address, not by session, so one person with several
  // connections is one voter, and nobody at the target's own address counts.
  // Removing someone takes a majority of the other addresses present, and never
  // fewer than two: a lone newcomer cannot vote anyone out.
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

  function memberOf(s) {
    const room = s.room;
    if (!room) fail('NOT_IN_ROOM');
    return { room, me: room.members.get(s.id) };
  }
  function targetIn(room, id, s) {
    const target = typeof id === 'string' ? room.members.get(id) : null;
    if (!target) fail('NOT_FOUND');
    if (target.id === s.id) fail('BAD_REQUEST');
    return target;
  }

  // ── Requests from the app ────────────────────────────────────────────────
  const HANDLERS = {
    /** Back into the channel, after a removal has run out. */
    join(s) {
      const r = joinChannel(s);
      if (r.banned) fail('BANNED');
      if (r.full) fail('FULL');
      return { room: joinView(r.room) };
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
      // A mention is a game with achievements that the text names as @Title.
      const games = cleanMentions(msg.games).map((id) => findGame(id)).filter((g) => g && mentions(text, g.title))
        .map((g) => ({ id: g.id, title: g.title }));
      if (!s.sayBucket.take()) fail('RATE_LIMITED');
      const m = addMessage(room, { id: s.id, uid: s.user.id, nick: me.nick, avatar: s.user.avatar }, words.mask(text), false, games);
      // The words as written, before any are starred out.
      record({ ev: 'msg', room: room.code, n: m.n, ...who(s, me.nick), text });
      return { n: m.n };
    },
    vote(s, msg) {
      const { room } = memberOf(s);
      const target = targetIn(room, msg.member, s);
      let voters = room.votes.get(target.id);
      if (!voters) room.votes.set(target.id, voters = new Set());
      voters.add(s.id);
      record({ ev: 'vote', room: room.code, target: target.id, ...who(s) });
      // A vote from the target's own address does not count, so one person cannot vote with many accounts.
      const votes = voteCount(room, target), need = votesNeeded(room, target), counted = s.addrId !== target.session.addrId;
      if (votes >= need) { kickMember(room, target.id, 'vote'); return { votes, need, counted, removed: true }; }
      pushRoom(room);
      return { votes, need, counted };
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
      addrKey: conn.addrKey, addrId: conn.addrId, ip: conn.ip, conn: null, room: null, nick: '', user: null,
      disconnectedAt: null,
      events: new Bucket(20, 60, now),
      sayBucket: new Bucket(1, 5, now),
      reportBucket: new Bucket(1 / 60, 3, now),
    };
    sessions.set(s.token, s);
    byId.set(s.id, s);
    return s;
  }
  function deleteSession(s) {
    if (s.room) removeMember(s.room, s.id, null);
    sessions.delete(s.token);
    byId.delete(s.id);
  }

  function hello(conn, msg) {
    if (msg.v !== PROTOCOL) { send(conn, { t: 'err', code: 'OLD_CLIENT' }); conn.close(4000, 'old client'); return; }
    // Chatting needs an account: the hello carries its session token.
    const user = typeof msg.account === 'string' && authenticate ? authenticate(msg.account) : null;
    if (!user) { send(conn, { t: 'err', code: 'SIGN_IN' }); conn.close(4004, 'sign in'); return; }
    let s = typeof msg.token === 'string' ? sessions.get(msg.token) : null;
    if (s && s.user.id !== user.id) s = null;   // another account's session: a new one
    if (s && s.conn && s.conn !== conn) {
      const old = s.conn;
      send(old, { t: 'replaced' });
      old.close(4001, 'replaced');
    }
    if (!s) {
      if (sessions.size >= L.maxSessions) { conn.close(1013, 'full'); return; }
      s = newSession(conn);
    }
    s.user = { id: user.id, name: user.name, avatar: user.avatar || 0 };
    s.account = msg.account;   // to see a new badge without a reconnect
    s.nick = user.name;
    s.conn = conn;
    s.addrKey = conn.addrKey;
    s.addrId = conn.addrId;
    s.ip = conn.ip;
    record({ ev: 'connect', id: s.id, ip: s.ip });
    seenAddrs.delete(s.addrId);
    seenAddrs.set(s.addrId, { key: s.addrKey, ip: s.ip, at: now() });
    if (seenAddrs.size > SEEN_MAX) seenAddrs.delete(seenAddrs.keys().next().value);
    s.disconnectedAt = null;
    conn.session = s;
    pending.delete(conn);
    const m = s.room?.members.get(s.id);
    if (m) { m.connected = true; m.goneAt = null; }
    // Saying hello puts the session in the channel, unless it is kept out.
    const joined = m ? { room: s.room } : joinChannel(s);
    send(conn, {
      t: 'welcome', v: PROTOCOL, token: s.token, id: s.id, room: joined.room ? joinView(joined.room) : null,
      ...(joined.banned ? { banned: joined.until } : {}), ...(joined.full ? { full: true } : {}),
    });
    if (m) pushRoom(s.room);
  }

  function disconnected(s) {
    s.conn = null;
    s.disconnectedAt = now();
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
      // Every request needs the account still signed in (not signed out or
      // deleted since): otherwise it is refused, then the socket closes. Its
      // badge is taken as it is now, so a message shows the current one.
      const fresh = authenticate?.(s.account);
      if (!fresh) {
        deleteSession(s);
        queueMicrotask(() => conn.close(4004, 'signed out'));
        fail('SIGN_IN');
      }
      s.user.avatar = fresh.avatar || 0;
      const out = handler(s, msg);
      if (id !== undefined) send(conn, { t: 'ok', id, ...out });
    } catch (e) {
      if (!(e instanceof ChatError)) log(`chat: ${msg.t} failed: ${e.stack || e}`);
      if (id !== undefined) send(conn, { t: 'err', id, code: e instanceof ChatError ? e.code : 'INTERNAL' });
    }
  }

  function allowedOrigin(origin) {
    return origin === undefined || origins.includes(origin) || (allowLoopback && isLoopbackOrigin(origin));
  }

  function userUpgrade(req, sock, head) {
    if (!allowedOrigin(req.headers.origin)) { refuseUpgrade(sock, 403, 'Forbidden'); return; }
    const ip = clientAddress(req, trustProxy);
    const key = addressKey(ip);
    const addrId = hashAddr(key);
    if (bans.get(key)) { refuseUpgrade(sock, 403, 'Forbidden'); return; }
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
  /** Bans an address key for `hours`: everyone in the chat from it is removed, and it cannot come back. */
  function banAddress(key, hours, reason, ip = null) {
    const addr = hashAddr(key);
    bans.add({ key, ip, hours, reason });
    record({ ev: 'ban', addr, ip, hours, reason });
    for (const s of [...sessions.values()]) {
      if (s.addrKey !== key) continue;
      record({ ev: 'banned', ...who(s) });
      if (s.room) kickMember(s.room, s.id, 'sysop');
      send(s.conn, { t: 'banned' });
      s.conn?.close(4003, 'banned');
      deleteSession(s);
    }
    for (const c of [...pending]) if (c.addrKey === key) c.close(4003, 'banned');
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
    // Takes a member's profile picture down, for good (they can set another).
    unpicture(msg) {
      const room = rooms.get(msg.room) ?? fail('NOT_FOUND');
      const m = room.members.get(msg.member) ?? fail('NOT_FOUND');
      if (!removePicture) fail('NOT_FOUND');
      removePicture(m.uid);
      record({ ev: 'unpicture', room: room.code, by: 'sysop', ...who(m.session, m.nick) });
    },
    mute(msg) {
      const room = rooms.get(msg.room) ?? fail('NOT_FOUND');
      const m = room.members.get(msg.member) ?? fail('NOT_FOUND');
      setMuted(room, m, !!msg.on);
      record({ ev: 'mute', room: room.code, on: m.muted, by: 'sysop', ...who(m.session, m.nick) });
      pushRoom(room);
    },
    say(msg) {
      const room = rooms.get(msg.room) ?? fail('NOT_FOUND');
      const text = cleanText(msg.text) ?? fail('TEXT_INVALID');
      const m = addMessage(room, { id: 'sysop', nick: 'SYSOP' }, text, true);
      record({ ev: 'msg', room: room.code, n: m.n, id: 'sysop', nick: 'SYSOP', ip: null, text });
    },
    // From the live view or a report: a member's address code, which names an
    // address seen in the last week, also once its member has gone. A reason is needed.
    ban(msg) {
      if (typeof msg.addr !== 'string' || !/^[0-9a-f]{12}$/.test(msg.addr)) fail('BAD_REQUEST');
      const reason = cleanText(msg.reason ?? '', 100) ?? fail('REASON');
      const s = [...sessions.values()].find((x) => x.addrId === msg.addr);
      const seen = s ? { key: s.addrKey, ip: s.ip } : seenAddrs.get(msg.addr) ?? fail('NOT_FOUND');
      const hours = Math.min(720, Math.max(1, Math.round(Number(msg.hours) || 24)));
      banAddress(seen.key, hours, reason, seen.ip);
    },
    unban(msg) {
      const b = bans.list().find((x) => x.key === msg.key || hashAddr(x.key) === msg.addr) ?? fail('NOT_FOUND');
      bans.remove(b.key);
      record({ ev: 'unban', addr: hashAddr(b.key), ip: b.ip });
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
    // Every command checks the sign-in that opened the socket is still live.
    if (!gate.valid(conn.adminToken)) { conn.close(4001, 'signed out'); return; }
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
    conn.adminToken = gate.tokenOf(req);
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

  // Who is in the chat now, by account id: for the console's players views.
  const onlineUids = () => [...new Set([...channel.members.values()].filter((m) => m.connected).map((m) => m.uid))];
  // A player the admin signed out, renamed or deleted leaves the chat, and signs in again to come back.
  function dropAccount(uid) {
    for (const s of [...sessions.values()]) {
      if (s.user?.id !== uid) continue;
      s.conn?.close(4004, 'signed out');
      deleteSession(s);
    }
  }
  const apiJson = (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json', ...ADMIN_HEADERS }).end(JSON.stringify(body));
  function readAdminJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const parts = [];
      req.on('data', (c) => { size += c.length; if (size > 16 * 1024) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else parts.push(c); });
      req.on('end', () => { try { resolve(size ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('not JSON'), { status: 400 })); } });
      req.on('error', reject);
    });
  }
  const ACTIONS = new Set(['signout', 'rename', 'picture', 'score', 'results', 'entry', 'delete']);
  /** The console's players API: GET overview, players, a player, their logins and activity; POST an action. */
  async function adminApi(req, res, path, url, sameOrigin) {
    if (!adminData) { apiJson(res, 404, { error: 'no accounts on this server' }); return; }
    const int = (v, d = 0) => (v != null && v !== '' && Number.isSafeInteger(Number(v)) ? Number(v) : d);
    const m = /^\/admin\/api\/players\/(\d{1,12})(?:\/([a-z]+))?$/.exec(path);
    try {
      if (req.method === 'GET' && path === '/admin/api/overview') return apiJson(res, 200, adminData.overview({ online: onlineUids() }));
      // Results the fair-play checks flagged: the list, and an approve or clear for one.
      if (req.method === 'GET' && path === '/admin/api/flags') return apiJson(res, 200, adminData.flags());
      if (req.method === 'POST' && path === '/admin/api/flags') {
        if (!sameOrigin) return apiJson(res, 403, { error: 'not from the console' });
        const body = await readAdminJson(req);
        const out = adminData.review({ kind: body.kind, user: body.user, game: body.game, ref: body.ref, decision: body.decision });
        record({ ev: 'admin', action: `review-${body.decision}`, uid: body.user, did: out.did });
        return apiJson(res, 200, { ok: true, did: out.did });
      }
      // The whole database, as one SQLite file: put it in CHAT_DATA_DIR as c64ready.db to run the same server elsewhere.
      if (req.method === 'GET' && path === '/admin/api/export') {
        const file = nodePath.join(os.tmpdir(), `c64ready-export-${randomId(8)}.db`);
        adminData.snapshot(file);
        record({ ev: 'admin', action: 'export' });
        const gone = () => fs.rm(file, { force: true }, () => {});
        res.writeHead(200, {
          ...ADMIN_HEADERS, 'Content-Type': 'application/vnd.sqlite3', 'Content-Length': fs.statSync(file).size,
          'Content-Disposition': `attachment; filename="c64ready-${new Date(now()).toISOString().slice(0, 10)}.db"`,
        });
        fs.createReadStream(file).on('error', () => { gone(); res.end(); }).on('close', gone).pipe(res);
        return;
      }
      if (req.method === 'GET' && path === '/admin/api/players') {
        const p = url.searchParams;
        return apiJson(res, 200, adminData.players({ search: p.get('search') ?? '', sort: p.get('sort') ?? 'joined', dir: p.get('dir') ?? 'desc', page: int(p.get('page')), online: onlineUids() }));
      }
      if (req.method === 'GET' && m && !m[2]) return apiJson(res, 200, { ...adminData.player(Number(m[1])), online: onlineUids().includes(Number(m[1])) });
      if (req.method === 'GET' && m && (m[2] === 'logins' || m[2] === 'activity')) return apiJson(res, 200, adminData[m[2]](Number(m[1]), int(url.searchParams.get('before'), Number.MAX_SAFE_INTEGER)));
      // An address, banned or let back in from a player's page.
      if (req.method === 'POST' && (path === '/admin/api/ban' || path === '/admin/api/unban')) {
        if (!sameOrigin) return apiJson(res, 403, { error: 'not from the console' });
        const body = await readAdminJson(req);
        if (path === '/admin/api/unban') {
          const key = typeof body.ip === 'string' && net.isIP(body.ip.trim()) ? addressKey(body.ip.trim()) : String(body.key ?? '');
          const b = bans.get(key);
          if (!b) return apiJson(res, 404, { error: 'no such ban' });
          bans.remove(b.key);
          record({ ev: 'unban', addr: hashAddr(b.key), ip: b.ip });
          adminBroadcast({ t: 'bans', bans: banList() });
          return apiJson(res, 200, { ok: true });
        }
        const ip = typeof body.ip === 'string' && net.isIP(body.ip.trim()) ? body.ip.trim() : null;
        const reason = typeof body.reason === 'string' ? cleanText(body.reason, 200) : null;
        if (!ip) return apiJson(res, 400, { error: 'which address?' });
        if (!reason) return apiJson(res, 400, { error: 'a reason is needed' });
        const hours = Math.min(720, Math.max(1, Math.round(Number(body.hours) || 24)));
        banAddress(addressKey(ip), hours, reason, ip);
        return apiJson(res, 200, { ok: true, key: addressKey(ip) });
      }
      if (req.method === 'POST' && m && ACTIONS.has(m[2])) {
        if (!sameOrigin) return apiJson(res, 403, { error: 'not from the console' });
        const body = await readAdminJson(req);
        const reason = typeof body.reason === 'string' ? cleanText(body.reason, 200) : null;
        if (!reason) return apiJson(res, 400, { error: 'a reason is needed' });
        const id = Number(m[1]);
        const out = adminData.act(id, m[2], { game: body.game, board: body.board, entry: body.entry });
        if (['signout', 'rename', 'delete'].includes(m[2])) dropAccount(id);
        record({ ev: 'admin', action: m[2], uid: id, name: out.name, did: out.did, reason });
        return apiJson(res, 200, { ok: true, did: out.did });
      }
      apiJson(res, 404, { error: 'not found' });
    } catch (e) {
      apiJson(res, e.status || 500, { error: e.status ? e.message : 'server error' });
      if (!e.status) log(`admin api: ${e.stack || e.message}`);
    }
  }

  function serveAdmin(req, res, path) {
    if (!gate) return false;
    const url = new URL(String(req.url || ''), 'http://x');
    const secure = !!req.socket.encrypted || (trustProxy > 0 && req.headers['x-forwarded-proto'] === 'https');
    const ownOrigin = `${secure ? 'https' : 'http'}://${String(req.headers.host || '')}`;
    // A passkey and a console request belong to this server's own page.
    const ctx = {
      addr: addressKey(clientAddress(req, trustProxy)), secure,
      allowedOrigin: (o) => o === ownOrigin || (allowLoopback && isLoopbackOrigin(o)),
      sameOrigin: req.headers.origin === ownOrigin,
    };
    if (gate.handles(req.method, path)) { gate.handle(req, res, path, ctx); return true; }
    if (path.startsWith('/admin/api/')) {
      if (!gate.tokenFrom(req)) apiJson(res, 401, { error: 'sign in first' });
      else adminApi(req, res, path, url, ctx.sameOrigin);
      return true;
    }
    const asset = adminAsset(path);
    const logs = asset ? null : logRoute(path);
    if (!asset && !logs) return false;
    if (!asset?.open && !gate.tokenFrom(req)) {
      // Not signed in: the pages go to the passkey sign-in, anything else is refused.
      if (asset?.page || logs) res.writeHead(302, { Location: '/admin/login', ...ADMIN_HEADERS }).end();
      else res.writeHead(401, ADMIN_HEADERS).end();
      return true;
    }
    if (logs?.list) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...ADMIN_HEADERS }).end(logsPage()); return true; }
    if (logs?.file) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="${logs.file}"`, ...ADMIN_HEADERS });
      fs.createReadStream(nodePath.join(chatLog.dir, logs.file)).on('error', () => res.end()).pipe(res);
      return true;
    }
    res.writeHead(200, { 'Content-Type': asset.type, ...ADMIN_HEADERS }).end(asset.body);
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
          removeMember(room, m.id, null);
        }
      }
      for (const map of [room.banned, room.bannedAddr, room.bannedUid]) for (const [k, until] of map) if (until <= t) map.delete(k);
    }
    for (const s of [...sessions.values()]) {
      if (!s.conn && !s.room && t - s.disconnectedAt >= L.unusedSessionMs) deleteSession(s);
    }
    for (const [code, x] of seenAddrs) { if (t - x.at < SEEN_MS) break; seenAddrs.delete(code); }
    if (bans.sweep()) adminBroadcast({ t: 'bans', bans: banList() });
    gate?.sweep();
    admission.sweep();
    if (chatLog && t - lastLogSweep >= 3600_000) { lastLogSweep = t; chatLog.sweep(); }
  }
  const timer = manualClock ? null : setInterval(tick, 1000);
  timer?.unref?.();

  return {
    /** A setup key for the dev server's terminal while the console has no passkey; else null. */
    adminSetupKey: () => gate?.devSetupKey() ?? null,
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
      // The console's sign-in, its actions and its API take POSTs; everything else here is read-only.
      if (req.method !== 'GET' && req.method !== 'HEAD' && !(req.method === 'POST' && path.startsWith('/admin/'))) return false;
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
