// Analytics-marker spec: the network-only pages the app pings for server-side
// stats (/pwa.html, /pwa-installed.html, /roms-loaded.html, /roms-vice.html).
//
// A marker only works if THREE things agree, and nothing else notices when they
// drift apart: the page exists in public/, the service worker passes it through
// instead of answering from cache, and the build keeps it out of the precache.
// Miss the last two and the beacon is served locally, so the host never logs it
// and the number silently reads zero.

import fs from 'fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sw = read('src/sw.js');
const viteConfig = read('vite.config.js');
const main = read('src/main.js');

let failures = 0;
function expect(cond, msg) {
  if (!cond) { failures++; console.log(`FAIL - ${msg}`); }
}

// The set the service worker refuses to intercept is the source of truth.
const setLiteral = sw.match(/ANALYTICS_MARKERS = new Set\(\s*\[([^\]]*)\]/);
const markers = setLiteral ? [...setLiteral[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];

expect(markers.length >= 4, `expected at least 4 markers in sw.js, found ${markers.length}`);
expect(/ANALYTICS_MARKERS\.has\(url\.pathname\)/.test(sw),
  'the sw fetch handler must bypass every path in ANALYTICS_MARKERS');

for (const path of markers) {
  const file = path.slice(1);
  expect(fs.existsSync(new URL(`../public/${file}`, import.meta.url)),
    `${path}: public/${file} must exist, or the beacon logs a 404`);
  expect(viteConfig.includes(`'**/${file}'`),
    `${path}: vite.config globIgnores must exclude it, or it is served from the precache`);
  expect(main.includes(`'${path}'`),
    `${path}: nothing in main.js fetches it`);
}

// Each beacon dedupes through its own localStorage key, and asks for the
// network rather than whatever the browser cached last time.
for (const [, path] of main.matchAll(/fetch\('(\/[a-z0-9-]+\.html)'([^)]*)\)/g)) {
  const call = main.slice(main.indexOf(`fetch('${path}'`));
  expect(/cache: 'no-store'/.test(call.slice(0, 120)),
    `${path}: the beacon must fetch with cache: 'no-store'`);
}

if (failures) {
  console.log(`\n${failures} analytics-marker spec failure(s)`);
  process.exit(1);
}
console.log(`ok  - ${markers.length} analytics markers: page, SW passthrough and precache exclusion agree`);
