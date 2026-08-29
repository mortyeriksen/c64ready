// ROM cache spec: ROMLoader's localStorage-backed cache for user uploads.
//
// Behaviour pinned here:
//   • _saveToCache + _loadFromCache round-trip every ROM type
//   • One fixed key per ROM type → uploading a second time overwrites,
//     no growth in localStorage
//   • Wrong-size cache entries are evicted on read
//   • clearCache wipes all four slots
//   • autoLoad falls back to the cache when the server fetch fails
//
// Node has no global localStorage / fetch / btoa / atob, so install
// minimal shims before importing ROMLoader.

const store = new Map();
globalThis.localStorage = {
  getItem: k => store.has(k) ? store.get(k) : null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

// Node 16+ has Buffer; emulate btoa/atob if not provided.
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = s => Buffer.from(s, 'binary').toString('base64');
}
if (typeof globalThis.atob !== 'function') {
  globalThis.atob = b64 => Buffer.from(b64, 'base64').toString('binary');
}

const { ROMLoader, _ROM_SPEC } = await import('../src/roms.js');

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { testsFailing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

function reset() {
  store.clear();
}

function makeRom(size, seed = 0xA5) {
  const u8 = new Uint8Array(size);
  for (let i = 0; i < size; i++) u8[i] = (seed + i) & 0xFF;
  return u8;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── 1: round-trip every ROM type through the cache (bytes + filename) ──
{
  reset();
  const loader = new ROMLoader();
  const fixtures = {
    kernal:    { data: makeRom(8192,  0x10), name: 'my-kernal.bin' },
    basic:     { data: makeRom(8192,  0x20), name: 'my-basic.rom'  },
    charRom:   { data: makeRom(4096,  0x30), name: 'chargen.bin'   },
    drive1541: { data: makeRom(16384, 0x40), name: '1541-II.rom'   },
  };
  for (const [key, fx] of Object.entries(fixtures)) {
    loader._saveToCache(key, fx.data, fx.name);
  }
  for (const [key, fx] of Object.entries(fixtures)) {
    const got = loader._loadFromCache(key);
    expect(got !== null, `${key}: cache miss after save`);
    expect(got && bytesEqual(got.data, fx.data), `${key}: bytes mismatch after round-trip`);
    expect(got && got.name === fx.name, `${key}: filename mismatch, got ${got?.name}`);
  }
  ok('rom-cache: round-trips bytes + filename through localStorage');
}

// ── 2: missing key returns null ─────────────────────────────────────────
{
  reset();
  const loader = new ROMLoader();
  for (const key of ['kernal', 'basic', 'charRom', 'drive1541']) {
    expect(loader._loadFromCache(key) === null, `${key}: missing-key must return null`);
  }
  ok('rom-cache: missing-key reads return null');
}

// ── 3: wrong-size cached entry is rejected AND evicted ──────────────────
{
  reset();
  const loader = new ROMLoader();
  const bogus = makeRom(100, 0xFF);
  loader._saveToCache('kernal', bogus, 'bad.bin'); // will get evicted on read
  expect(store.has(_ROM_SPEC.kernal.key),
    `pre-condition: slot must contain the bogus entry`);
  const got = loader._loadFromCache('kernal');
  expect(got === null, `bogus entry must be rejected on read`);
  expect(!store.has(_ROM_SPEC.kernal.key),
    `bogus entry must be evicted from storage on rejection`);
  ok('rom-cache: wrong-size entries are evicted on read');
}

// ── 3b: malformed JSON in slot is evicted on read ───────────────────────
{
  reset();
  const loader = new ROMLoader();
  store.set(_ROM_SPEC.kernal.key, 'not-json-at-all');
  const got = loader._loadFromCache('kernal');
  expect(got === null, `unparseable JSON must be rejected`);
  expect(!store.has(_ROM_SPEC.kernal.key),
    `unparseable entry must be evicted from storage`);
  ok('rom-cache: unparseable JSON entries are evicted on read');
}

// ── 4: re-saving overwrites in place — no growth ────────────────────────
{
  reset();
  const loader = new ROMLoader();
  loader._saveToCache('kernal', makeRom(8192, 0x11), 'first.bin');
  loader._saveToCache('kernal', makeRom(8192, 0x22), 'second.bin');
  // Exactly one entry exists for KERNAL; saving a different ROM uses a
  // different fixed key.
  expect(store.size === 1, `KERNAL slot should remain single, got store.size=${store.size}`);
  const got = loader._loadFromCache('kernal');
  expect(got && got.data[0] === 0x22, `re-save must overwrite bytes; got 0x${got?.data?.[0]?.toString(16)}`);
  expect(got && got.name === 'second.bin', `re-save must update filename; got ${got?.name}`);
  ok('rom-cache: re-saving overwrites the single slot per ROM type');
}

// ── 5: clearCache wipes every slot ──────────────────────────────────────
{
  reset();
  const loader = new ROMLoader();
  loader._saveToCache('kernal',    makeRom(8192),  'k.bin');
  loader._saveToCache('basic',     makeRom(8192),  'b.bin');
  loader._saveToCache('charRom',   makeRom(4096),  'c.bin');
  loader._saveToCache('drive1541', makeRom(16384), 'd.bin');
  expect(store.size === 4, `pre-condition: all 4 slots present`);
  loader.clearCache();
  expect(store.size === 0, `clearCache must wipe all 4 slots, got store.size=${store.size}`);
  ok('rom-cache: clearCache removes every slot');
}

// ── 6: _loadFile cache write-through (bytes + filename) ─────────────────
// Skip the FileReader path (no File in Node) and exercise the post-
// validation logic directly: assigning the byte array, saving to cache,
// and updating the displayed name reflects what _loadFile does on
// success.
{
  reset();
  const loader = new ROMLoader();
  const kernalData = makeRom(8192, 0x55);
  loader.kernal = kernalData;
  loader._saveToCache('kernal', kernalData, '901227-03.bin');
  loader._setName('kernal', '901227-03.bin');
  const cached = loader._loadFromCache('kernal');
  expect(cached && bytesEqual(cached.data, kernalData),
    `upload-write-through must persist exact bytes`);
  expect(cached && cached.name === '901227-03.bin',
    `upload-write-through must persist filename, got ${cached?.name}`);
  expect(loader.romNames.kernal === '901227-03.bin',
    `_setName must update romNames`);
  ok('rom-cache: upload write-through persists bytes + filename');
}

// ── 7: autoLoad falls back to cache when server returns 404 ─────────────
{
  reset();
  // Pre-populate the cache with all three required ROMs.
  const loader = new ROMLoader();
  const kernal  = makeRom(8192,  0x11);
  const basic   = makeRom(8192,  0x22);
  const charRom = makeRom(4096,  0x33);
  loader._saveToCache('kernal',  kernal,  'cached-kernal.bin');
  loader._saveToCache('basic',   basic,   'cached-basic.bin');
  loader._saveToCache('charRom', charRom, 'cached-chargen.bin');

  // Stub fetch so all server requests fail.
  globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });

  // Fresh loader for the autoLoad — its cachedCount should reflect 3.
  const fresh = new ROMLoader();
  let readyArg = null;
  fresh.onReady(roms => { readyArg = roms; });
  const loaded = await fresh.autoLoad();
  expect(loaded === 3, `autoLoad must report 3 required ROMs loaded from cache, got ${loaded}`);
  expect(fresh.cachedCount === 3, `cachedCount must be 3, got ${fresh.cachedCount}`);
  expect(fresh.kernal && bytesEqual(fresh.kernal, kernal),
    `KERNAL must be the cached bytes after server miss`);
  expect(fresh.romNames.kernal === 'cached-kernal.bin',
    `romNames.kernal must come from the cache, got ${fresh.romNames.kernal}`);
  expect(fresh.romNames.basic === 'cached-basic.bin',
    `romNames.basic must come from the cache, got ${fresh.romNames.basic}`);
  expect(fresh.romNames.charRom === 'cached-chargen.bin',
    `romNames.charRom must come from the cache, got ${fresh.romNames.charRom}`);
  expect(readyArg && readyArg.kernal === fresh.kernal,
    `onReady must fire when all required ROMs are loaded`);
  ok('rom-cache: autoLoad falls back to cache on server miss (with filenames)');
}

