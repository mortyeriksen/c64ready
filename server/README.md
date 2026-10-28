<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# Chat server

The chat talks to a small Node server in this directory (Node 22 or later, no
dependencies). The `server/` folder deploys by itself to Railway, and the app,
in development too, connects to the service's own Railway address,
`CHAT_SERVER` in `src/chat/connection.js`. `npm run dev` also runs a chat
server of its own at `/chat`, with its admin console at `/admin` (user
`sysop`, and a fresh password printed when the dev server starts), for the
tests and for trying changes to the server. Point the app at it with
`localStorage.setItem('c64emu.chat.server', 'ws://localhost:5173/chat')` (the
dev server's port) and back with `localStorage.removeItem('c64emu.chat.server')`.

## Deployment

1. In `server/`, run `railway init` once, naming the service `c64ready-chat`,
   then `railway up`.
2. Run `railway domain` for the service's public address. Railway names it
   `<service>-production.up.railway.app`, which is what `CHAT_SERVER` expects.
   If Railway gives another name, put that in `CHAT_SERVER`.
3. Set the variables: `CHAT_ORIGINS=https://c64ready.com`, `CHAT_TRUST_PROXY=2`
   (two Railway proxies append to `X-Forwarded-For`: the edge adds the client's
   address, then an internal proxy adds its own),
   and for the admin console `CHAT_ADMIN_USER` and `CHAT_ADMIN_PASSWORD_SHA256`
   (`printf %s 'password' | shasum -a 256`). `CHAT_NOTIFY_URL`, an ntfy topic
   or a Discord webhook, gets a line on every report.
4. Attach a Railway Volume (for example at `/data`) and set
   `CHAT_LOG_DIR=/data/logs`. The chat log goes there, one file per day,
   deleted after `CHAT_LOG_DAYS` (default 90). Without a volume the files
   vanish on every redeploy, and without `CHAT_LOG_DIR` nothing is logged. The
   console's **Logs** page downloads them.
5. Keep App Sleeping off: a sleeping server drops every room.

After deploying, check that two people on different connections get different
address codes in the console at `/admin`. If everyone shares one, the proxy
setting is wrong. All settings are listed at the top of [`main.mjs`](main.mjs).

The admin console lists **Online users** below the rooms, across all rooms.
Select a nickname to open its room and moderation controls. The list updates
live and excludes disconnected members during their reconnect grace period.

[Back to C64 READY.](../README.md)
