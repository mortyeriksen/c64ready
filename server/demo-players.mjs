// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/demo-players.mjs — demo players for the admin console: a batch of made-up accounts with
// early and mid-game unlocks in every game, most of them only the first few, and five moderate
// scores on every board (two where the result needs a finished game), spread over the
// last six weeks, so the game pages, boards and activity show something to look at. Each batch has
// new random names, so batches add up. Every demo account is listed in demo_players and removed
// with it in one go. A demo account has no passkey: no one can sign in as it. Each has a badge of
// its own: a symmetric 8x8 sprite in C64 colours.

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { nameKey } from './accounts.mjs';
import { forgetDeleted } from './db.mjs';

const DAY = 24 * 3600_000;
const SPAN = 42 * DAY;          // the batch's history: the last six weeks
const PER_BOARD = 5;            // scores a batch adds to each board
const PER_LATE_BOARD = 2;       // and to a board whose result needs late-game trophies: few finish a game
const EARLY = 0.55;             // the share of a set, from its start, that counts as early and mid-game

// A board's moderate values, lo to hi in steps of `step`, and the achievements a result there
// implies (by title; '*' every achievement in the set). Boards not listed here that keep a high
// score in points take theirs from the game's score milestones; MILLISECS is hundredths of a second. A high
// score goes as far into its range as the player has got through the early and mid-game trophies.
const BOARDS = {
  'action-biker/1': { lo: 5000, hi: 40000, step: 10 },
  'chuckie-egg/1': { lo: 10000, hi: 60000, step: 10 },
  'forbidden-forest/1': { lo: 2000, hi: 12000, step: 10 },
  'galaga/1': { lo: 15000, hi: 60000, step: 10 },
  'green-beret/1': { lo: 10000, hi: 50000, step: 10 },
  'gribblys-day-out/1': { lo: 500, hi: 6000, step: 10 },
  'impossible-mission/1': { lo: 4000, hi: 25000, step: 10 },
  'last-light/2': { lo: 40, hi: 400, step: 1 },
  'last-light/3': { lo: 3, hi: 40, step: 1 },
  'mole-attack/1': { lo: 500, hi: 5000, step: 10 },
  'munchy-worm/1': { lo: 300, hi: 3000, step: 10 },
  'out-run/1': { lo: 400000, hi: 1600000, step: 10 },
  'out-run/2': { lo: 400000, hi: 1600000, step: 10 },
  'out-run/3': { lo: 400000, hi: 1600000, step: 10 },
  'out-run/4': { lo: 400000, hi: 1600000, step: 10 },
  'out-run/5': { lo: 400000, hi: 1600000, step: 10 },
  'panther/1': { lo: 5000, hi: 40000, step: 10 },
  'road-runner/1': { lo: 10000, hi: 60000, step: 10 },
  'stix/1': { lo: 5000, hi: 40000, step: 10 },
  'thrust/1': { lo: 5000, hi: 30000, step: 10 },
  'turrican/1': { lo: 20000, hi: 120000, step: 10 },
  'turrican-ii/1': { lo: 20000, hi: 120000, step: 10 },
  'vegetables-deluxe/1': { lo: 1000, hi: 10000, step: 10 },
  'vegetables-deluxe/2': { lo: 1000, hi: 10000, step: 10 },
  'vegetables-deluxe/3': { lo: 1000, hi: 10000, step: 10 },
  'spy-vs-spy/2': { lo: 2000, hi: 8000, step: 10, needs: ['Embassy Level 1'] },
  'pirates/1': { lo: 30, hi: 70, step: 1, needs: ['Commissioned', 'Ashore for Good'] },
  'prince-of-persia/1': { lo: 5, hi: 20, step: 1, needs: ['A Sword at Last', 'Deeper', 'The Skeleton', 'The Palace', 'Through the Mirror', 'The Fat Guard', 'Free Fall', 'The Mouse', 'Royal Halls', 'Deeper Still', 'Into the Dark', 'The Shadow', 'Tower of Jaffar', 'The Vizier Falls', 'Happily Ever After'] },
  // Fewest is best: times, moves, strokes and turns, as an ordinary player does them, so a player can
  // beat the demo players. Times are about 1.4 times a good run's, moves, strokes and turns about twice.
  'bruce-lee-ii/1': { lo: 210000, hi: 378000, step: 1, needs: ['First Lantern', 'The Deep of His Palace', 'Return of the Dragon'] },
  'commando/2': { lo: 12600, hi: 25200, step: 1, needs: ['Knock Knock', 'Breakthrough'] },
  'commando-arcade/2': { lo: 12600, hi: 25200, step: 1, needs: ['Off the Truck'] },
  'hitchhikers-guide/1': { lo: 600, hi: 1100, step: 1, needs: ['Hundred Points', 'Two Hundred', 'Three Hundred', 'Mostly Harmless'] },
  'zork-i/1': { lo: 700, hi: 1300, step: 1, needs: ['Breaking and Entering', 'Hundred Points', 'Two Hundred', 'Three Hundred', 'Master Adventurer'] },
  'last-ninja-3/2': { lo: 1050000, hi: 1890000, step: 1, needs: ['First Blood', 'Earth', 'Wind', 'Water', 'Fire', 'Real Hatred Is Timeless'] },
  'last-ninja/1': { lo: 25200, hi: 50400, step: 1, needs: ['First Blood', 'Into the Wilderness'] },
  'last-ninja/2': { lo: 25200, hi: 50400, step: 1, needs: ['First Blood', 'Into the Wilderness', 'Palace Gardens'] },
  'last-ninja/3': { lo: 25200, hi: 50400, step: 1, needs: ['First Blood', 'Into the Wilderness', 'Palace Gardens', 'Into the Dungeons'] },
  'last-ninja/4': { lo: 25200, hi: 50400, step: 1, needs: ['First Blood', 'Into the Wilderness', 'Palace Gardens', 'Into the Dungeons', 'The Palace'] },
  'last-ninja/5': { lo: 25200, hi: 50400, step: 1, needs: ['First Blood', 'Into the Wilderness', 'Palace Gardens', 'Into the Dungeons', 'The Palace', 'Inner Sanctum'] },
  'last-ninja/6': { lo: 25200, hi: 50400, step: 1, needs: ['First Blood', 'Into the Wilderness', 'Palace Gardens', 'Into the Dungeons', 'The Palace', 'Inner Sanctum', 'The Final Duel', 'The Sacred Scrolls'] },
  'leaderboard/1': { lo: 78, hi: 96, step: 1, needs: ['First Hole', 'Eighteen Holes'] },
  'leaderboard/2': { lo: 78, hi: 96, step: 1, needs: ['First Hole', 'Eighteen Holes'] },
  'leaderboard/3': { lo: 78, hi: 96, step: 1, needs: ['First Hole', 'Eighteen Holes'] },
  'leaderboard/4': { lo: 78, hi: 96, step: 1, needs: ['First Hole', 'Eighteen Holes'] },
  'maniac-mansion/1': { lo: 630000, hi: 1260000, step: 1, needs: ['The Old Mansion', 'Sandy Rescued'] },
  'pitstop-ii/1': { lo: 140, hi: 210, step: 1 },
  'pitstop-ii/2': { lo: 140, hi: 210, step: 1 },
  'pitstop-ii/3': { lo: 140, hi: 210, step: 1 },
  'pitstop-ii/4': { lo: 140, hi: 210, step: 1 },
  'pitstop-ii/5': { lo: 140, hi: 210, step: 1 },
  'pitstop-ii/6': { lo: 140, hi: 210, step: 1 },
  'spy-vs-spy/1': { lo: 12600, hi: 29400, step: 1, needs: ['Embassy Infiltration', 'Embassy Level 1'] },
  'spy-vs-spy-ii/1': { lo: 21000, hi: 46200, step: 1, needs: ['Island Landfall', 'Island Level 1'] },
  'spy-vs-spy-iii/1': { lo: 21000, hi: 46200, step: 1, needs: ['Arctic Arrival', 'Arctic Level 1'] },
  'turrican/2': { lo: 50400, hi: 84000, step: 1, needs: ['Touchdown', 'First World Down'] },
  'turrican-ii/2': { lo: 50400, hi: 84000, step: 1, needs: ['Boots on the Ground', 'First World Down'] },
  'ultima-iv/1': { lo: 120000, hi: 240000, step: 1, needs: ['*'] },
};

