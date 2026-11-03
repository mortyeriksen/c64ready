<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# Chat server

The chat, the accounts and the achievements talk to a small Node server in this
directory (Node 22.13 or later, no dependencies). It holds one chat channel for
everyone signed in, the accounts (passkeys, sessions and recovery codes), and
the achievement sets in [`sets/`](sets/), with everyone's unlocks, best scores
and activity. The `server/` folder deploys by itself to Railway, and the
built app connects to the service's own Railway address, `CHAT_SERVER` in
`src/chat/connection.js`. `npm run dev` runs a chat server of its own at
`/chat`, with the accounts API at `/api` and its admin console at `/admin`,
and the app in development uses it. Until the console has a passkey, the dev
server prints a setup key when it starts: enter it at `/admin` under *Set up
this device*. Its accounts are kept in
`server/.data/c64ready.db` (git-ignored). A deployed server refuses pages on
`localhost` unless `CHAT_ALLOW_LOCAL=1` is set on it. With that set, development
can try it:
`localStorage.setItem('c64emu.chat.server', 'wss://c64ready-chat-production.up.railway.app/chat')`,
and undo it with `localStorage.removeItem('c64emu.chat.server')`.

## Deployment

1. In `server/`, run `railway init` once, naming the service `c64ready-chat`.
   Deploy a clean copy of what is committed, so nothing uncommitted ships:
   `git archive HEAD server | tar -x -C <dir> --strip-components=1`, then, in
   `server/`, `railway up <dir> --path-as-root --service c64ready-chat`. The
   log's `achievement sets:` line should list every set.
2. Run `railway domain` for the service's public address. Railway names it
   `<service>-production.up.railway.app`, which is what `CHAT_SERVER` expects.
   If Railway gives another name, put that in `CHAT_SERVER`.
3. Set the variables: `CHAT_ORIGINS=https://c64ready.com`, `CHAT_TRUST_PROXY=2`
   (two Railway proxies append to `X-Forwarded-For`: the edge adds the client's
   address, then an internal proxy adds its own), and for the admin console
   `CHAT_ADMIN_SETUP_KEY_SHA256` (see below). `CHAT_NOTIFY_URL`, an ntfy topic
   or a Discord webhook, gets a line on every report.
4. Attach a Railway Volume (for example at `/data`) and set
   `CHAT_LOG_DIR=/data/logs`. The chat log goes there, one file per day,
   deleted after `CHAT_LOG_DAYS` (default 90). Without a volume the files
   vanish on every redeploy, and without `CHAT_LOG_DIR` nothing is logged. The
   console's **Logs** page downloads them.
5. Set `CHAT_DATA_DIR=/data` on the same volume. The database, `c64ready.db`,
   is kept there. Without it there are no accounts: the `/api` endpoints answer
   404, nobody can sign in, and so nobody can chat either, since the chat
   needs an account.
6. Keep App Sleeping off: a sleeping server drops the chat's recent messages
   and everyone's connection.

After deploying, check that two people on different connections get different
address codes in the console at `/admin`. If everyone shares one, the proxy
setting is wrong. All settings are listed at the top of [`main.mjs`](main.mjs).

## The admin console

`/admin` signs in with a passkey of its own, separate from players' accounts,
and needs `CHAT_DATA_DIR`. To set up the first one, run `npm run admin-key` in
`server/` on your own computer. It prints a one-time setup key and the
`CHAT_ADMIN_SETUP_KEY_SHA256` to set on the server. Restart the server, open
`/admin` and enter the key under *Set up this device*. The key works once, and
only its hash is on the server, so it appears in no log. **Devices** in the
console lists the console's passkeys, and *Add a device* shows a key for
another device, good for 10 minutes. If every device is lost, set a new hash.

- **Overview:** players, sign-ups, who is active now (seen within 5 minutes)
  or in the chat, the week's top games and the latest sign-ups.
- **Players:** every account, searchable and sortable. A player's page shows
  their account, passkeys, games and scores, activity, and login history with
  IP address and browser (kept 90 days). Its actions (sign out everywhere,
  rename, remove the badge, remove a score, clear a game's results, delete)
  ask for a reason, which goes in the chat log. **ban** on a login or the
  last IP bans that address (an IPv6 address by its /64) for up to 30 days:
  it can still read what is public, but cannot chat, sign in, sign up,
  recover or post results, and a session from it is signed out. Bans are kept
  in the database, so they outlast a restart, and the Live tab lists them.
- **To review** (on the Overview): results the fair-play checks flagged, kept
  out of public view: posted without the game open, many unlocks at once, a
  score seconds after the game was opened, over a board's `max` (`min` where
  fewer is better) from its set, or past `score` milestones not unlocked. The
  last clears by itself when those milestones arrive. **Approve** lets one count, **Clear** removes
  it, and both go in the chat log. The dev server skips these checks.
- **Live:** the channel, under the name C64 READY, with **Online users**.
  Select a name for the channel's members and moderation controls. The list
  updates live and leaves out disconnected members during their reconnect
  grace period. **mute** and **kick** act on that account (a kick lasts an
  hour), so others at a shared address are not touched. **ban** covers the
  address, needs a reason, and still works from a report after the member has
  left (addresses are remembered for a week).
- **Export database:** downloads the whole database as one SQLite file,
  `c64ready-<date>.db`, taken while the server runs. It holds everything the
  server keeps: accounts, passkeys, sessions, badges, results, activity, login
  history with IP addresses, bans and the console's passkeys. To run the same
  server elsewhere, put it in a folder as `c64ready.db` and point
  `CHAT_DATA_DIR` there (on your own computer, with `CHAT_ALLOW_LOCAL=1` so
  pages on `localhost` may use it). Passkeys belong to the site's address, so on another
  address players and the admin sign in with new ones (the admin with a setup
  key). The chat's recent messages live only in memory and are not in it, and
  **Logs** downloads the chat log. Keep the file private: it has players' IP
  addresses.

## Achievement sets

Each game with achievements is a JSON file in [`sets/`](sets/), loaded when the
server starts. A file names the game, the MD5 of each file version it is for
(the rcheevos hash of a C64 file), and its achievements and leaderboards as
rcheevos condition strings. A set may also have `notices`: a text and a
condition each, shown to the player when the condition becomes true, such as a
trainer that keeps the game from counting, and a `gameOver` condition, true
when a game ends, which opens attract mode for a game whose end posts no score. `checkSet()` in
[`games.mjs`](games.mjs) says what a set must contain, and refuses one that does
not. Restarting with a changed set
keeps everyone's unlocks and scores: they are kept by the game's id and each
achievement's and leaderboard's id, which a set must keep.

[Back to C64 READY.](../README.md)
