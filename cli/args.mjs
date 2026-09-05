// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/args.mjs — the flag parser, hand-rolled so the tool ships no dependencies.
//
// A command declares its flags as { name: { value: true, alias: 'o' } }; what
// comes back is { args, flags } with flags under their long names. Unknown
// flags are refused by name — a typo should say so, not be silently ignored.

import fs from 'node:fs';
import path from 'node:path';

/** A wrong invocation rather than a failed run — the entry exits 2 for these. */
export class UsageError extends Error {}

// On every command, parsed before the command sees them.
const GLOBAL = {
  help: {},
  version: {},
  quiet: {},
  force: {},
};

/**
 * @param {string[]} argv  everything after the command word
 * @param {object} spec   { longName: { value?: true, alias?: 'x' } }
 * @returns {{ args: string[], flags: object }}
 */
export function parseArgs(argv, spec = {}) {
  const known = { ...GLOBAL, ...spec };
  const byAlias = {};
  for (const [name, s] of Object.entries(known)) {
    if (s.alias) byAlias[s.alias] = name;
  }

  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { args.push(...argv.slice(i + 1)); break; }
    if (a === '-' || !a.startsWith('-')) { args.push(a); continue; }

    let name, inline = null;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (eq >= 0) inline = a.slice(eq + 1);
    } else {
      if (a.length !== 2) throw new UsageError(`Unknown flag ${a}`);
      name = byAlias[a[1]];
      if (!name) throw new UsageError(`Unknown flag ${a}`);
    }
    const s = known[name];
    if (!s) throw new UsageError(`Unknown flag --${name}`);

    if (!s.value) {
      if (inline !== null) throw new UsageError(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    let v = inline;
    if (v === null) {
      if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
      v = argv[++i];
    }
    flags[name] = v;
  }
  return { args, flags };
}

/** A flag that must be a number when present. */
export function numberFlag(flags, name) {
  if (flags[name] === undefined) return undefined;
  const n = Number(flags[name]);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} needs a number, got "${flags[name]}"`);
  return n;
}

/** A flag that counts something: whole, and at least one. */
export function countFlag(flags, name) {
  const n = numberFlag(flags, name);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n) || n < 1) {
    throw new UsageError(`--${name} counts, so it needs a whole number of 1 or more, got "${flags[name]}"`);
  }
  return n;
}

/** A flag that measures something: any number above zero. */
export function positiveFlag(flags, name) {
  const n = numberFlag(flags, name);
  if (n === undefined) return undefined;
  if (n <= 0) throw new UsageError(`--${name} needs a number above 0, got "${flags[name]}"`);
  return n;
}

// A shell expands `*.wav` before the tool ever sees it, so on a Unix terminal
// wildcards already work. They do not when the pattern is quoted, and they do
// not on Windows, where the shell hands the pattern over untouched. So the
// tool expands what is left: an argument that holds a wildcard and does not
// name a file that exists.
const WILDCARD = /[*?[]/;
const caseBlind = process.platform === 'darwin' || process.platform === 'win32';

/**
 * A shell's wildcards, as a regular expression: `*` any run, `?` one
 * character, `[abc]` and `[a-z]` a set, `[!abc]` anything but. Read a
 * character at a time, because chained replacements mangle their own escaping.
 */
function globRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') { re += '.*'; continue; }
    if (c === '?') { re += '.'; continue; }
    if (c === '[') {
      const close = pattern.indexOf(']', i + 2);
      if (close > 0) {
        let body = pattern.slice(i + 1, close);
        const not = body[0] === '!' || body[0] === '^';
        if (not) body = body.slice(1);
        re += `[${not ? '^' : ''}${body.replace(/[\\\]]/g, '\\$&')}]`;
        i = close;
        continue;
      }
    }
    re += c.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, caseBlind ? 'i' : '');
}

/**
 * The input files a command was given, with any wildcard expanded — sorted, so
 * a batch runs in the same order everywhere. An argument that names a file
 * that exists is left alone, wildcard or not: a real file wins over a pattern.
 * @param {string[]} args  positionals, as parseArgs returned them
 * @returns {string[]}
 */
export function inputFiles(args) {
  const out = [];
  for (const arg of args) {
    if (!WILDCARD.test(arg)) {
      // A file that is not there gets named now, next to what is: a long
      // shell-escaped path is one mistyped character from a file that exists,
      // and ENOENT alone leaves finding that character to the reader. It is an
      // input that failed, not wrong usage — the command was used correctly —
      // so it is the ordinary kind of error, and exits 1.
      if (!fs.existsSync(arg)) {
        const stem = path.basename(arg).replace(/\.[^.]*$/, '');
        let near = [];
        try { near = fs.readdirSync(path.dirname(arg)).filter(n => n.startsWith(stem)); } catch {}
        throw new Error(`no such file: ${arg}` +
          (near.length ? `\n  though this is there: ${near.sort().join(', ')}` : ''));
      }
      out.push(arg);
      continue;
    }
    if (fs.existsSync(arg)) { out.push(arg); continue; }
    const dir = path.dirname(arg);
    const pattern = path.basename(arg);
    if (WILDCARD.test(dir)) {
      throw new UsageError(`a wildcard belongs in the file name, not the folder: ${arg}`);
    }
    const re = globRegExp(pattern);
    let names;
    try { names = fs.readdirSync(dir); } catch { names = []; }
    const found = names.filter(n => re.test(n)).sort().map(n => path.join(dir, n));
    if (!found.length) throw new UsageError(`nothing matches ${arg}`);
    out.push(...found);
  }
  return out;
}
