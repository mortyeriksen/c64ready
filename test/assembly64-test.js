// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import test from 'node:test';
import assert from 'node:assert/strict';
import { Assembly64Controller } from '../src/assembly64/controller.js';
import { createAssembly64Store } from '../src/assembly64/store.js';
import { createAssembly64Actions } from '../src/assembly64/actions.js';
import { normalizeItem } from '../src/assembly64/normalize.js';
import { createOpenMedia, validateMedia } from '../src/media/open.js';
import { allowedActions, singleLoadableFile } from '../src/media/formats.js';
import { sourceMetadata } from '../src/media/source-metadata.js';
import { copyData } from '../src/serializable.js';
import { createFixtureTransport, sampleMedia } from './fixtures/assembly64.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const json = value => new Response(JSON.stringify(value));
const rawItem = id => ({ id, category: 0, name: id });
function controllerWithSearch(search, options = {}) {
  const fixtures = createFixtureTransport({ delayMs: 0 });
  return new Assembly64Controller({ requestIntervalMs: 0, ...options, transport: (url, init) => /\/aql\/\d+\/\d+/.test(url) ? search(url, init) : fixtures(url, init) });
}
const memoryStorage = () => {
  const data = new Map();
  return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) };
};
test('Quick search requests at most ten results from the first page', async () => {
  let address;
  const controller = controllerWithSearch(async url => { address = new URL(url); return json(Array.from({ length: 10 }, (_, i) => rawItem(String(i)))); });
  const items = await controller.quickSearch({ name: 'demo', category: 'Samples' });
  assert.deepEqual([address.pathname, address.searchParams.get('query'), items.length], ['/leet/search/aql/0/10', '(name:"demo") & (category:Samples)', 10]);
});
test('Quick search combines title, producer, type and source in one request', async () => {
  const queries = [];
  const controller = controllerWithSearch(async url => { queries.push(new URL(url).searchParams.get('query')); return json([]); });
  await controller.quickSearch({ name: 'Sample', group: 'C64 READY', category: 'Samples', repo: 'Lab' });
  assert.deepEqual(queries, ['(name:"Sample") & (group:"C64 READY") & (category:Samples) & (repo:Lab)']);
});
test('Quick search finds producers with an empty title and intersects supplied filters', async () => {
  const controller = new Assembly64Controller({ requestIntervalMs: 0, transport: createFixtureTransport({ delayMs: 0 }) });
  assert.equal((await controller.quickSearch({ group: 'C64 READY', repo: 'Lab', category: 'Samples' })).length, 10, 'Producer-only search returns matching productions');
  assert.equal((await controller.quickSearch({ name: 'Sample 02', group: 'different producer', repo: 'Lab' })).length, 0, 'Title and producer must both match');
});
test('Quick search validates producer and source before dispatching a search', async () => {
  let calls = 0;
  const controller = controllerWithSearch(async () => { calls++; return json([]); });
  await assert.rejects(controller.quickSearch({ group: 'bad"query' }), /cannot contain/);
  await assert.rejects(controller.quickSearch({ repo: 'unadvertised' }), /valid source/);
  assert.equal(calls, 0, 'Invalid filters never reach the search API');
});
test('Quick search does not overwrite full-browser results', async () => {
  const controller = new Assembly64Controller({ requestIntervalMs: 0, transport: createFixtureTransport({ delayMs: 0 }) });
  await controller.search(); const original = controller.state.items;
  await controller.quickSearch({ name: 'sample' });
  assert.equal(controller.state.items, original);
});
test('A cancelled quick search cannot deliver late results', async () => {
  let finish;
  const controller = controllerWithSearch(() => new Promise(resolve => { finish = resolve; }));
  await controller.initialize(); const abort = new AbortController();
  const pending = controller.quickSearch({ name: 'old' }, { signal: abort.signal }); await flush();
  abort.abort(); finish(json([rawItem('old')]));
  await assert.rejects(pending, { name: 'AbortError' });
});
test('A newer browser search cancels and supersedes the old search', async () => {
  const pending = [];
  const controller = controllerWithSearch((url, options) => new Promise(resolve => pending.push({ options, resolve })));
  await controller.initialize();
  const old = controller.search(); await flush();
  controller.setQuery({ name: 'new' }); const next = controller.search(); await flush();
  pending[1].resolve(json([rawItem('new')])); await next;
  pending[0].resolve(json([rawItem('old')])); await old;
  assert.deepEqual([pending[0].options.signal.aborted, controller.state.items[0].title], [true, 'new']);
});
test('Browser pagination advances the API offset and appends results', async () => {
  const controller = new Assembly64Controller({ requestIntervalMs: 0, transport: createFixtureTransport({ delayMs: 0 }) });
  await controller.search(); await controller.search(true); await controller.search(true);
  assert.deepEqual([controller.state.items.length, controller.state.offset, controller.state.hasMore], [27, 27, false]);
});
test('A failed next page retains results and retry offset', async () => {
  let calls = 0;
  const controller = controllerWithSearch(async () => ++calls === 1 ? json([rawItem('one')]) : new Response('', { status: 503 }), { limit: 1 });
  await controller.search(); await controller.search(true);
  assert.deepEqual([controller.state.items[0].title, controller.state.offset, controller.state.hasMore, controller.state.status], ['one', 1, true, 'error']);
});
test('Cancelling a search settles loading without displaying late results', async () => {
  let finish;
  const controller = controllerWithSearch(() => new Promise(resolve => { finish = resolve; }));
  await controller.initialize(); const pending = controller.search(); await flush(); controller.cancel();
  finish(json([rawItem('late')])); await pending;
  assert.deepEqual([controller.state.status, controller.state.items], ['idle', []]);
});
test('Initialization can recover after a temporary HTTP failure', async () => {
  let calls = 0; const fixture = createFixtureTransport({ delayMs: 0 });
  const controller = new Assembly64Controller({ requestIntervalMs: 0, transport: (url, options) => url.endsWith('/categories') && ++calls === 1 ? Promise.resolve(new Response('', { status: 503 })) : fixture(url, options) });
  await controller.search(); await controller.search();
  assert.deepEqual([calls, controller.state.status], [2, 'ready']);
});
test('Offline browser search never calls Assembly64', async () => {
  let calls = 0;
  const controller = new Assembly64Controller({ requestIntervalMs: 0, online: () => false, transport: async () => { calls++; return json([]); } });
  await controller.search();
  assert.deepEqual([calls, controller.state.status], [0, 'error']);
});
test('Disposing the controller aborts initialization requests', async () => {
  const signals = [];
  const controller = new Assembly64Controller({ requestIntervalMs: 0, transport: (_, { signal }) => { signals.push(signal); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))); } });
  const pending = controller.search(); await flush(); controller.dispose(); await pending;
  assert.ok(signals.length === 2 && signals.every(signal => signal.aborted));
});
test('Category IDs distinguish otherwise identical Assembly64 item IDs', () => assert.notEqual(normalizeItem({ id: '42', category: 0 }).id, normalizeItem({ id: '42', category: 1 }).id));
test('Saved data rejects unsafe object keys', () => assert.throws(() => copyData(JSON.parse('{"__proto__":{"x":1}}')), /Unsafe/));
test('Favorites from the original format preserve category zero', () => {
  const db = memoryStorage(); db.setItem('c64emu.mediaBrowser.assembly64.favorites', JSON.stringify([{ provider: 'assembly64', id: '42', categoryId: 0, title: 'Legacy' }]));
  const favorite = createAssembly64Store(db).favorites()[0];
  assert.deepEqual([favorite.title, favorite.ref], ['Legacy', { id: '42', categoryId: 0 }]);
});
test('Favorites saved by the previous browser remain usable', () => {
  const db = memoryStorage(); const item = { ...normalizeItem({ id: '42', category: 0, name: 'Existing' }), schemaVersion: 2 };
  db.setItem('c64emu.mediaBrowser.assembly64.favorites', JSON.stringify([item]));
  assert.equal(createAssembly64Store(db).isFavorite(item), true);
});
test('Legacy saved searches retain sort direction and their original ID', () => {
  const db = memoryStorage(); db.setItem('c64emu.mediaBrowser.assembly64.savedSearches', JSON.stringify([{ id: 'old', name: 'Legacy', pluginId: 'assembly64', queryVersion: 1, filters: { name: 'demo', order: 'asc' }, sort: 'rating', createdAt: 1 }]));
  const saved = createAssembly64Store(db).searches()[0];
  assert.deepEqual([saved.id, saved.createdAt, saved.query], ['old', 1, { filters: { name: 'demo' }, sort: { id: 'rating', direction: 'asc' } }]);
});
test('Adding a search preserves unknown future-version records', () => {
  const db = memoryStorage(), unknown = { id: 'future', queryVersion: 999, schemaVersion: 3 };
  db.setItem('c64emu.mediaBrowser.assembly64.savedSearches', JSON.stringify([unknown]));
  createAssembly64Store(db).saveSearch('New', {}, { id: 'relevance', direction: null });
  assert.deepEqual(JSON.parse(db.getItem('c64emu.mediaBrowser.assembly64.savedSearches'))[0], unknown);
});
test('Library source migration retains category and file ID zero', () => {
  const result = sourceMetadata({ source: 'assembly64', assembly64ItemId: '42', assembly64CategoryId: 0, assembly64FileId: 0 });
  assert.deepEqual([result.provenance.itemRef, result.provenance.fileRef], [{ id: '42', categoryId: 0 }, { itemId: '42', categoryId: 0, id: '0' }]);
});
test('REU images exceeding emulator capacity are rejected', () => assert.throws(() => validateMedia(new Uint8Array(16 * 1024 * 1024 + 1), 'reu'), /RAM Expansion capacity/));
test('REU loading powers on and invokes the public REU adapter without autorun', async () => {
  const calls = [];
  const open = createOpenMedia({ isRunning: () => false, powerOn: async () => { calls.push('power'); return true; }, getAutorunEnabled: () => true, reu: async (_, name, options) => { calls.push([name, options]); } });
  await open({ name: 'image.reu', bytes: sampleMedia('reu'), mediaType: 'reu', autorun: true, saveToLibrary: false });
  assert.deepEqual(calls, ['power', ['image.reu', { autorun: false }]]);
});
test('Assembly64 files keep their source references when saved through openMedia', async () => {
  let metadata;
  const controller = new Assembly64Controller({ requestIntervalMs: 0, transport: createFixtureTransport({ delayMs: 0 }) });
  const item = await controller.getDetails({ ref: { id: 'lab-0', categoryId: 1 } });
  const open = createOpenMedia({ isRunning: () => false, getAutorunEnabled: () => false, save: async (_, __, ___, source) => { metadata = source; return true; } });
  await createAssembly64Actions(controller, open)(item, item.files[0], { action: 'save' });
  assert.deepEqual([metadata.source, metadata.provenance.itemRef, metadata.provenance.fileId], ['assembly64', { id: 'lab-0', categoryId: 1 }, 'prg']);
});

