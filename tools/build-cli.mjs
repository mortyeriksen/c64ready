// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// tools/build-cli.mjs — stage and pack the c64rdy npm package.
//
// The CLI lives in cli/ and imports the engine from ../src/, so a package rooted
// at cli/ alone would ship with every import broken. This stages dist/c64rdy/
// with cli/ beside exactly the src/ files the CLI reaches (followed
// transitively), a manifest npm can publish, the README and the LICENSE, then
// runs `npm pack` there. The source tree is not touched; dist/ is git-ignored.
//
//   npm run build:cli        → dist/c64rdy-<version>.tgz

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'c64rdy');
const IMPORT = /(?:from\s+|import\()\s*['"](\.[^'"]+)['"]/g;

// Every src/ file the CLI imports, followed until nothing new turns up.
function srcClosure() {
  const seen = new Set();
  const queue = [];
  const take = (file) => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    for (const m of text.matchAll(IMPORT)) {
      const target = path.normalize(path.join(path.dirname(file), m[1]));
      const rel = path.relative(ROOT, target);
      if ((rel === 'src' || rel.startsWith('src/')) && !seen.has(rel)) { seen.add(rel); queue.push(target); }
    }
  };
  for (const dir of ['cli', 'cli/workers']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (f.endsWith('.mjs')) take(path.join(ROOT, dir, f));
    }
  }
  while (queue.length) take(queue.shift());
  return [...seen].sort();
}

const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

fs.rmSync(OUT, { recursive: true, force: true });

// cli/: the source and its workers — not the tests, docs or dev tooling.
for (const f of fs.readdirSync(path.join(ROOT, 'cli'))) {
  if (f.endsWith('.mjs')) copy(path.join(ROOT, 'cli', f), path.join(OUT, 'cli', f));
}
for (const f of fs.readdirSync(path.join(ROOT, 'cli/workers'))) {
  if (f.endsWith('.mjs')) copy(path.join(ROOT, 'cli/workers', f), path.join(OUT, 'cli/workers', f));
}

// The engine, exactly as far as the CLI reaches into it.
const src = srcClosure();
for (const rel of src) copy(path.join(ROOT, rel), path.join(OUT, rel));

// Two manifests. The root one is what npm publishes: the bin moves under cli/,
// `private` and the dev scripts go, and `files` names what ships. The copy
// under cli/ is where c64rdy.mjs reads its own version (`./package.json`).
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'cli/package.json'), 'utf8'));
delete pkg.private;
delete pkg.scripts;
pkg.bin = { c64rdy: './cli/c64rdy.mjs' };
pkg.files = ['cli', 'src'];
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'cli/package.json'),
  JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module' }, null, 2) + '\n');

copy(path.join(ROOT, 'LICENSE'), path.join(OUT, 'LICENSE'));
copy(path.join(ROOT, 'cli/README.md'), path.join(OUT, 'README.md'));

const out = execFileSync('npm', ['pack', '--pack-destination', DIST], { cwd: OUT, encoding: 'utf8' });
const tgz = out.trim().split('\n').pop();
const kb = (fs.statSync(path.join(DIST, tgz)).size / 1024).toFixed(0);
console.log(`staged cli/ + ${src.length} src files in dist/c64rdy/`);
console.log(`dist/${tgz}  (${kb} KB)`);
