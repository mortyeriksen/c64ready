// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/main.mjs — the chat server as a process: `node server/main.mjs`, or
// `npm start` inside server/. It needs Node 22.13 or later (for node:sqlite)
// and nothing else. All settings come from the environment:
//
//   PORT                         where to listen (default 6465; Railway sets it)
//   HOST                         address to bind (default :: , every interface)
//   CHAT_ORIGINS                 comma-separated sites whose pages may connect
//                                (default https://c64ready.com)
//   CHAT_ALLOW_LOCAL             1: pages on this computer (localhost) may
//                                connect too, for running the server locally
//   CHAT_TRUST_PROXY             proxies in front that append X-Forwarded-For
//                                (default 0; 2 on Railway, whose edge and
//                                internal proxy each append one)
//   CHAT_ADMIN_SETUP_KEY_SHA256  the hash of a one-time key that sets up the
//                                console's first passkey (or one more, after the
//                                others are lost): `npm run admin-key` makes the
//                                key and prints both. The console at /admin then
//                                signs in with passkeys. It needs CHAT_DATA_DIR.
//   CHAT_NOTIFY_URL              optional: POSTed a line on every report (an
//                                ntfy topic URL, or a Discord webhook)
//   CHAT_BLOCKED_WORDS           optional comma-separated words: names with them
//                                are refused and messages have them starred out
//   CHAT_LOG_DIR                 where the chat log goes, one file per day: every
//                                message, join, leave and moderation step, with
//                                the IP address. Must survive restarts (a Railway
//                                Volume). Unset, nothing is logged.
//   CHAT_LOG_DAYS                how long log files are kept (default 90)
//   CHAT_DATA_DIR                where the accounts database goes (c64ready.db):
//                                accounts, their passkeys and sessions, and the
//                                achievement sets (server/sets/) with each
//                                account's unlocks and scores. Must
//                                survive restarts (a Railway Volume). Unset,
//                                accounts are off and /api answers 404.

import http from 'node:http';
import path from 'node:path';
import { createAccounts } from './accounts.mjs';
import { createAdminData } from './admin-data.mjs';
import { createAdminPasskeys } from './admin-passkeys.mjs';
import { createBans } from './bans.mjs';
import { openDatabase } from './db.mjs';
import { gameRoutes, gameById, loadSets } from './games.mjs';
import { fileURLToPath } from 'node:url';
import { createChatServer } from './chat.mjs';
import { createChatLog } from './log.mjs';
import { createNotifier } from './notify.mjs';

const env = process.env;
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);


const chatLog = env.CHAT_LOG_DIR
  ? createChatLog({ dir: env.CHAT_LOG_DIR, days: Math.max(1, Number.parseInt(env.CHAT_LOG_DAYS || '90', 10) || 90), onError: (e) => console.warn(`chat log: ${e.message}`) })
  : null;
if (!chatLog) console.warn('chat logging is off: set CHAT_LOG_DIR to a persistent directory');

const db = env.CHAT_DATA_DIR ? openDatabase(path.join(env.CHAT_DATA_DIR, 'c64ready.db')) : null;
// Banned addresses, for the chat and the accounts alike (in memory without a database).
const bans = createBans({ db });
if (db) loadSets(db, path.join(path.dirname(fileURLToPath(import.meta.url)), 'sets'), (t) => console.log(t));
const accounts = db
  ? createAccounts({
      db,
      extend: gameRoutes,
      origins: list(env.CHAT_ORIGINS || 'https://c64ready.com'),
      allowLoopback: env.CHAT_ALLOW_LOCAL === '1',
      trustProxy: Math.max(0, Number.parseInt(env.CHAT_TRUST_PROXY || '0', 10) || 0),
      blockedWords: list(env.CHAT_BLOCKED_WORDS),
      log: (t) => console.log(t),
      bans,
    })
  : null;
if (!accounts) console.warn('accounts are off, and with them the chat: set CHAT_DATA_DIR to a persistent directory');
// The console signs in with passkeys of its own, kept with the accounts.
const adminPasskeys = db ? createAdminPasskeys({ db }) : null;
const admin = adminPasskeys
  ? { passkeys: adminPasskeys, setupKeySha256: (env.CHAT_ADMIN_SETUP_KEY_SHA256 || '').trim() || null, keyUsed: adminPasskeys.keyUsed, useKey: adminPasskeys.useKey }
  : null;

const chat = createChatServer({
  origins: list(env.CHAT_ORIGINS || 'https://c64ready.com'),
  allowLoopback: env.CHAT_ALLOW_LOCAL === '1',
  trustProxy: Math.max(0, Number.parseInt(env.CHAT_TRUST_PROXY || '0', 10) || 0),
  admin,
  adminData: db && accounts ? createAdminData({ db, accounts, bans }) : null,
  bans,
  notify: createNotifier(env.CHAT_NOTIFY_URL, { onError: (e) => console.warn(`notify failed: ${e.message}`) }),
  blockedWords: list(env.CHAT_BLOCKED_WORDS),
  chatLog,
  // Chatting needs an account; without CHAT_DATA_DIR there are none, and no one can chat.
  authenticate: (token) => accounts?.userForToken(token) ?? null,
  findGame: (id) => (db ? gameById(db, id) : null),
  removePicture: (uid) => accounts?.removePicture(uid),
  log: (t) => console.warn(t),
});


const server = http.createServer((req, res) => {
  if (accounts?.handleRequest(req, res)) return;
  if (!chat.handleRequest(req, res)) res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
});
server.on('upgrade', (req, sock, head) => {
  if (!chat.handleUpgrade(req, sock, head)) sock.destroy();
});

const port = Number(env.PORT) || 6465;
server.listen(port, env.HOST || '::', () => {
  console.log(`c64ready chat on port ${port}${admin ? ', console at /admin' : ''}${chatLog ? `, logging to ${chatLog.dir}` : ''}`);
});

const stop = () => {
  chat.close();
  chatLog?.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