test('Producer credits normalize a group name or a list without HTML interpretation', () => {
  assert.equal(normalizeItem({ ...rawItem('credit'), group: ['Fairlight', '<img src=x>'] }).producer, 'Fairlight, <img src=x>');
});
test('Missing producer credits remain absent', () => {
  assert.equal(normalizeItem(rawItem('unknown')).producer, null);
});
test('Producer metadata is used when a group is absent', () => {
  assert.equal(normalizeItem({ ...rawItem('producer'), producer: 'Publisher' }).producer, 'Publisher');
});
test('Favorite credits survive saving and reloading', () => {
  const storage = memoryStorage();
  createAssembly64Store(storage).toggleFavorite(normalizeItem({ ...rawItem('credit'), group: 'Fairlight' }));
  assert.equal(createAssembly64Store(storage).favorites()[0].producer, 'Fairlight');
});

for (const type of ['prg', 'd64', 'crt', 'tap', 'reu']) {
  test(`Quick Load chooses the sole ${type.toUpperCase()} even with unsupported companions`, () => {
    const file = { mediaType: type };
    assert.equal(singleLoadableFile({ files: [{ mediaType: 'sid' }, file, { mediaType: 'txt' }] }), file);
  });
}
test('Quick Load requires selection when two emulator-compatible files exist', () => {
  assert.equal(singleLoadableFile({ files: [{ mediaType: 'prg' }, { mediaType: 'reu' }] }), null);
});
test('Quick Load cannot dispatch an unsupported-only release', () => {
  assert.equal(singleLoadableFile({ files: [{ mediaType: 'sid' }] }), null);
});