// ── 8: cache takes priority over the server (cache wins) ───────────────
// The user explicitly uploaded their own ROM into the cache; on the next
// page load that choice must persist even if /roms/*.bin still exists on
// the server with different bytes. Server fetch is the fallback path.
{
  reset();
  const loader = new ROMLoader();
  const cachedKernal = makeRom(8192, 0xCC);
  loader._saveToCache('kernal', cachedKernal, 'my-kernal.bin');

  const serverKernal = makeRom(8192, 0xDD);
  let serverFetchedKernal = false;
  globalThis.fetch = async (url) => {
    if (url.endsWith('/kernal.bin')) {
      serverFetchedKernal = true;
      return { ok: true, status: 200,
               arrayBuffer: async () => serverKernal.buffer };
    }
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  };

  const fresh = new ROMLoader();
  await fresh.autoLoad();
  expect(fresh.kernal && bytesEqual(fresh.kernal, cachedKernal),
    `cached bytes must win over server bytes`);
  expect(fresh.romNames.kernal === 'my-kernal.bin',
    `cached filename must win, got ${fresh.romNames.kernal}`);
  expect(serverFetchedKernal === false,
    `server fetch for KERNAL must be skipped when the cache hit`);
  expect(fresh.cachedCount === 1,
    `cachedCount must be 1 (KERNAL came from cache), got ${fresh.cachedCount}`);
  ok('rom-cache: cache takes priority; server fetch is skipped on hit');
}

