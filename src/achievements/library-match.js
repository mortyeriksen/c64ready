// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/achievements/library-match.js — a game's file in the LOAD library, found when its page opens:
// the entries whose file name has the game's words are hashed, as the achievements engine hashes a
// loaded file, and one with a hash of the game's is it. A hash is worked out once a session.

import { libList, libLoad } from '../media/library.js';

const HASHED = new Set(['prg', 'd64', 'd71', 'd81', 'g64', 'crt', 'tap', 't64']);
const SMALL = new Set(['the', 'a', 'an', 'of', 'and']);
const known = new Map();   // an entry (its id, when saved and size) → its hash, or null

/** A name's words: lower case, letters and digits, without the small ones. */
export const words = (text) => String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !SMALL.has(w));

/**
 * The names a game's file may go by: its title, and each version label's release, the one in its
 * brackets ("MultiLoad64 EasyFlash cartridge (Last Ninja, The (by $olo1870))") or the whole label
 * without them ("GHOSTNGA.D64").
 */
export function namesOf(title, labels = []) {
  const names = [title];
  for (const l of labels) {
    const open = l.indexOf('('), close = l.lastIndexOf(')');
    names.push(open >= 0 && close > open ? l.slice(open + 1, close) : l);
  }
  return names;
}

/** Whether a file name has every word of one of the names, or their letters run together ("zorki-1541" for Zork I). */
export function nameMatches(fileName, names) {
  const have = words(fileName), set = new Set(have), run = have.join('');
  return names.some((n) => { const w = words(n); return w.length > 0 && (w.every((x) => set.has(x)) || run.includes(w.join(''))); });
}

/**
 * The id of a library entry holding one of `hashes`, or null. Only entries named like the game are hashed.
 * @param {{ hashes: string[], names: string[] }} game
 * @param {(bytes: Uint8Array) => Promise<string|null>} hashOf  the engine's hash
 */
export async function findInLibrary({ hashes, names }, hashOf) {
  const want = new Set(hashes);
  try {
    for (const e of await libList()) {
      if (!HASHED.has(e.type) || !nameMatches(e.name, names)) continue;
      const key = `${e.id} ${e.savedAt} ${e.size}`;
      if (!known.has(key)) {
        const entry = await libLoad(e.id);
        known.set(key, entry ? await hashOf(entry.data).catch(() => null) : null);
      }
      if (want.has(known.get(key))) return e.id;
    }
  } catch { /* no library: nothing to load */ }
  return null;
}