for (const type of ['prg', 'd64', 'crt', 'tap', 'reu', 'zip', 'sid', 'txt']) {
  test(`${type.toUpperCase()} offers an original-file download`, () => {
    assert.ok(allowedActions(type).includes('download'));
  });
}

test('Quick format lookup fetches entries without a metadata request', async () => {
  const requested = [];
  const fixtures = createFixtureTransport({ delayMs: 0 });
  const controller = new Assembly64Controller({ requestIntervalMs: 0, transport: (url, init) => { requested.push(new URL(url).pathname); return fixtures(url, init); } });
  const files = await controller.getFiles(normalizeItem({ id: 'lab-1', category: 1 }));
  assert.deepEqual([requested, files.map(file => file.mediaType)], [['/leet/search/entries/lab-1/1'], ['d64', 'sid']]);
});

for (const name of ['', '   ']) {
  test(`Empty quick search ${JSON.stringify(name)} requests descending date order`, async () => {
    let address;
    const controller = controllerWithSearch(async url => { address = new URL(url); return json([]); });
    await controller.quickSearch({ name, category: 'Samples' });
    assert.equal(address.searchParams.get('query'), '(category:Samples) & (sort:date) & (order:desc)');
  });
}
test('Explore resets old search filters and requests Newest', async () => {
  let address;
  const controller = controllerWithSearch(async url => { address = new URL(url); return json([]); });
  controller.setQuery({ name: 'old' }, { id: 'rating', direction: 'asc' });
  controller.resetQuery(); await controller.search();
  assert.deepEqual([controller.state.sort.id, address.searchParams.get('query')], ['newest', '(sort:date) & (order:desc)']);
});

