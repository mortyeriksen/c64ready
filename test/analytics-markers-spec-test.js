// Analytics-marker spec: the network-only pages the app pings for server-side
// stats (/pwa.html, /pwa-installed.html, /roms-loaded.html, /roms-vice.html,
// /returned.html, and /roms-theme-<id>.html for the theme in use).
//
// A marker only works if THREE things agree, and nothing else notices when they
// drift apart: the page exists in public/, the service worker passes it through
// instead of answering from cache, and the build keeps it out of the precache.
// Miss the last two and the beacon is served locally, so the host never logs it
// and the number silently reads zero.

import fs from 'fs';
import { runInNewContext } from 'node:vm';

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

// Markers request the network rather than the browser's cached response.
for (const [, path] of main.matchAll(/fetch\('(\/[a-z0-9-]+\.html)'([^)]*)\)/g)) {
  const call = main.slice(main.indexOf(`fetch('${path}'`));
  expect(/cache: 'no-store'/.test(call.slice(0, 120)),
    `${path}: the beacon must fetch with cache: 'no-store'`);
}

// The theme beacon has a marker for every built-in theme, plus one for all
// imported themes, so no session with ROMs goes uncounted.
const { BUILTIN_THEMES } = await import('../src/ui/themes.js');
const themeMap = main.match(/_ROM_THEME_MARKERS = \{([^}]*)\}/);
const themeKeys = themeMap ? [...themeMap[1].matchAll(/(\w+): '\/roms-theme-(\w+)\.html'/g)].map((m) => (m[1] === m[2] ? m[1] : null)) : [];
for (const id of [...BUILTIN_THEMES.map((b) => b.id), 'custom']) {
  expect(themeKeys.includes(id), `/roms-theme-${id}.html: main.js maps the "${id}" theme to its marker`);
  expect(markers.includes(`/roms-theme-${id}.html`), `/roms-theme-${id}.html: the sw passes it through (ANALYTICS_MARKERS)`);
}

if (failures) {
  console.log(`\n${failures} analytics-marker spec failure(s)`);
  process.exit(1);
}
const pingSource = main.slice(main.indexOf('let _romsPinged = false;'), main.indexOf('// /returned.html:'));
for (const source of ['fetch', 'vice', 'upload', null]) {
  const requests = [];
  const loader = { allLoaded: false };
  const context = {
    loader, _ROM_SOURCE_KEY: 'c64emu.romsSource',
    localStorage: { getItem: () => source },
    fetch: (url, options) => { requests.push([url, options.cache]); return Promise.resolve(); },
  };
  runInNewContext(`${pingSource}\n_pingRomsLoaded();`, context);
  expect(requests.length === 0, 'ROM markers wait until all required ROMs are ready');
  loader.allLoaded = true;
  runInNewContext('_pingRomsLoaded(); _pingRomsLoaded();', context);
  expect(requests.filter(([url]) => url === '/roms-fetched.html').length === 0,
    `restoring ROMs never fires the fetched marker, regardless of saved source (${source})`);
  expect(requests.filter(([url]) => url === '/roms-vice.html').length === 0,
    `restoring ROMs never fires the VICE marker, regardless of saved source (${source})`);
  expect(requests.every(([, cache]) => cache === 'no-store'), 'ROM markers bypass browser caching');
}
if (failures) process.exit(1);
console.log(`ok  - ${markers.length} analytics markers: page, SW passthrough and precache exclusion agree`);
