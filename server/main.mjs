// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/main.mjs — the chat server as a process: `node server/main.mjs`, or
// `npm start` inside server/. It needs Node 22 or later and nothing else. All
// settings come from the environment:
//
//   PORT                         where to listen (default 6465; Railway sets it)
//   HOST                         address to bind (default :: , every interface)
//   CHAT_ORIGINS                 comma-separated sites whose pages may connect
//                                (default https://c64ready.com); pages on this
//                                computer always may
//   CHAT_TRUST_PROXY             proxies in front that append X-Forwarded-For
//                                (default 0; 2 on Railway, whose edge and
//                                internal proxy each append one)
//   CHAT_ADMIN_USER              with the next one, enables the console at /admin
//   CHAT_ADMIN_PASSWORD_SHA256   hex SHA-256 of the console password:
//                                printf %s 'password' | shasum -a 256
//   CHAT_NOTIFY_URL              optional: POSTed a line on every report (an
//                                ntfy topic URL, or a Discord webhook)
//   CHAT_BLOCKED_WORDS           optional comma-separated words: names with them
//                                are refused and messages have them starred out
//   CHAT_LOG_DIR                 where the chat log goes, one file per day: every
//                                message, join, leave and moderation step, with
//                                the IP address. Must survive restarts (a Railway
//                                Volume). Unset, nothing is logged.
//   CHAT_LOG_DAYS                how long log files are kept (default 90)

import http from 'node:http';
import { createChatServer } from './chat.mjs';
import { createChatLog } from './log.mjs';
import { createNotifier } from './notify.mjs';

const env = process.env;
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

const admin = env.CHAT_ADMIN_USER && env.CHAT_ADMIN_PASSWORD_SHA256
  ? { user: env.CHAT_ADMIN_USER, passwordSha256: env.CHAT_ADMIN_PASSWORD_SHA256.trim() }
  : null;

const chatLog = env.CHAT_LOG_DIR
  ? createChatLog({ dir: env.CHAT_LOG_DIR, days: Math.max(1, Number.parseInt(env.CHAT_LOG_DAYS || '90', 10) || 90), onError: (e) => console.warn(`chat log: ${e.message}`) })
  : null;
if (!chatLog) console.warn('chat logging is off: set CHAT_LOG_DIR to a persistent directory');

const chat = createChatServer({
  origins: list(env.CHAT_ORIGINS || 'https://c64ready.com'),
  trustProxy: Math.max(0, Number.parseInt(env.CHAT_TRUST_PROXY || '0', 10) || 0),
  admin,
  notify: createNotifier(env.CHAT_NOTIFY_URL, { onError: (e) => console.warn(`notify failed: ${e.message}`) }),
  blockedWords: list(env.CHAT_BLOCKED_WORDS),
  chatLog,
  log: (t) => console.warn(t),
});

const server = http.createServer((req, res) => {
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