test('Browser searches fetch ten results by default', async () => {
  let address;
  const controller = controllerWithSearch(async url => { address = new URL(url); return json([]); });
  await controller.search();
  assert.equal(address.pathname, '/leet/search/aql/0/10');
});

for (const [kind, expected] of [['Demos', 'demo'], ['Games', 'game'], ['Intros', 'intro'], ['Music', 'music'], ['Graphics', 'graphics'], ['Tools', 'tools'], ['Diskmags', 'mags'], ['Charts', 'charts'], ['BBS', 'bbs'], ['EasyFlash', 'easyflash'], ['REU', 'reu'], ['C128', 'c128'], [null, 'misc']]) {
  test(`Production icon represents ${kind || 'unknown type'}`, async () => {
    const { typeIconFor } = await import('../src/assembly64/icons.js');
    assert.equal(typeIconFor(kind)[0], expected);
  });
}

const libraryItem = normalizeItem({ id: '42', category: 0, files: [{ id: '0', path: 'release.prg' }, { id: 'disk', path: 'release.d64' }] });
const savedEntry = {
  type: 'prg', name: 'renamed.prg', source: 'assembly64',
  provenance: { version: 1, provider: 'assembly64', itemId: libraryItem.id, itemRef: libraryItem.ref, fileId: '0', fileRef: { itemId: '42', categoryId: 0, id: '0' } },
};
test('Library status matches release and file IDs independently of the saved filename', async () => {
  const { savedLibraryFiles } = await import('../src/assembly64/library.js');
  assert.deepEqual([...savedLibraryFiles(libraryItem, [savedEntry])], ['0']);
});
test('Library status accepts legacy Assembly64 metadata including category and file ID zero', async () => {
  const { savedLibraryFiles } = await import('../src/assembly64/library.js');
  const entry = { type: 'prg', source: 'assembly64', assembly64ItemId: '42', assembly64CategoryId: 0, assembly64FileId: 0 };
  assert.deepEqual([...savedLibraryFiles(libraryItem, [entry])], ['0']);
});
for (const [reason, entry] of [
  ['another category', { ...savedEntry, provenance: { ...savedEntry.provenance, itemRef: { id: '42', categoryId: 1 } } }],
  ['another release', { ...savedEntry, provenance: { ...savedEntry.provenance, itemRef: { id: 'other', categoryId: 0 } } }],
  ['another file', { ...savedEntry, provenance: { ...savedEntry.provenance, fileId: 'other' } }],
  ['another media type', { ...savedEntry, type: 'd64' }],
  ['an unverified same-named local file', { type: 'prg', name: 'release.prg' }],
]) {
  test(`Library status does not match ${reason}`, async () => {
    const { savedLibraryFiles } = await import('../src/assembly64/library.js');
    assert.equal(savedLibraryFiles(libraryItem, [entry]).size, 0);
  });
}
test('Library status clears when an entry is removed', async () => {
  const { savedLibraryFiles } = await import('../src/assembly64/library.js');
  assert.equal(savedLibraryFiles(libraryItem, []).size, 0);
});

