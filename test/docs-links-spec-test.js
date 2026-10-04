// Links between the Markdown docs land somewhere real:
//   1. A link to another .md file names a file that exists.
//   2. A link to a heading (#id, or file.md#id) names a heading that file has,
//      with ids made as tools/build-docs.mjs makes them (marked's headings,
//      slugged, a repeated name numbered -2, -3, ...).
//   3. A link to a User Guide heading that moved to a topic page is covered by
//      the hub's redirect (tools/user-guide-anchors.mjs), and every redirect
//      lands on a heading that exists.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { marked } from 'marked';
import { USER_GUIDE_ANCHORS } from '../tools/user-guide-anchors.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'section';
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const idCache = new Map();
function ids(file) {
  if (!idCache.has(file)) {
    const used = new Set();
    for (const m of marked.parse(fs.readFileSync(file, 'utf8')).matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)) {
      const base = slug(decode(m[2].replace(/<[^>]+>/g, '')).trim());
      let id = base, n = 1;
      while (used.has(id)) id = `${base}-${++n}`;
      used.add(id);
    }
    idCache.set(file, used);
  }
  return idCache.get(file);
}

let failures = 0, checked = 0;
const expect = (cond, msg) => { checked++; if (!cond) { failures++; console.log(`FAIL - ${msg}`); } };
const redirects = USER_GUIDE_ANCHORS;
const guide = path.join(root, 'docs/USER-GUIDE.md');

const files = execSync("git ls-files '*.md'", { cwd: root, encoding: 'utf8' }).trim().split('\n')
  .concat(fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`))
  .filter((f, i, all) => all.indexOf(f) === i && !f.startsWith('investigation/') && !f.startsWith('node_modules/') && fs.existsSync(path.join(root, f)));
for (const rel of files) {
  const file = path.join(root, rel);
  const text = fs.readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z]+:/i.test(target) || target.startsWith('/')) continue;
    const [ref, hash] = target.split('#');
    if (ref && !ref.endsWith('.md')) continue;
    const dest = ref ? path.resolve(path.dirname(file), ref) : file;
    if (ref) expect(fs.existsSync(dest), `${rel}: ${target} names a file that exists`);
    if (!hash || !fs.existsSync(dest)) continue;
    const ok = ids(dest).has(hash) || (dest === guide && redirects[hash]);
    expect(ok, `${rel}: ${target} names a heading in ${path.relative(root, dest)}${dest === guide ? ' or one the hub redirects' : ''}`);
  }
}
for (const [old, to] of Object.entries(redirects)) {
  const [page, id] = to.split('#');
  const md = path.join(root, 'docs', page.replace('.html', '').toUpperCase() + '.md');
  expect(fs.existsSync(md) && ids(md).has(id), `the hub redirects #${old} to ${to}, a heading that exists`);
  expect(!ids(guide).has(old), `#${old} is redirected only because the hub no longer has it`);
}

if (failures) { console.log(`\n${failures} of ${checked} docs link check(s) failed`); process.exit(1); }
console.log(`ok  - docs links: ${checked} links and redirects land on files and headings that exist`);
