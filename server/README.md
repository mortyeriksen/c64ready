<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# Chat server

A small Node server (Node 22.13 or later, no dependencies) for the chat, the
accounts (passkeys, sessions, recovery codes) and the achievements: the sets in
[`sets/`](sets/) with everyone's unlocks, best scores and activity. It deploys
by itself to Railway, and the built app connects to it at `CHAT_SERVER` in
`src/chat/connection.js`.

`npm run dev` runs one of its own at `/chat`, `/api` and `/admin`, with its data
in `server/.data/c64ready.db` (git-ignored). Until its console has a passkey, it
prints a setup key at start for *Set up this device* at `/admin`. A deployed
server refuses pages on `localhost` unless `CHAT_ALLOW_LOCAL=1` is set on it.
Then development can use it with
`localStorage.setItem('c64emu.chat.server', 'wss://c64ready-chat-production.up.railway.app/chat')`
(undo with `localStorage.removeItem('c64emu.chat.server')`).

## Deployment

1. In `server/`, run `railway init` once, naming the service `c64ready-chat`.
   Deploy a clean copy of what is committed:
   `git archive HEAD server | tar -x -C <dir> --strip-components=1`, then
   `railway up <dir> --path-as-root --service c64ready-chat` in `server/`.
   The log's `achievement sets:` line must list every set.
2. `railway domain` gives the public address,
   `<service>-production.up.railway.app`, which `CHAT_SERVER` expects.
3. Set `CHAT_ORIGINS=https://c64ready.com`, `CHAT_TRUST_PROXY=2` (Railway's edge
   and internal proxy each add to `X-Forwarded-For`) and
   `CHAT_ADMIN_SETUP_KEY_SHA256` (below). `CHAT_NOTIFY_URL`, an ntfy topic or a
   Discord webhook, gets a line on every report.
4. Attach a volume at `/data` and set `CHAT_DATA_DIR=/data` (the database:
   without it there are no accounts, so no sign-in and no chat) and
   `CHAT_LOG_DIR=/data/logs` (the chat log, a file a day, kept `CHAT_LOG_DAYS`,
   default 90).
5. Keep App Sleeping off: sleeping drops the chat and everyone's connection.

Two people on different connections should get different address codes in the
console. If everyone shares one, the proxy setting is wrong. Every setting is
listed at the top of [`main.mjs`](main.mjs).

## The admin console

`/admin` has passkeys of its own and needs `CHAT_DATA_DIR`. For the first one,
run `npm run admin-key` in `server/` on your own computer: it prints a one-time
setup key and the `CHAT_ADMIN_SETUP_KEY_SHA256` to set on the server. Restart
the server and enter the key under *Set up this device*. **Devices** lists the
console's passkeys and adds another with a key good for 10 minutes. If every
device is lost, set a new hash.

- **Overview:** players, sign-ups, who is active or in the chat, the week's top
  games and the latest sign-ups.
  - **To review:** results the fair-play checks keep out of public view (posted
    without the game open, many unlocks at once, a score seconds after the game
    opened, past a board's `max` or `min`, past `score` milestones not unlocked,
    which clears when they arrive). Results earned signed out skip the
    many-at-once and seconds-after checks. **Approve** or **Clear**. The dev
    server skips the checks.
  - **Demo players:** *Add 50 demo players* makes 50 accounts with random names
    and badges, unlocks and scores in every game over the last six weeks. Most
    stop after a game's first few trophies, a high score matches the trophies,
    and only two post where the result needs a finished game. *Remove all demo
    players* deletes them with everything they did. No one can sign in as one.
- **Players:** every account. A player's page shows their account, passkeys,
  games, scores, activity and login history (IP address and browser, kept 90
  days). Sign out everywhere, rename, remove the badge or a score, clear a
  game's results, remove a line of activity, or delete the account with
  everything of it. **ban** on a login bars that address (an IPv6 address by its
  /64) for up to 30 days from chatting, signing in or up, recovering and posting
  results.
- **Games:** every game with a set and its numbers. A game's page lists each
  board's scores, placed as in public, and each trophy with who unlocked it.
  **remove** takes out a score or an unlock with its activity.
- **Live:** the channel and **Online users**. **mute** and **kick** (an hour) act
  on the account, **ban** on the address, also from a report after the member
  has left (addresses are kept a week). Bans outlast a restart and are listed
  here.
- **Export database:** the whole database as `c64ready-<date>.db`, taken while
  the server runs. To run it elsewhere, name it `c64ready.db` in the folder
  `CHAT_DATA_DIR` points at. Passkeys belong to the site's address, so on
  another address everyone signs in with new ones. Keep it private: it has
  players' IP addresses.

Every action that changes a player's data asks for a reason and goes in the chat
log, which **Logs** downloads.

## Achievement sets

Each game with achievements is a JSON file in [`sets/`](sets/), loaded at start:
the game, the rcheevos hash of each file version it is for, and its achievements
and leaderboards as rcheevos conditions. A set may add `notices` (a text shown
when its condition comes true, such as a trainer that stops the game counting)
and a `gameOver` condition for a game whose end posts no score.
`checkSet()` in [`games.mjs`](games.mjs) says what a set must hold. Unlocks and
scores are kept by the game's, achievement's and leaderboard's ids, so a changed
set keeps them as long as its ids stay.

[Back to C64 READY.](../README.md)
