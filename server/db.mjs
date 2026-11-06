// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/db.mjs — the server's lasting data (accounts, passkeys, sessions,
// games, achievements and leaderboards) in one SQLite file, through Node's
// built-in node:sqlite. The chat itself stays in memory. Schema changes are
// applied in order and counted in user_version.

import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     name_key TEXT NOT NULL UNIQUE,
     handle BLOB NOT NULL UNIQUE,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE passkeys (
     id TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     public_key TEXT NOT NULL,
     sign_count INTEGER NOT NULL DEFAULT 0,
     transports TEXT,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER
   );
   CREATE INDEX passkeys_user ON passkeys(user_id);
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL
   );
   CREATE INDEX sessions_user ON sessions(user_id);`,
  // Games and their achievement sets (loaded from server/sets/*.json at start),
  // what each account unlocked and its best leaderboard entries, and the
  // activity they make.
  `CREATE TABLE games (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     source TEXT
   );
   CREATE TABLE game_hashes (
     hash TEXT PRIMARY KEY,
     game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
     label TEXT
   );
   CREATE TABLE achievements (
     game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
     id INTEGER NOT NULL,
     title TEXT NOT NULL,
     description TEXT NOT NULL,
     points INTEGER NOT NULL DEFAULT 0,
     memaddr TEXT NOT NULL,
     sort INTEGER NOT NULL,
     PRIMARY KEY (game_id, id)
   );
   CREATE TABLE leaderboards (
     game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
     id INTEGER NOT NULL,
     title TEXT NOT NULL,
     description TEXT NOT NULL,
     format TEXT NOT NULL,
     lower_is_better INTEGER NOT NULL DEFAULT 0,
     definition TEXT NOT NULL,
     sort INTEGER NOT NULL,
     PRIMARY KEY (game_id, id)
   );
   CREATE TABLE unlocks (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     game_id TEXT NOT NULL,
     achievement_id INTEGER NOT NULL,
     hardcore INTEGER NOT NULL DEFAULT 0,
     unlocked_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, game_id, achievement_id)
   );
   CREATE TABLE lb_entries (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     game_id TEXT NOT NULL,
     leaderboard_id INTEGER NOT NULL,
     value INTEGER NOT NULL,
     hardcore INTEGER NOT NULL DEFAULT 0,
     submitted_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, game_id, leaderboard_id)
   );
   CREATE INDEX lb_entries_board ON lb_entries(game_id, leaderboard_id, value);
   CREATE TABLE activity (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     game_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     ref INTEGER NOT NULL,
     value INTEGER
   );
   CREATE INDEX activity_game ON activity(game_id, id);`,
  // A player's own activity, for their profile.
  `CREATE INDEX activity_user ON activity(user_id, id);`,
  // The recovery code (kept as its SHA-256) that adds a passkey when the
  // others are lost, and the count of wrong tries that locks it for a while.
  `ALTER TABLE users ADD COLUMN recovery_hash TEXT;
   ALTER TABLE users ADD COLUMN recovery_failures INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE users ADD COLUMN recovery_locked_until INTEGER NOT NULL DEFAULT 0;`,
  // A set's notices: states the app tells the player about (JSON).
  `ALTER TABLE games ADD COLUMN notices TEXT;`,
  // When a passkey last confirmed the session (signing in counts): account
  // changes need a recent one.
  `ALTER TABLE sessions ADD COLUMN confirmed_at INTEGER NOT NULL DEFAULT 0;`,
  // An optional profile picture: a PNG, JPEG or WebP of at most 256x256, its
  // type, and when it was set (the version in its address, 0 for none).
  `ALTER TABLE users ADD COLUMN avatar BLOB;
   ALTER TABLE users ADD COLUMN avatar_type TEXT;
   ALTER TABLE users ADD COLUMN avatar_at INTEGER NOT NULL DEFAULT 0;`,
  // Wrong recovery codes are counted in memory, per account and address: the
  // columns that counted them per account go.
  `ALTER TABLE users DROP COLUMN recovery_failures;
   ALTER TABLE users DROP COLUMN recovery_locked_until;`,
  // Each sign-in, recovery, confirmation and sign-out, with the address and
  // browser it came from: for the admin, kept 90 days.
  `CREATE TABLE logins (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     at INTEGER NOT NULL,
     kind TEXT NOT NULL,
     ok INTEGER NOT NULL,
     ip TEXT,
     device TEXT
   );
   CREATE INDEX logins_user ON logins(user_id, id);
   CREATE INDEX logins_at ON logins(at);`,
  // The admin console's passkeys: its own, apart from the players' accounts.
  `CREATE TABLE admin_passkeys (
     id TEXT PRIMARY KEY,
     public_key TEXT NOT NULL,
     sign_count INTEGER NOT NULL,
     transports TEXT,
     label TEXT,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER
   );`,
  // Setup keys work once: the ones used, by their hash.
  `CREATE TABLE admin_used_keys (hash TEXT PRIMARY KEY, used_at INTEGER NOT NULL);`,
  // Banned addresses (an IPv4 address, or an IPv6 /64), for the chat and the
  // accounts alike, until a time.
  `CREATE TABLE bans (key TEXT PRIMARY KEY, ip TEXT, until INTEGER NOT NULL, reason TEXT, at INTEGER NOT NULL);`,
  // A page about the game elsewhere, from its set.
  `ALTER TABLE games ADD COLUMN url TEXT;`,
  // Fair play. A result the server finds odd waits for review, its flag saying why. When each
  // account opened each game, for those checks. What counts in public: hardcore results with no flag.
  `ALTER TABLE unlocks ADD COLUMN flag TEXT;
   ALTER TABLE lb_entries ADD COLUMN flag TEXT;
   CREATE TABLE plays (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     game_id TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     seen_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, game_id)
   );
   CREATE VIEW clean_unlocks AS SELECT * FROM unlocks WHERE hardcore = 1 AND flag IS NULL;
   CREATE VIEW clean_entries AS SELECT * FROM lb_entries WHERE hardcore = 1 AND flag IS NULL;`,
  // A board's plausible limits, from its set: a higher (or, where fewer is better, a lower) value is flagged.
  `ALTER TABLE leaderboards ADD COLUMN max_value INTEGER;
   ALTER TABLE leaderboards ADD COLUMN min_value INTEGER;`,
  // Results posted before the app said whether play was hardcore came in as softcore: they count.
  `UPDATE unlocks SET hardcore = 1;
   UPDATE lb_entries SET hardcore = 1;`,
  // A score milestone, from its set: the score an achievement stands for on the game's boards.
  `ALTER TABLE achievements ADD COLUMN score_at INTEGER;`,
  // A set's game over: the condition that ends a game, which opens attract mode.
  `ALTER TABLE games ADD COLUMN game_over TEXT;`,
  // Demo players the admin console adds (server/demo-players.mjs): removed with their account.
  `CREATE TABLE demo_players (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE);`,
];

/** The schema version a fully migrated database records. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Opens (creating if needed) the database at `path`, or in memory for ':memory:'. */
export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}
