// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/achievements/library-match.js — a game's file in the LOAD library, found when its page opens:
// the entries whose file name has the game's words are hashed, as the achievements engine hashes a
// loaded file, and one with a hash of the game's is it. A hash is worked out once a session. And a
// folder of the player's own files: every version of a game with a set in it goes into the library.

import { libList, libLoad, libSave, MAX_ENTRIES, MAX_TOTAL_BYTES } from '../media/library.js';

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

/**
 * Names ready to test many files against: each name's words, and its letters run together. A run
 * of two letters or fewer ("IO") is only ever a whole word, or it would be found inside others.
 */
export function nameKeys(names) {
  return names.map(words).filter((w) => w.length).map((w) => { const run = w.join(''); return { w, run: run.length > 2 ? run : null }; });
}
/** A file name's words, worked out once for testing against many names. */
export function fileKeys(fileName) {
  const have = words(fileName);
  return { have, set: new Set(have) };
}
/** Whether a file has every word of one of the names, or a word of it starts with a name's letters run together ("zorki-1541" for Zork I). */
export function keysMatch(file, keys) {
  for (const k of keys) {
    if (k.w.every((x) => file.set.has(x))) return true;
    if (k.run) for (const x of file.have) if (x.startsWith(k.run)) return true;
  }
  return false;
}
/** Whether a file name is named like one of the names (see keysMatch). */
export const nameMatches = (fileName, names) => keysMatch(fileKeys(fileName), nameKeys(names));

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
      if (want.has(await entryHash(e, hashOf))) return e.id;
    }
  } catch { /* no library: nothing to load */ }
  return null;
}

/** A library entry's hash, worked out once a session. */
async function entryHash(e, hashOf, load = libLoad) {
  const key = `${e.id} ${e.savedAt} ${e.size}`;
  if (!known.has(key)) {
    const entry = await load(e.id);
    known.set(key, entry ? await hashOf(entry.data).catch(() => null) : null);
  }
  return known.get(key);
}

/** A file's media type, from its name, when the library keeps it and the engine can hash it; else null. */
export function hashedType(name) {
  const t = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase();
  return t && HASHED.has(t) ? t : null;
}

/**
 * Puts into the library every file in `files` (a folder's, as the folder picker gives them) that is
 * a version of one of `games`: named like the game in its path, then hashed as the engine hashes a
 * loaded file. A file the library holds already is left, and none is added once the library is full,
 * so nothing the player keeps there is pushed out.
 * @param {ArrayLike<File>} files
 * @param {{ title: string, hashes: string[], labels?: string[] }[]} games
 * @param {(bytes: Uint8Array) => Promise<string|null>} hashOf  the engine's hash
 * @param {(p: { checked: number, of: number, added: number }) => void} [progress]
 * @returns {Promise<{ added: { title: string, name: string }[], games: string[], full: number }>}
 *   what it added, every game it found a version of, and how many it left out for room
 */
export async function importFolder(files, games, hashOf, progress = () => {}, lib = { list: libList, load: libLoad, save: libSave }) {
  // Each game's names made ready once, and each file's path once: a collection can hold tens of thousands.
  const sets = games.map((g) => { const names = namesOf(g.title, (g.labels ?? []).filter(Boolean)); return { title: g.title, hashes: new Set(g.hashes), names, keys: nameKeys(names) }; });
  const named = [];
  for (const f of Array.from(files)) {
    const type = hashedType(f.name);
    if (!type) continue;
    const path = fileKeys(f.webkitRelativePath || f.name);
    const of = sets.filter((g) => keysMatch(path, g.keys));
    if (of.length) named.push({ f, type, of });
  }
  // What the library holds: its room, and the hashes of the entries named like a game.
  let entries = [];
  try { entries = await lib.list(); } catch { /* no library */ }
  let count = entries.length, bytes = entries.reduce((n, e) => n + (e.size || 0), 0);
  const have = new Set();
  for (const e of entries) {
    if (!HASHED.has(e.type)) continue;
    const name = fileKeys(e.name);
    if (sets.some((g) => keysMatch(name, g.keys))) have.add(await entryHash(e, hashOf, lib.load));
  }
  const added = [], found = new Set();
  let full = 0;
  for (let i = 0; i < named.length; i++) {
    progress({ checked: i, of: named.length, added: added.length });
    const { f, type, of } = named[i];
    const data = new Uint8Array(await f.arrayBuffer());
    const hash = await hashOf(data).catch(() => null);
    const game = hash ? of.find((g) => g.hashes.has(hash)) : null;
    if (!game) continue;
    found.add(game.title);
    if (have.has(hash)) continue;
    if (count + 1 > MAX_ENTRIES || bytes + data.length > MAX_TOTAL_BYTES) { full++; continue; }
    // Named so the library tells it apart, and its page finds it: a bare "side1.d64" gets the game's title.
    const name = keysMatch(fileKeys(f.name), game.keys) ? f.name : `${game.title} - ${f.name}`;
    if (!(await lib.save(type, name, data))) continue;
    have.add(hash);
    added.push({ title: game.title, name });
    count++;
    bytes += data.length;
  }
  progress({ checked: named.length, of: named.length, added: added.length });
  return { added, games: [...found], full };
}