for (const drive of [8, 9]) {
  test(`D64 compatibility enables TDE for drive ${drive} only after acceptance`, async () => {
    const { createDiskCompatibilityPrompt } = await import('../src/media/disk-compatibility.js');
    const enabled = [];
    const prepare = createDiskCompatibilityPrompt({ enabled: () => false, available: () => true, enable: d => enabled.push(d), confirm: async () => true });
    await prepare({ targetDrive: drive });
    assert.deepEqual(enabled, [drive]);
  });
}
test('Declining D64 compatibility keeps TDE off', async () => {
  const { createDiskCompatibilityPrompt } = await import('../src/media/disk-compatibility.js');
  let changed = false;
  await createDiskCompatibilityPrompt({ enabled: () => false, available: () => true, enable: () => { changed = true; }, confirm: async () => false })({ targetDrive: 8 });
  assert.equal(changed, false);
});
for (const [name, enabled, available] of [['TDE already on', true, true], ['drive ROM unavailable', false, false]]) {
  test(`D64 compatibility does not prompt when ${name}`, async () => {
    const { createDiskCompatibilityPrompt } = await import('../src/media/disk-compatibility.js');
    let prompted = false;
    await createDiskCompatibilityPrompt({ enabled: () => enabled, available: () => available, enable: () => {}, confirm: async () => { prompted = true; } })({ targetDrive: 8 });
    assert.equal(prompted, false);
  });
}
test('Cancelling a pending D64 confirmation never changes TDE', async () => {
  const { createDiskCompatibilityPrompt } = await import('../src/media/disk-compatibility.js');
  const abort = new AbortController(); let changed = false;
  const prepare = createDiskCompatibilityPrompt({ enabled: () => false, available: () => true, enable: () => { changed = true; }, confirm: async () => { abort.abort(); return true; } });
  await assert.rejects(prepare({ targetDrive: 8, signal: abort.signal }), { name: 'AbortError' });
  assert.equal(changed, false);
});
test('D64 mounting waits for compatibility confirmation after power-on', async () => {
  const events = [];
  const open = createOpenMedia({ isRunning: () => false, powerOn: async () => { events.push('power'); return true; }, getAutorunEnabled: () => false, prepareDisk: async () => events.push('confirm'), disk: async () => events.push('mount') });
  await open({ name: 'test.d64', mediaType: 'd64', bytes: sampleMedia('d64'), saveToLibrary: false });
  assert.deepEqual(events, ['power', 'confirm', 'mount']);
});
test('Saving a D64 without loading does not ask about TDE', async () => {
  let prompted = false;
  const open = createOpenMedia({ getAutorunEnabled: () => false, prepareDisk: async () => { prompted = true; }, save: async () => true });
  await open({ name: 'test.d64', mediaType: 'd64', bytes: sampleMedia('d64'), action: 'save' });
  assert.equal(prompted, false);
});