// ── 9: onNamesChanged fires after autoLoad ──────────────────────────────
{
  reset();
  const loader = new ROMLoader();
  loader._saveToCache('kernal',  makeRom(8192), 'k.rom');
  loader._saveToCache('basic',   makeRom(8192), 'b.rom');
  loader._saveToCache('charRom', makeRom(4096), 'c.rom');
  globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
  const fresh = new ROMLoader();
  let captured = null;
  fresh.onNamesChanged = (names) => { captured = names; };
  await fresh.autoLoad();
  expect(captured !== null, `onNamesChanged must have fired`);
  expect(captured?.kernal === 'k.rom' && captured?.basic === 'b.rom' && captured?.charRom === 'c.rom',
    `onNamesChanged callback must receive the loaded names`);
  ok('rom-cache: onNamesChanged callback fires after autoLoad');
}

// ── 10: the server path — good ROMs land, a wrong size is rejected ──────
// An empty cache, a server that has everything: all four slots fill, the
// names come from the URLs, and a drive ROM with a 2-byte header is accepted.
{
  reset();
  const served = {
    '/roms/kernal.bin':  makeRom(8192,  0x11),
    '/roms/basic.bin':   makeRom(8192,  0x22),
    '/roms/chargen.bin': makeRom(4096,  0x33),
    '/roms/1541.bin':    makeRom(16386, 0x44),
  };
  globalThis.fetch = async (url) => ({ ok: true, status: 200, arrayBuffer: async () => served[url].buffer });
  const loader = new ROMLoader();
  let readyArg = null;
  loader.onReady(roms => { readyArg = roms; });
  const loaded = await loader.autoLoad();
  expect(loaded === 3, `all three required ROMs report loaded, got ${loaded}`);
  expect(loader.cachedCount === 0, 'none came from the cache');
  expect(loader.kernal && bytesEqual(loader.kernal, served['/roms/kernal.bin']), 'KERNAL bytes are the served ones');
  expect(loader.drive1541 && loader.drive1541.length === 16386, 'a 16386-byte drive ROM (2-byte header) is accepted');
  expect(loader.romNames.kernal === 'kernal.bin' && loader.romNames.drive1541 === '1541.bin',
    `names come from the URL, got ${loader.romNames.kernal} / ${loader.romNames.drive1541}`);
  expect(readyArg && readyArg.drive1541 === loader.drive1541, 'onReady carries the drive ROM too');
  expect(loader.allLoaded, 'allLoaded reads true');
  ok('rom-cache: autoLoad fetches every slot from the server');
}

{
  reset();
  globalThis.fetch = async (url) => ({
    ok: true, status: 200,
    arrayBuffer: async () => (url.endsWith('/kernal.bin') ? makeRom(100) : makeRom(url.endsWith('chargen.bin') ? 4096 : 8192)).buffer,
  });
  const loader = new ROMLoader();
  const loaded = await loader.autoLoad();
  expect(loaded === 2 && loader.kernal === null, `a wrong-size KERNAL from the server is rejected (${loaded} loaded)`);
  expect(loader.basic && loader.charRom, 'the other two still land');
  expect(loader.drive1541 === null, 'a wrong-size drive ROM is dropped without complaint');
  expect(!loader.allLoaded, 'allLoaded stays false until the trio is there');
  ok('rom-cache: autoLoad rejects wrong-size server ROMs');
}

