// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/roms.mjs — finding a C64 ROM set, and remembering where it is. Only the
// commands that boot a machine need one (run, loadtest, tap2d64, prg2tap), and
// ROMs are copyrighted, so nothing is bundled: the tool looks where the user
// says, then where it was told to remember, then where a VICE install keeps its
// own.
//
// Order: --roms <dir>, $C64_ROMS, the saved folder (`c64rdy roms <dir>`), ./roms,
// then known VICE locations. A folder may hold the house names (kernal.bin,
// basic.bin, chargen.bin, 1541.bin) or a VICE tree, which is scored by
// pickViceRoms.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { parseArgs, UsageError } from './args.mjs';
import { say } from './report.mjs';
import { pickViceRoms } from './core.mjs';

const SIZES = { kernal: [8192], basic: [8192], charRom: [4096], drive1541: [16384, 16386] };
const HOUSE_NAMES = { kernal: 'kernal.bin', basic: 'basic.bin', charRom: 'chargen.bin', drive1541: '1541.bin' };

/**
 * @param {object} o
 * @param {string} [o.dir]  --roms
 * @param {boolean} [o.need1541]
 * @returns {{ kernal: Buffer, basic: Buffer, charRom: Buffer, drive1541?: Buffer, from: string }}
 */
export function resolveRoms({ dir = null, need1541 = false } = {}) {
  const slots = ['kernal', 'basic', 'charRom', ...(need1541 ? ['drive1541'] : [])];
  const places = [
    dir,
    process.env.C64_ROMS,
    readSavedRoms(),
    'roms',
    ...viceDirs(),
  ].filter(Boolean);

  for (const place of places) {
    const found = romsIn(place, slots);
    if (found) return { ...found, from: place };
  }
  const files = slots.map(s => HOUSE_NAMES[s]).join(', ');
  throw new Error(
    `No C64 ROMs found. Put ${files} in ./roms, run \`c64rdy roms <dir>\` to ` +
    `remember a folder, point --roms or $C64_ROMS at one, or install VICE.`);
}

// ── remembering a folder ─────────────────────────────────────────────────────

// The saved ROM folder lives in the tool's own config, not the shell: a command
// cannot export $C64_ROMS into the shell that launched it, but it can write
// where the ROMs are once and read it back on every run.
function configPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'c64rdy', 'config.json');
}

/** The saved ROM folder, or null if none is set or the file is unreadable. */
export function readSavedRoms() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return typeof cfg.roms === 'string' ? cfg.roms : null;
  } catch { return null; }
}

function saveRoms(dir) {
  const p = configPath();
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* first write */ }
  cfg.roms = dir;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
}

const expandHome = p => (p === '~' || p.startsWith('~/')) ? path.join(os.homedir(), p.slice(1)) : p;

function promptLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

/**
 * `c64rdy roms [<dir>]` — remember where the C64 ROMs are, so the machine
 * commands find them without --roms or $C64_ROMS each time. With a folder it
 * validates and saves it; with none it asks at a terminal, and off a terminal
 * it just reports what is set, so a script never hangs.
 */
export async function roms(argv) {
  const { args } = parseArgs(argv);
  if (args.length > 1) throw new UsageError('Usage: c64rdy roms [<dir>]');
  let dir = args[0];
  if (!dir) {
    if (!process.stdin.isTTY) {
      const saved = readSavedRoms();
      say(saved ? `ROMs folder: ${saved}` : 'No ROMs folder saved — run: c64rdy roms <dir>');
      return saved ? 0 : 1;
    }
    dir = await promptLine('Folder holding kernal.bin, basic.bin, chargen.bin: ');
    if (!dir) { say('Nothing entered — ROMs folder unchanged.'); return 1; }
  }
  dir = path.resolve(expandHome(dir));
  if (!romsIn(dir, ['kernal', 'basic', 'charRom'])) {
    throw new Error(`${dir} holds no kernal.bin, basic.bin and chargen.bin (nor a VICE tree with them)`);
  }
  saveRoms(dir);
  say(`ROMs folder remembered: ${dir}`);
  return 0;
}

function romsIn(dir, slots) {
  if (!isDir(dir)) return null;
  const out = {};

  // The house names first — an exact ask beats a scored guess.
  for (const slot of slots) {
    const p = path.join(dir, HOUSE_NAMES[slot]);
    const bytes = readIfSized(p, SIZES[slot]);
    if (bytes) out[slot] = bytes;
  }
  if (slots.every(s => out[s])) return trim1541(out);

  // Otherwise treat it as a VICE tree: walk it shallowly and let the same
  // picker the app uses choose one file per slot.
  const files = [];
  walk(dir, dir, files, 0);
  const picked = pickViceRoms(files);
  for (const slot of slots) {
    if (out[slot] || !picked[slot]) continue;
    const bytes = readIfSized(picked[slot].path, SIZES[slot]);
    if (bytes) out[slot] = bytes;
  }
  return slots.every(s => out[s]) ? trim1541(out) : null;
}

// A 1541 ROM sometimes carries a 2-byte header; the machine wants the bare 16K.
function trim1541(roms) {
  if (roms.drive1541 && roms.drive1541.length === 16386) {
    roms.drive1541 = roms.drive1541.subarray(2);
  }
  return roms;
}

function readIfSized(p, sizes) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || !sizes.includes(st.size)) return null;
    return fs.readFileSync(p);
  } catch { return null; }
}

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// pickViceRoms reads {name, size, webkitRelativePath} — the shape a browser
// directory pick hands the app. Depth-capped: a VICE share tree is shallow, and
// nobody wants their home directory walked because $C64_ROMS pointed at it.
function walk(root, dir, files, depth) {
  if (depth > 4 || files.length > 4000) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(root, p, files, depth + 1); continue; }
    if (!e.isFile()) continue;
    let size;
    try { size = fs.statSync(p).size; } catch { continue; }
    files.push({
      name: e.name, size, path: p,
      webkitRelativePath: path.join(path.basename(root), path.relative(root, p)),
    });
  }
}

// Where a VICE install keeps its ROMs on this platform.
function viceDirs() {
  const dirs = [];
  const bases = ['/Applications', path.join(os.homedir(), 'Applications')];
  for (const base of bases) {
    let entries;
    try { entries = fs.readdirSync(base); } catch { continue; }
    for (const e of entries) {
      if (!/vice/i.test(e)) continue;
      dirs.push(path.join(base, e, 'Contents', 'Resources', 'share', 'vice'));
      dirs.push(path.join(base, e, 'share', 'vice'));
      dirs.push(path.join(base, e));
    }
  }
  dirs.push('/usr/local/share/vice', '/opt/homebrew/share/vice', '/usr/share/vice');
  return dirs;
}
