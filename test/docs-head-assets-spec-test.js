// Every absolute asset path the generated docs <head> points at must exist in
// public/. A wrong one is invisible in development: Vite's dev server answers
// any unknown path with index.html and a 200, so a broken favicon or stylesheet
// looks fine locally and 404s only once deployed.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function expect(cond, msg) {
  if (!cond) { failures++; console.log(`FAIL - ${msg}`); }
}

const build = fs.readFileSync(path.join(root, 'tools', 'build-docs.mjs'), 'utf8');

// Static, absolute hrefs/srcs in the page templates. Interpolated ones are
// skipped — they carry a ${...} and are checked by whatever produces them.
const refs = [...build.matchAll(/(?:href|src)="(\/[^"${]*?)"/g)].map(m => m[1]);
expect(refs.length > 0, 'the docs templates reference some local assets to check');

for (const ref of refs) {
  const file = ref.split(/[?#]/)[0];
  // /docs/* is the build's own output, generated into the gitignored
  // public/docs/ — not something to look for in the tracked tree.
  if (file.startsWith('/docs/')) continue;
  expect(
    fs.existsSync(path.join(root, 'public', file)),
    `docs <head> asset ${ref} exists at public${file}`,
  );
}

// The icon set is duplicated between index.html and the docs template, so they
// drift silently. The ?v= is a cache-buster the app bumps when the artwork
// changes (see the comment in index.html) — a docs page left on an older
// version serves a stale icon from cache.
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const iconOf = (src) => (src.match(/href="(\/icons\/favicon\.svg\?v=\d+)"/) || [])[1];

expect(
  iconOf(indexHtml),
  'index.html links the svg favicon out of /icons/',
);
expect(
  iconOf(build) === iconOf(indexHtml),
  `docs and index.html agree on the favicon URL (docs: ${iconOf(build)}, app: ${iconOf(indexHtml)})`,
);

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('ok  - docs head assets resolve and match the app icons');