test('Identical search pages reuse their response for thirty seconds', async () => {
  const { createAssembly64Api } = await import('../src/assembly64/api.js');
  let clock = 0, calls = 0;
  const api = createAssembly64Api({ requestIntervalMs: 0, now: () => clock, transport: async () => { calls++; return json([]); } });
  const query = { offset: 0, limit: 10, query: '(name:"demo")' };
  await api.search(query); await api.search(query);
  assert.equal(calls, 1, 'Repeated search uses its cached page');
  clock = 30000; await api.search(query);
  assert.equal(calls, 2, 'The search cache expires after thirty seconds');
});
test('Search cache keys distinguish both query and page offset', async () => {
  const { createAssembly64Api } = await import('../src/assembly64/api.js');
  let calls = 0;
  const api = createAssembly64Api({ requestIntervalMs: 0, transport: async () => { calls++; return json([]); } });
  for (const [query, offset] of [['demo', 0], ['demo', 10], ['game', 0], ['demo', 0]]) await api.search({ query, offset, limit: 10 });
  assert.equal(calls, 3);
});
test('Concurrent identical requests share one transport and return independent data', async () => {
  const { createAssembly64Api } = await import('../src/assembly64/api.js');
  let calls = 0, finish;
  const api = createAssembly64Api({ requestIntervalMs: 0, transport: async () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const first = api.entries({ id: '42', categoryId: 1 });
  const second = api.entries({ id: '42', categoryId: 1 });
  await flush(); finish(json({ contentEntry: [] }));
  const [a, b] = await Promise.all([first, second]); a.contentEntry.push('changed');
  assert.deepEqual([calls, b.contentEntry], [1, []]);
});
test('Cancelling one subscriber leaves a shared request available to the other', async () => {
  const { createAssembly64Api } = await import('../src/assembly64/api.js');
  let finish, signal;
  const api = createAssembly64Api({ requestIntervalMs: 0, transport: async (_, init) => { signal = init.signal; return new Promise(resolve => { finish = resolve; }); } });
  const abort = new AbortController();
  const first = api.meta({ id: '42', categoryId: 1 }, abort.signal);
  const second = api.meta({ id: '42', categoryId: 1 });
  await flush(); abort.abort(); await assert.rejects(first, { name: 'AbortError' });
  assert.equal(signal.aborted, false, 'A request needed by another subscriber remains active');
  finish(json({ name: 'Release' })); assert.deepEqual(await second, { name: 'Release' });
});
test('Cancelling the final subscriber aborts a shared transport', async () => {
  const { createAssembly64Api } = await import('../src/assembly64/api.js');
  let requestSignal;
  const api = createAssembly64Api({ requestIntervalMs: 0, transport: (_, { signal }) => { requestSignal = signal; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))); } });
  const abort = new AbortController(), pending = api.entries({ id: '42', categoryId: 1 }, abort.signal);
  await flush(); abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(requestSignal.aborted, true);
});
test('Cancelled queued requests never reach the transport', async () => {
  const { createAssembly64Api } = await import('../src/assembly64/api.js');
  const requests = [], releases = [];
  const api = createAssembly64Api({ requestIntervalMs: 0, transport: async url => { requests.push(url); return new Promise(resolve => releases.push(() => resolve(json({})))); } });
  const pending = [0, 1, 2].map(id => api.meta({ id, categoryId: 1 }));
  const abort = new AbortController(); const queued = api.meta({ id: 3, categoryId: 1 }, abort.signal);
  await flush(); abort.abort(); await assert.rejects(queued, { name: 'AbortError' });
  releases.forEach(release => release()); await Promise.all(pending);
  assert.equal(requests.length, 3);
});
test('Assembly64 has at most three active requests across endpoint types', async () => {
  const { createAssembly64Api } = await import('../src/assembly64/api.js');
  let active = 0, peak = 0;
  const api = createAssembly64Api({ requestIntervalMs: 0, transport: async () => {
    peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 2)); active--; return json({});
  } });
  await Promise.all(Array.from({ length: 12 }, (_, id) => id % 2 ? api.meta({ id, categoryId: 1 }) : api.entries({ id, categoryId: 1 })));
  assert.equal(peak, 3);
});
test('Default pacing spreads five request starts over at least one second', async () => {
  const { createAssembly64Api } = await import('../src/assembly64/api.js');
  const started = performance.now(); let lastStart;
  const api = createAssembly64Api({ transport: async () => { lastStart = performance.now(); return json({}); } });
  await Promise.all(Array.from({ length: 5 }, (_, id) => api.meta({ id, categoryId: 1 })));
  assert.ok(lastStart - started >= 1000);
});
test('Reopening details reuses metadata and the file list resolved by quick search', async () => {
  const paths = [], fixtures = createFixtureTransport({ delayMs: 0 });
  const controller = new Assembly64Controller({ requestIntervalMs: 0, transport: (url, init) => { paths.push(new URL(url).pathname); return fixtures(url, init); } });
  const item = normalizeItem({ id: 'lab-0', category: 1 });
  await controller.getFiles(item);
  await controller.getDetails(item);
  await controller.getDetails(item);
  assert.deepEqual(paths, ['/leet/search/entries/lab-0/1', '/leet/search/meta/lab-0/1']);
});
test('The JSON cache evicts older entries beyond sixty-four responses', async () => {
  const { createAssembly64Api } = await import('../src/assembly64/api.js');
  let calls = 0;
  const api = createAssembly64Api({ requestIntervalMs: 0, transport: async () => { calls++; return json({}); } });
  for (let id = 0; id < 65; id++) await api.meta({ id, categoryId: 1 });
  await api.meta({ id: 0, categoryId: 1 });
  assert.equal(calls, 66);
});
test('The JSON cache limits cached response bodies to four MiB', async () => {
  const { createAssembly64Api } = await import('../src/assembly64/api.js');
  let calls = 0;
  const api = createAssembly64Api({ requestIntervalMs: 0, transport: async () => { calls++; return json({ name: 'x'.repeat(1024 * 1024) }); } });
  for (let id = 0; id < 4; id++) await api.meta({ id, categoryId: 1 });
  await api.meta({ id: 0, categoryId: 1 });
  assert.equal(calls, 5);
});
for (const retry of ['30', 'Thu, 01 Jan 1970 00:00:30 GMT', null]) {
  test(`HTTP 429 applies a cooldown without retries (${retry || 'no Retry-After header'})`, async () => {
    const { createAssembly64Api } = await import('../src/assembly64/api.js');
    let clock = 0, calls = 0;
    const api = createAssembly64Api({ requestIntervalMs: 0, now: () => clock, transport: async () => ++calls === 1 ? new Response('', { status: 429, headers: retry ? { 'Retry-After': retry } : {} }) : json({}) });
    await assert.rejects(api.meta({ id: 0, categoryId: 1 }), /slow down/);
    await Promise.all(Array.from({ length: 10 }, (_, id) => assert.rejects(api.meta({ id, categoryId: 1 }), /30 seconds/)));
    assert.equal(calls, 1, 'No request is sent during the server cooldown');
    clock = 30000; await api.meta({ id: 0, categoryId: 1 });
    assert.equal(calls, 2, 'A user retry can proceed after the cooldown');
  });
}
test('Binary downloads are never cached or shared', async () => {
  const { createAssembly64Api } = await import('../src/assembly64/api.js');
  let calls = 0;
  const api = createAssembly64Api({ requestIntervalMs: 0, transport: async () => { calls++; return new Response(new Uint8Array([1, 8, 0])); } });
  const file = { itemId: '42', categoryId: 1, id: 'file' };
  await api.download(file); await api.download(file);
  assert.equal(calls, 2);
});

