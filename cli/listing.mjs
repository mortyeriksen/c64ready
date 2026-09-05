// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/listing.mjs — THE listing. `dir` prints it, `wav2tap` prints it after a
// conversion, `loadtest` prints it with a load result appended — one renderer,
// so a file never reads one way in one command and differently in the next.

import { say, mss, columns } from './report.mjs';

// The decoder's names for a format vs what a listing calls it. CBM is the
// KERNAL's own format, and "KERNAL" is what a person winding a tape calls it.
const FORMAT_NAMES = { 'CBM': 'KERNAL', 'Turbo Tape 64': 'Turbo', 'GRL-Supertape': 'GRL' };
const formatName = f => FORMAT_NAMES[f] || f;
// The header line spells them out in full.
const FORMAT_FULL = { 'CBM': 'KERNAL' };
const formatFull = f => FORMAT_FULL[f] || f;

const hex = n => '$' + n.toString(16).toUpperCase().padStart(4, '0');
const sizeOf = n => (n < 1024 ? `${n}B` : `${Math.round(n / 1024)}K`);

/** One phrase for a row's damage, in the terms a person can act on. */
export function damageText(damage) {
  if (!damage) return 'ok';
  if (damage.kind === 'lost') {
    // No holes means the tape kept going but came back unreadable — garbled,
    // not dropped, and the row should say which.
    if (!damage.holes) return damage.bytes ? `${damage.bytes} bytes garbled` : 'a few bits garbled';
    const holes = damage.holes === 1 ? '1 drop' : `${damage.holes} drops`;
    return damage.bytes ? `${holes}, ${damage.bytes} bytes lost` : holes;
  }
  if (damage.kind === 'checksum') return 'checksum fails';
  if (damage.kind === 'short') return 'cut short';
  return damage.kind;
}

/**
 * The tape listing.
 * @param {object} o
 * @param {string} o.name        what to head the listing with
 * @param {Array}  o.files       tapDirectory rows
 * @param {object} [o.facts]     tapeFacts for the same tape
 * @param {number} [o.seconds]   how long the tape plays
 * @param {object} [o.flags]     damaged / seconds / pulses, from `dir`
 * @param {Map}    [o.loads]     file → load-result text, from `loadtest`
 */
export function tapeListing({ name, files, facts, seconds, flags = {}, loads = null }) {
  const time = flags.seconds ? (s => s.toFixed(1)) : mss;

  say(`\n${name}`);
  const head = [];
  if (seconds) head.push(mss(seconds));
  if (facts) {
    if (facts.formats.length) head.push(facts.formats.map(formatFull).join(' + '));
    head.push(`${facts.files} ${facts.files === 1 ? 'file' : 'files'}, ${facts.sound} readable`);
  }
  if (head.length) say(head.join('  ·  '));
  if (facts?.speed && Math.abs(facts.speed.percent) >= 0.3) {
    const off = Math.abs(facts.speed.percent);
    say(`The deck that wrote this ran ${off}% ${facts.speed.percent > 0 ? 'fast' : 'slow'}`);
  }
  if (facts?.unread > 15) {
    say(`${mss(facts.unread)} carries a signal nothing here could read`);
  }

  const rows = flags.damaged ? files.filter(f => f.damaged) : files;
  if (!files.length) { say('\nNo files found on this tape.'); return; }
  if (!rows.length) { say('\nNothing damaged — all files read.'); return; }
  say('');

  const header = ['  #', 'WIND TO', 'STARTS', 'NAME', 'FORMAT', 'LOAD', 'SIZE', 'STATUS'];
  const align = ['r', 'r', 'r', 'l', 'l', 'l', 'r', 'l'];
  if (flags.pulses) { header.splice(3, 0, 'LEAD-P', 'AT-P'); align.splice(3, 0, 'r', 'r'); }
  if (loads) { header.push('LOADS'); align.push('l'); }

  const body = rows.map(f => {
    const n = files.indexOf(f) + 1;
    const row = [
      `  ${n}`, time(f.startSeconds), time(f.atSeconds),
      f.name || '(no name)', formatName(f.format),
      `${hex(f.start)}-${hex(f.end)}`, sizeOf(f.size),
      damageText(f.damage),
    ];
    if (flags.pulses) row.splice(3, 0, String(f.leadPulse ?? ''), String(f.atPulse ?? ''));
    if (loads) row.push(loads.get(f) ?? '');
    return row;
  });
  for (const line of columns([header, ...body], align)) say(line);
}

/**
 * The disk listing, shaped like LOAD"$",8 because that is the directory's
 * native look — block counts first, quoted names, the type after.
 * @param {string} name  what to head the listing with
 * @param {D64} disk
 */
export function diskListing(name, disk) {
  say(`\n${name}`);
  say(`"${printable(disk.diskName)}" ${printable(disk.diskId)} ${printable(disk.dosType)}` +
    `  ·  ${disk.trackCount} tracks  ·  ${disk.freeBlocks} blocks free`);
  const entries = disk.entries.filter(e => !e.deleted);
  if (!entries.length) { say('\nNo files on this disk.'); return; }
  say('');
  const rows = entries.map(e => [
    `  ${e.blocks}`, `"${printable(e.name)}"`,
    `${e.closed ? '' : '*'}${e.type}${e.locked ? '<' : ''}`,
  ]);
  for (const line of columns([['  BLOCKS', 'NAME', 'TYPE'], ...rows], ['r', 'l', 'l'])) say(line);
}

/**
 * The archive listing — what a .t64 holds. `dir` prints it as it stands;
 * t642d64 and t642tap print it with each file's destination appended, the way
 * loadtest appends to the tape listing; d642t64 prints the entries it just
 * wrote. One renderer, for the reason at the top of this file.
 * @param {string} name  what to head the listing with
 * @param {object} t     { name: label, files, skipped } as t64Files shapes them
 * @param {Map} [to]     file → destination text
 */
export function archiveListing(name, { name: label, files, skipped = [] }, to = null) {
  say(`\n${name}${label ? `  ·  "${printable(label)}"` : ''}`);
  if (!files.length && !skipped.length) { say('No files in this archive.'); return; }
  const rows = [
    ['  #', 'NAME', 'LOAD', 'SIZE', ''],
    ...files.map((f, i) => [`  ${i + 1}`, printable(f.name), `${hex(f.start)}-${hex(f.end)}`,
      sizeOf(f.end - f.start), `${to?.get(f) ?? ''}${f.note ? `  (${f.note})` : ''}`]),
    ...skipped.map(s => ['  -', printable(s.name), '', '', `skipped — ${s.why}`]),
  ];
  for (const line of columns(rows, ['r', 'l', 'r', 'r', 'l'])) say(line);
}

// Directory names are PETSCII byte strings and can hold control codes; a
// terminal gets the printable ones and a dot where art was.
export function printable(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.charCodeAt(0);
    out += (c >= 0x20 && c < 0x7F) ? ch : '.';
  }
  return out;
}
