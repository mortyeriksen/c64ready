// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/report.mjs — how the tool talks: quiet mode, times, tables, the progress
// bar. Output is for people at a terminal; batch logs get the same text minus
// the bar, which only a TTY sees.

let quiet = false;

export function setQuiet(q) { quiet = !!q; }

export function say(...parts) { if (!quiet) console.log(...parts); }

/** Errors always land, quiet or not, and on stderr where a batch can see them. */
export function fail(...parts) { console.error(...parts); }

/** 1634.2 → "27:14". Minutes keep counting past the hour: a deck counter has no hours. */
export function mss(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Lay rows out in columns. Every cell is a string; `align` marks each column
 * 'l' or 'r'. The last column is never padded, so damage notes don't trail
 * whitespace into the terminal.
 * @param {string[][]} rows
 * @param {string[]} align
 * @returns {string[]} one string per row
 */
export function columns(rows, align = []) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => { widths[i] = Math.max(widths[i] || 0, cell.length); });
  }
  return rows.map(row => row.map((cell, i) => {
    if (i === row.length - 1) return cell;
    return align[i] === 'r' ? cell.padStart(widths[i]) : cell.padEnd(widths[i]);
  }).join('  ').trimEnd());
}

// The bar redraws in place, so it exists only where "in place" means something.
const tty = process.stdout.isTTY;
const BAR = 20;
let barShowing = false;

export function progress(text, value) {
  if (quiet || !tty) return;
  const filled = Math.round(Math.max(0, Math.min(1, value)) * BAR);
  const bar = '█'.repeat(filled) + '░'.repeat(BAR - filled);
  const pct = String(Math.round(value * 100)).padStart(3);
  process.stdout.write(`\r\x1b[2K  ${text}  ${bar} ${pct}%`);
  barShowing = true;
}

/** Take the bar down before printing anything that should stay on screen. */
export function progressDone() {
  if (!barShowing) return;
  process.stdout.write('\r\x1b[2K');
  barShowing = false;
}