const ADJECTIVES = ['Pixel', 'Retro', 'Turbo', 'Sprite', 'Raster', 'Cosmic', 'Silent', 'Rapid', 'Lucky', 'Neon', 'Brave', 'Quiet', 'Crimson', 'Amber', 'Silver',
  'Frosty', 'Hyper', 'Mighty', 'Clever', 'Wild', 'Dusty', 'Shadow', 'Golden', 'Stormy', 'Jolly', 'Sly', 'Swift', 'Iron', 'Velvet', 'Atomic'];
const NOUNS = ['Joystick', 'Kernal', 'Datasette', 'Byte', 'Pilot', 'Ninja', 'Wizard', 'Rover', 'Comet', 'Falcon', 'Badger', 'Otter', 'Raven', 'Viking', 'Ranger',
  'Rocket', 'Tiger', 'Llama', 'Gecko', 'Panda', 'Moose', 'Hacker', 'Coder', 'Gamer', 'Racer', 'Knight', 'Pirate', 'Druid', 'Robot', 'Yeti'];

// The C64's colours (Pepto's palette), and pairs that read apart: a sprite's colour against its ground.
const C64 = [[0, 0, 0], [255, 255, 255], [104, 55, 43], [112, 164, 178], [111, 61, 134], [88, 141, 67], [53, 40, 121], [184, 199, 111],
  [111, 79, 37], [67, 57, 0], [154, 103, 89], [68, 68, 68], [108, 108, 108], [154, 210, 132], [108, 94, 181], [149, 149, 149]];
