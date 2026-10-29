import assert from 'node:assert/strict';
import { ROMLoader } from '../src/roms.js';
import { fetchRomSources, romSourceUrl } from '../src/ui/rom-setup.js';

const cache = new Map();
globalThis.localStorage = { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value), removeItem: key => cache.delete(key) };
for (const url of ['javascript:alert(1)', 'file:///rom.bin', 'https://user:pass@example.test/rom']) {
  assert.throws(() => romSourceUrl(url), undefined, 'ROM downloads accept only credential-free HTTP(S) URLs');
}
assert.equal(romSourceUrl('  https://example.test/rom.bin  '), 'https://example.test/rom.bin', 'pasted links ignore surrounding whitespace');
const loader = new ROMLoader();
const urls = Object.fromEntries(['kernal', 'basic', 'charRom', 'drive1541'].map(key => [key, `https://example.test/${key}.bin`]));
const statuses = {};
const events = [];
loader.onUserRom = (key, source) => events.push([key, source]);
await fetchRomSources(loader, urls, (key, status) => { statuses[key] = status; }, async url => {
  const key = new URL(url).pathname.slice(1, -4);
  if (key === 'kernal') return new Response('unavailable', { status: 503 });
  return new Response(new Uint8Array(key === 'charRom' ? 12 : key === 'drive1541' ? 16386 : 8192));
});
assert.equal(loader.kernal, null, 'failed HTTP responses cannot install a ROM');
assert.equal(loader.charRom, null, 'wrong-size downloads cannot install a ROM');
assert.equal(loader.basic.length, 8192, 'one failed download does not discard successful ROMs');
assert.equal(loader.drive1541.length, 16386, '1541 downloads accept the optional two-byte header');
assert.match(statuses.kernal, /503/, 'download failures identify the failing HTTP response');
assert.match(statuses.charRom, /4096/, 'size failures explain the required ROM size');
const requested = [];
await fetchRomSources(loader, urls, (key, status) => { statuses[key] = status; }, async (url, options) => {
  requested.push(url);
  assert.equal(options.credentials, 'omit', 'ROM downloads do not send credentials');
  return new Response(new Uint8Array(url.includes('charRom') ? 4096 : 8192));
});
assert.deepEqual(requested.sort(), [urls.charRom, urls.kernal].sort(), 'retry fetches only missing ROMs');
assert.equal(loader.allLoaded, true, 'the required trio makes the emulator ready');
assert.equal(events.length, 4, 'each installed ROM emits one user-supplied event');
assert.ok(events.every(([, source]) => source === 'fetch'), 'downloads identify their source');
const restored = new ROMLoader();
await restored.autoLoad();
assert.equal(restored.cachedCount, 4, 'downloaded ROMs survive reload through browser storage');
const missing = new ROMLoader();
await fetchRomSources(missing, {}, (key, status) => { statuses[key] = status; }, () => { throw new Error('No download expected'); });
assert.equal(statuses.kernal, 'Enter a ROM link.', 'blank required links ask for input');
assert.equal(statuses.drive1541, 'Optional, no link supplied', 'blank optional drive link is allowed');
console.log('ok  - ROM downloads validate, cache, report failures and retry only missing files');
