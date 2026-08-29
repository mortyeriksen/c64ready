// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Line coverage of src/ from raw V8 coverage, no tooling dependency.
//
//   NODE_V8_COVERAGE=/tmp/cov node test/all-test.js
//   node tools/coverage.mjs /tmp/cov
//
// Every test process writes one JSON file into the directory. Each function's
// block ranges are painted outermost first so nested zero-count blocks
// overwrite their parent; a code line counts as covered when any of its
// non-blank characters was executed in any process. Comment-only lines are
// not counted. Files no test imports are listed separately: half of src/ is
// browser-only (DOM, WebGL, AudioWorklet) and has no Node entry point.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src') + path.sep;
const dir = process.argv[2];
if (!dir) { console.error('usage: node tools/coverage.mjs <NODE_V8_COVERAGE dir>'); process.exit(2); }

const hits = new Map();          // file → Uint8Array, 1 per covered char
for (const name of fs.readdirSync(dir)) {
  if (!name.endsWith('.json')) continue;
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
  for (const script of data.result ?? []) {
    if (!script.url.startsWith('file://')) continue;
    const file = fileURLToPath(script.url);
    if (!file.startsWith(SRC)) continue;
    let h = hits.get(file);
    if (!h) {
      if (!fs.existsSync(file)) continue;
      h = new Uint8Array(fs.readFileSync(file, 'utf8').length);
      hits.set(file, h);
    }
    const ranges = [];
    for (const fn of script.functions) for (const r of fn.ranges) ranges.push(r);
    ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
    const cov = new Uint8Array(h.length);
    for (const r of ranges) cov.fill(r.count > 0 ? 1 : 0, Math.min(r.startOffset, h.length), Math.min(r.endOffset, h.length));
    for (let i = 0; i < h.length; i++) if (cov[i]) h[i] = 1;
  }
}

const isCode = (line) => { const t = line.trim(); return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); };
const rows = [];
let totalLines = 0, totalHit = 0;
for (const [file, h] of [...hits].sort()) {
  const src = fs.readFileSync(file, 'utf8');
  let pos = 0, lines = 0, hit = 0;
  for (const line of src.split('\n')) {
    if (isCode(line)) {
      lines++;
      for (let j = 0; j < line.length; j++) if (line[j] !== ' ' && line[j] !== '\t' && h[pos + j]) { hit++; break; }
    }
    pos += line.length + 1;
  }
  rows.push({ file: path.relative(ROOT, file), lines, hit, pct: lines ? hit / lines * 100 : 100 });
  totalLines += lines; totalHit += hit;
}
rows.sort((a, b) => a.pct - b.pct);
console.log('  cov%    hit  lines  file');
for (const r of rows) console.log(`${r.pct.toFixed(1).padStart(6)} ${String(r.hit).padStart(6)} ${String(r.lines).padStart(6)}  ${r.file}`);
console.log(`\nloaded: ${rows.length} files, ${totalHit}/${totalLines} code lines = ${(totalHit / totalLines * 100).toFixed(1)}%`);

const all = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) all.push(p); } };
walk(SRC);
const unloaded = all.filter((f) => !hits.has(f)).sort();
let unloadedLines = 0;
for (const f of unloaded) unloadedLines += fs.readFileSync(f, 'utf8').split('\n').filter(isCode).length;
console.log(`never loaded: ${unloaded.length} files, ${unloadedLines} code lines`);
for (const f of unloaded) console.log(`    ${path.relative(ROOT, f)}`);
console.log(`\nall src/: ${totalHit}/${totalLines + unloadedLines} = ${(totalHit / (totalLines + unloadedLines) * 100).toFixed(1)}%`);