test('A cancelled request cannot remove a newer shared request for the same URL', async () => {
  const { createAssembly64Api } = await import('../src/assembly64/api.js');
  const releases = [];
  const api = createAssembly64Api({ requestIntervalMs: 0, transport: () => new Promise(resolve => releases.push(resolve)) });
  const ref = { id: '42', categoryId: 1 }, abort = new AbortController();
  const old = api.meta(ref, abort.signal); await flush(); abort.abort(); await assert.rejects(old, { name: 'AbortError' });
  const next = api.meta(ref); await flush(); releases[0](json({ name: 'Old' })); await flush();
  const shared = api.meta(ref); await flush();
  assert.equal(releases.length, 2, 'The third caller shares the active replacement request');
  releases[1](json({ name: 'New' }));
  assert.deepEqual(await Promise.all([next, shared]), [{ name: 'New' }, { name: 'New' }]);
});
test('A rate-limit response stops queued requests before they reach Assembly64', async () => {
  const { createAssembly64Api } = await import('../src/assembly64/api.js');
  let calls = 0;
  const api = createAssembly64Api({ requestIntervalMs: 0, transport: async () => ++calls === 1 ? new Response('', { status: 429 }) : json({}) });
  await Promise.allSettled(Array.from({ length: 12 }, (_, id) => api.meta({ id, categoryId: 1 })));
  assert.ok(calls <= 3, 'Only the requests already admitted by the concurrency limit may reach the server');
});
