// test/external-assets.js — resolver for files that live OUTSIDE this repo.
//
// The registry is test/external-assets.json: demo PRGs/D64s, VICE testprogs,
// SID files, collection roots, the ROMs. Edit the paths there (or set the
// per-entry env var) to match your machine — test code never hardcodes
// machine-specific paths.
//
// Contract for tests: resolve with assetPath()/readAsset()/assetFiles(); when
// an asset is missing, SKIP (exit 0) with missingNote(key) so the suite stays
// green on machines without the local media. Only the ROMs are hard-required
// (all-test.js prechecks them).
//
// Announce the skip with a TAP-style directive so all-test.js can tell it apart
// from a real pass and list it in the summary — exit 0 alone is invisible:
//   console.log(`# SKIP <what> — ${missingNote(key)}`);   // nothing ran
//   console.log(`ok  - <check> # SKIP ${missingNote(key)}`); // one check didn't
// The first form must start the line; the second rides on the check's ok line.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const registry = JSON.parse(fs.readFileSync(path.join(here, 'external-assets.json'), 'utf8'));

function expand(p) {
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  return path.isAbsolute(p) ? p : path.join(repoRoot, p);
}

function entry(key) {
  for (const group of ['assets', 'roms', 'collections', 'tools']) {
    const e = registry[group]?.[key];
    if (e) return e;
  }
  throw new Error(`external-assets.json: unknown asset key '${key}'`);
}

/** First existing candidate for `key` (env override wins), or null. */
export function assetPath(key) {
  const e = entry(key);
  const candidates = [e.env && process.env[e.env], ...(e.paths ?? [])]
    .filter(Boolean).map(expand);
  return candidates.find(p => fs.existsSync(p)) ?? null;
}

/** File contents for `key` (Buffer), or null when absent. */
export function readAsset(key) {
  const p = assetPath(key);
  return p ? fs.readFileSync(p) : null;
}

/** For entries with a `files` list: the subset that exists on disk. */
export function assetFiles(key) {
  return (entry(key).files ?? []).map(expand).filter(p => fs.existsSync(p));
}

/** Root dir of a collection entry — first existing candidate, else the first
 * configured one, so callers always get a printable path string. */
export function collectionDir(key) {
  return assetPath(key) ?? expand(entry(key).paths[0]);
}

/** A file inside a collection (existence is the caller's concern). */
export function collectionFile(key, rel) {
  return path.join(collectionDir(key), rel);
}

/** Standard skip/error message for a missing asset. */
export function missingNote(key) {
  const e = entry(key);
  const env = e.env ? ` or set $${e.env}` : '';
  const link = e.link ? `; source: ${e.link}` : '';
  return `external asset '${key}' not found — edit test/external-assets.json${env}${link}`;
}
