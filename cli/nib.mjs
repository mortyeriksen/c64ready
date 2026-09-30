// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/nib.mjs — nbz2g64: a nibbler dump as a .g64. The conversion is
// src/media/nib.js, shared with the app.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, inputFiles, UsageError } from './args.mjs';
import { sniff } from './formats.mjs';
import { say, fail } from './report.mjs';
import { outFileFor, oneOutputOnly, writeOut } from './tape.mjs';
import { nibFileToG64 } from './core.mjs';

function conversionListing(report) {
  say('');
  say('  TRACK  ZONE  BYTES  START        NOTES');
  for (const r of report) {
    const track = (r.halfTrack / 2).toFixed(1).padStart(5);
    const notes = [];
    if (r.halfTrack & 1) notes.push('half-track');
    if (r.weak) notes.push(`weak ${r.weak}`);
    if (r.syncCut) notes.push(`sync -${r.syncCut}`);
    if (r.truncated) notes.push(`cut -${r.truncated}`);
    const bytes = r.length ? String(r.length).padStart(5) : '    -';
    say(`  ${track}  ${String(r.zone).padStart(4)}  ${bytes}  ${r.align.padEnd(11)}  ${notes.join(', ')}`.trimEnd());
  }
  const recorded = report.filter(r => r.length);
  const whole = recorded.filter(r => !(r.halfTrack & 1)).length, halves = recorded.length - whole;
  const blank = report.length - recorded.length;
  const parts = [`${whole} ${whole === 1 ? 'track' : 'tracks'}`];
  if (halves) parts.push(`${halves} half-${halves === 1 ? 'track' : 'tracks'}`);
  if (blank) parts.push(`${blank} unformatted`);
  const longest = Math.max(0, ...recorded.map(r => r.length));
  say(`\n${parts.join(', ')} recorded; longest ${longest} bytes.`);
}

/**
 * c64rdy nbz2g64 <in.nbz…> [-o out.g64] [--out-dir <dir>] [--force]
 */
export function nbz2g64(argv) {
  const { args, flags } = parseArgs(argv, {
    out: { value: true, alias: 'o' }, 'out-dir': { value: true },
  });
  if (!args.length) throw new UsageError('Usage: c64rdy nbz2g64 <in.nbz…> [-o out.g64]');
  const files = inputFiles(args);
  oneOutputOnly(flags, files.length);
  let failed = false;
  for (const p of files) {
    try {
      const bytes = fs.readFileSync(p);
      if (sniff(bytes, p) !== 'nbz') throw new Error('this command takes a .nbz nibbler dump');
      const { g64, report, version } = nibFileToG64(bytes);
      const out = outFileFor(p, '.g64', flags, files.length);
      writeOut(out, g64, flags);
      say(`${path.basename(p)} → ${out}  (NIB v${version}, ${g64.length} bytes)`);
      conversionListing(report);
    } catch (e) {
      fail(`${p}: ${e.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}