const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const GRID = 10, SCALE = 6;   // the 8x8 sprite with a cell of ground around it, 60x60 pixels

/** A PNG of `w` x `h` RGB pixels (rows of 3 bytes each). */
function png(w, h, rgb) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4);
  head[8] = 8; head[9] = 2;   // 8 bits a channel, RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (1 + w * 3) + 1, y * w * 3, (y + 1) * w * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A badge: an 8x8 sprite mirrored left to right, in one or two C64 colours on a ground that sets it off. */
export function demoBadge(random = Math.random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const ground = pick(C64);
  const apart = C64.filter((c) => Math.abs(luma(c) - luma(ground)) > 70);
  const ink = pick(apart), ink2 = random() < 0.4 ? pick(apart.filter((c) => c !== ink)) ?? ink : ink;
  const cells = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) {
    const v = random() < 0.5 ? 0 : random() < 0.25 ? 2 : 1;
    cells[y * 8 + x] = v; cells[y * 8 + 7 - x] = v;
  }
  const side = GRID * SCALE, rgb = Buffer.alloc(side * side * 3);
  for (let py = 0; py < side; py++) for (let px = 0; px < side; px++) {
    const x = Math.floor(px / SCALE) - 1, y = Math.floor(py / SCALE) - 1;
    const v = x >= 0 && x < 8 && y >= 0 && y < 8 ? cells[y * 8 + x] : 0;
    const c = v === 0 ? ground : v === 1 ? ink : ink2;
    rgb[(py * side + px) * 3] = c[0]; rgb[(py * side + px) * 3 + 1] = c[1]; rgb[(py * side + px) * 3 + 2] = c[2];
  }
  return png(side, side, rgb);
}

/**
 * @param {object} o
 * @param {import('node:sqlite').DatabaseSync} o.db  the accounts and games database
 * @param {() => number} [o.now]
 * @param {() => number} [o.random]  0 <= x < 1
 */
