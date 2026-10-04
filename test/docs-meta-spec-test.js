// Every docs page has a description written for search results and share
// cards, set in its source as <!-- description: ... --> under the licence
// header (the License and Notice pages, which have no Markdown source, in
// tools/build-docs.mjs). Each one:
//   1. exists, so no page falls back to a clipped first line;
//   2. is 50 to 160 characters, what previews show without cutting;
//   3. is a whole sentence: capital first, full stop last;
//   4. carries no Markdown or HTML, since it is shown as plain text;
//   5. is its page's own, not shared with another page.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = fs.readFileSync(path.join(root, 'tools/build-docs.mjs'), 'utf8');
const overview = build.match(/INDEX_OVERVIEW_FILE\s*=\s*'([^']+)'/)[1];
const moved = new Set([...(build.match(/MOVED_SOURCES\s*=\s*new Set\(\[([^\]]*)\]/)?.[1] || '').matchAll(/'([^']+)'/g)].map((m) => m[1]));

let failures = 0;
const expect = (cond, msg) => { if (!cond) { failures++; console.log(`FAIL - ${msg}`); } };
const descriptions = [];
for (const f of fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md') && f !== overview && !moved.has(f))) {
  const m = fs.readFileSync(path.join(root, 'docs', f), 'utf8').match(/^(?:<!--[^\n]*-->\s*\n){2}<!--\s*description:\s*([\s\S]*?)\s*-->/);
  expect(m, `${f} has a <!-- description: ... --> under its licence header`);
  if (m) descriptions.push([f, m[1].replace(/\s+/g, ' ')]);
}
for (const [, title, desc] of build.matchAll(/title: '([^']+)',\s*desc: '([^']+)'/g)) descriptions.push([title, desc]);
expect(descriptions.length >= 27, `every page is covered (found ${descriptions.length})`);
const seen = new Map();
for (const [where, d] of descriptions) {
  expect(d.length >= 50 && d.length <= 160, `${where}: description is ${d.length} characters, outside 50 to 160`);
  expect(/^[A-Z0-9]/.test(d) && /\.$/.test(d), `${where}: description is a whole sentence ("${d.slice(0, 40)}…")`);
  expect(!/[[\]`*_<>#|]|—/.test(d), `${where}: description has no Markdown, HTML or em dash`);
  expect(!seen.has(d), `${where}: description is not also ${seen.get(d)}'s`);
  seen.set(d, where);
}

if (failures) { console.log(`\n${failures} docs description failure(s)`); process.exit(1); }
console.log(`ok  - docs descriptions: ${descriptions.length} pages, each its own whole sentence of 50 to 160 characters`);