// ── 11: file inputs — the upload path, with a stand-in FileReader ───────
{
  reset();
  const inputs = {};
  const el = (name) => {
    const handlers = {};
    return inputs[name] = { addEventListener: (type, fn) => { handlers[type] = fn; }, fire: (files) => handlers.change({ target: { files } }) };
  };
  const readers = [];
  globalThis.FileReader = class {
    constructor() { this.onload = null; readers.push(this); }
    readAsArrayBuffer(file) { this.onload({ target: { result: file.bytes.buffer } }); }
  };
  const alerts = [];
  globalThis.alert = (msg) => alerts.push(msg);

  const loader = new ROMLoader();
  let readyArg = null, names = null;
  loader.onReady(roms => { readyArg = roms; });
  loader.onNamesChanged = (n) => { names = n; };
  loader.bindInputs(el('kernal'), el('basic'), el('char'), el('drive'));

  inputs.kernal.fire([]);
  expect(readers.length === 0, 'no file chosen: nothing is read');

  inputs.kernal.fire([{ name: 'kernal-901227-03.bin', bytes: makeRom(8192, 0x11) }]);
  expect(loader.kernal && loader.kernal[0] === 0x11, 'an uploaded KERNAL is installed');
  expect(names && names.kernal === 'kernal-901227-03.bin', 'and its name is announced');
  expect(loader._loadFromCache('kernal')?.name === 'kernal-901227-03.bin', 'and cached');
  expect(readyArg === null, 'not ready with one of three');

  inputs.basic.fire([{ name: 'basic.bin', bytes: makeRom(100) }]);
  expect(alerts.length === 1 && /BASIC ROM must be exactly 8192 bytes \(got 100\)/.test(alerts[0]),
    `a wrong-size upload is refused with an alert (${alerts[0]})`);
  expect(loader.basic === null, 'and not installed');

  inputs.basic.fire([{ name: 'basic.bin', bytes: makeRom(8192, 0x22) }]);
  inputs.char.fire([{ name: 'chargen.bin', bytes: makeRom(4096, 0x33) }]);
  expect(readyArg && readyArg.kernal === loader.kernal && readyArg.drive1541 === null,
    'the third upload completes the trio and fires onReady');

  inputs.drive.fire([{ name: '1541.bin', bytes: makeRom(16386, 0x44) }]);
  expect(loader.drive1541 && loader.drive1541.length === 16386, 'a drive ROM with a 2-byte header is accepted from a file too');

  delete globalThis.FileReader;
  delete globalThis.alert;
  ok('rom-cache: bindInputs installs, validates, caches and announces uploads');
}

// ── 12: setRomData — the Fetch-ROMs dialog's way in ─────────────────────
{
  reset();
  const loader = new ROMLoader();
  let names = null, readyArg = null;
  loader.onNamesChanged = (n) => { names = n; };
  loader.onReady(roms => { readyArg = roms; });
  loader.setRomData('kernal', makeRom(8192, 0x51), 'k.bin');
  expect(loader.kernal?.[0] === 0x51 && names?.kernal === 'k.bin', 'bytes installed and name announced');
  expect(loader._loadFromCache('kernal')?.name === 'k.bin', 'and cached');
  let msg = '';
  try { loader.setRomData('basic', makeRom(4096), 'b.bin'); } catch (e) { msg = e.message; }
  expect(/expected 8192 bytes, got 4096/.test(msg), `a wrong size throws with both sizes (${msg})`);
  msg = '';
  try { loader.setRomData('vic', makeRom(8192), 'v.bin'); } catch (e) { msg = e.message; }
  expect(/unknown ROM slot: vic/.test(msg), `an unknown slot throws (${msg})`);
  loader.setRomData('basic', makeRom(8192, 0x52), 'b.bin');
  loader.setRomData('charRom', makeRom(4096, 0x53), 'c.bin');
  expect(readyArg && readyArg.charRom === loader.charRom, 'the trio fires onReady');
  ok('rom-cache: setRomData validates, caches, names and readies');
}

// ── 13: every kind of broken cache entry is evicted on read ─────────────
{
  reset();
  const loader = new ROMLoader();
  const key = _ROM_SPEC.basic.key;
  store.set(key, JSON.stringify({ name: 'no-data.bin' }));
  expect(loader._loadFromCache('basic') === null && !store.has(key), 'an entry without data is evicted');
  store.set(key, JSON.stringify({ data: '%%not base64%%', name: 'x' }));
  expect(loader._loadFromCache('basic') === null && !store.has(key), 'an entry that does not decode is evicted');
  store.set(key, JSON.stringify({ data: 'null' }));
  expect(loader._loadFromCache('basic') === null && !store.has(key), 'a decodable entry of the wrong size is evicted');
  expect(loader._loadFromCache('nonsense') === null && loader._saveToCache('nonsense', makeRom(1), 'n') === undefined,
    'unknown slots are ignored both ways');
  loader._setName('nonsense', 'x');
  expect(!('nonsense' in loader.romNames), '_setName ignores unknown slots');
  ok('rom-cache: broken cache entries are evicted on read');
}

console.log(`\n${testNo} rom-cache spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