export function createDemoPlayers({ db, now = Date.now, random = Math.random }) {
  const q = {
    count: db.prepare('SELECT COUNT(*) AS n FROM demo_players'),
    nameTaken: db.prepare('SELECT 1 FROM users WHERE name_key = ?'),
    addUser: db.prepare("INSERT INTO users (name, name_key, handle, created_at, avatar, avatar_type, avatar_at) VALUES (?, ?, ?, ?, ?, 'image/png', ?)"),
    mark: db.prepare('INSERT INTO demo_players (user_id) VALUES (?)'),
    games: db.prepare('SELECT id FROM games ORDER BY id'),
    achievements: db.prepare('SELECT id, title, score_at FROM achievements WHERE game_id = ? ORDER BY sort'),
    boards: db.prepare('SELECT id, title, format, lower_is_better FROM leaderboards WHERE game_id = ? ORDER BY sort'),
    play: db.prepare('INSERT INTO plays (user_id, game_id, started_at, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, game_id) DO UPDATE SET started_at = MIN(started_at, excluded.started_at), seen_at = MAX(seen_at, excluded.seen_at)'),
    unlock: db.prepare('INSERT OR IGNORE INTO unlocks (user_id, game_id, achievement_id, hardcore, unlocked_at) VALUES (?, ?, ?, 1, ?)'),
    entry: db.prepare('INSERT INTO lb_entries (user_id, game_id, leaderboard_id, value, hardcore, submitted_at) VALUES (?, ?, ?, ?, 1, ?)'),
    activity: db.prepare('INSERT INTO activity (at, user_id, game_id, kind, ref, value) VALUES (?, ?, ?, ?, ?, ?)'),
    remove: db.prepare('DELETE FROM users WHERE id IN (SELECT user_id FROM demo_players)'),
  };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const between = (lo, hi) => lo + random() * (hi - lo);

  /** A name not yet taken: an adjective and a noun, perhaps with a number, at most 16 characters. */
  function newName() {
    for (let tries = 0; tries < 200; tries++) {
      const n = random() < 0.6 ? Math.floor(random() * 99) + 1 : '';
      const name = `${pick(ADJECTIVES)}${pick(NOUNS)}${n}`.slice(0, 16);
      if (!q.nameTaken.get(nameKey(name))) return name;
    }
    throw new Error('no free demo name');
  }

  /**
   * A board's moderate value range: its entry in BOARDS, or for a high score in points, from the
   * game's milestones: up to three times the first, and short of the second, which is past early and
   * mid-game. Another board (a height, a count) has none without its entry.
   */
  function range(game, board, milestones) {
    const listed = BOARDS[`${game}/${board.id}`];
    if (listed) return listed;
    if (board.lower_is_better || board.format !== 'SCORE' || !milestones.length) return null;
    const lo = Math.max(1, Math.round(milestones[0] * 0.4)), step = milestones[0] >= 1000 ? 10 : 1;
    let hi = milestones[0] * 3;
    if (milestones.length > 1) hi = Math.min(hi, milestones[1] - step);
    return { lo, hi: Math.floor(hi / step) * step, step };
  }

  /** Adds `count` demo players. Returns how many players, unlocks and scores it added. */
  function populate(count = 50) {
    const t1 = now(), t0 = t1 - SPAN;
    const added = { players: 0, unlocks: 0, scores: 0 };
    db.exec('BEGIN');
    try {
      // The players, each joining at some point in the six weeks, the earlier ones more active.
      const players = [];
      for (let i = 0; i < count; i++) {
        const name = newName();
        const joined = Math.round(between(t0, t1 - 3 * DAY));
        const id = Number(q.addUser.run(name, nameKey(name), crypto.randomBytes(16), joined, demoBadge(random), joined).lastInsertRowid);
        q.mark.run(id);
        players.push({ id, joined, weight: 0.3 + random() });
        added.players++;
      }
      const feed = [];   // the batch's activity, written in time order: feeds list it by its row
      const weighted = () => { const total = players.reduce((s, p) => s + p.weight, 0); let x = random() * total; for (const p of players) if ((x -= p.weight) < 0) return p; return players.at(-1); };
      // Who plays what: five players on each of a game's boards, and a few more on every game.
      for (const { id: game } of q.games.all()) {
        const achs = q.achievements.all(game);
        const byTitle = new Map(achs.map((a) => [a.title, a]));
        const milestones = achs.filter((a) => a.score_at != null).sort((a, b) => a.score_at - b.score_at);
        const cut = Math.max(1, Math.ceil(achs.length * EARLY));   // achievements from here on are late-game
        const pool = achs.slice(0, cut).filter((a) => a.score_at == null);
        // player → { reach: how far into the pool, unlocks: Set<achievement>, scores: [{ board, value }] }
        const plan = new Map();
        const of = (p) => {
          // Most players stop after the first few; fewer get far (the chance falls off as a square).
          if (!plan.has(p)) plan.set(p, { reach: pool.length && 1 + Math.floor(random() ** 2 * pool.length), unlocks: new Set(), scores: [] });
          return plan.get(p);
        };
        for (const board of q.boards.all(game)) {
          const r = range(game, board, milestones.map((m) => m.score_at));
          if (!r) continue;
          const late = (r.needs ?? []).some((t) => t === '*' || achs.indexOf(byTitle.get(t)) >= cut);
          const chosen = new Set();
          while (chosen.size < Math.min(late ? PER_LATE_BOARD : PER_BOARD, players.length)) chosen.add(weighted());
          for (const p of chosen) {
            const mine = of(p);
            // A high score as far up its range as the player's progress, give or take; a time anywhere in it.
            const share = pool.length ? (mine.reach / pool.length) * between(0.7, 1) : random();
            const value = board.lower_is_better ? Math.round(between(r.lo, r.hi) / r.step) * r.step
              : Math.min(r.hi, Math.round((r.lo + (r.hi - r.lo) * share) / r.step) * r.step);
            mine.scores.push({ board, value });
            for (const t of r.needs ?? []) for (const a of t === '*' ? achs : [byTitle.get(t)]) if (a) mine.unlocks.add(a);
            if (!board.lower_is_better && board.format === 'SCORE') for (const m of milestones) if (m.score_at <= value) mine.unlocks.add(m);
          }
        }
        const extra = 3 + Math.floor(random() * 6);
        for (let i = 0; i < extra; i++) of(weighted());
        for (const [p, mine] of plan) {
          // Early and mid-game: a run from the set's start, a few skipped along the way.
          for (let i = 0; i < mine.reach; i++) if (i === 0 || random() < 0.75) mine.unlocks.add(pool[i]);
          // The play's span: some days after joining, then unlocks in set order, scores after them,
          // at random times within it.
          const start = Math.round(between(p.joined, t1 - DAY));
          const end = Math.round(between(start + 3600_000, t1));
          const unlocks = achs.filter((a) => mine.unlocks.has(a));
          const times = Array.from({ length: unlocks.length + mine.scores.length }, () => Math.round(between(start, end))).sort((a, b) => a - b);
          let i = 0;
          q.play.run(p.id, game, start, end);
          for (const a of unlocks) {
            const at = times[i++];
            if (q.unlock.run(p.id, game, a.id, at).changes) { feed.push([at, p.id, game, 'unlock', a.id, null]); added.unlocks++; }
          }
          for (const { board, value } of mine.scores) {
            const at = times[i++];
            q.entry.run(p.id, game, board.id, value, at);
            feed.push([at, p.id, game, 'score', board.id, value]);
            added.scores++;
          }
        }
      }
      feed.sort((a, b) => a[0] - b[0]);
      for (const row of feed) q.activity.run(...row);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return added;
  }

  return {
    populate,
    /** Removes every demo player, and all they unlocked, scored and did. */
    remove() {
      const removed = Number(q.remove.run().changes);
      forgetDeleted(db);
      return { removed };
    },
    count: () => q.count.get().n,
  };
}
