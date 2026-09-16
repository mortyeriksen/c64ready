// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { buildQuery, quoteText } from '../src/assembly64/query.js';
import { filterDefinitions, normalizePresets, normalizeCategories, quickFilters, sortOptions } from '../src/assembly64/filters.js';
import { fixturePresets, fixtureCategories, sampleMedia, createFixtureTransport } from './fixtures/assembly64.js';
import { normalizeItem, normalizeFiles, normalizePage } from '../src/assembly64/normalize.js';
import { createAssembly64Api } from '../src/assembly64/api.js';
import { readLimited } from '../src/media/stream.js';
import { Assembly64Controller } from '../src/assembly64/controller.js';
import { createAssembly64Store } from '../src/assembly64/store.js';
import { sourceMetadata } from '../src/media/source-metadata.js';
import { createOpenMedia, validateMedia } from '../src/media/open.js';
import { allowedActions, directRunFile, safeFilename, safeExternalUrl } from '../src/media/formats.js';
import { inspectZip, crc32 } from '../src/media/archive.js';
import { progressText } from '../src/assembly64/progress.js';
import { buildMixtape } from '../tools/mixtape.mjs';

const definitions = filterDefinitions(normalizePresets(fixturePresets));
const json = value => new Response(JSON.stringify(value));
const memoryStorage = () => {
  const data = new Map();
  return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) };
};
test('AQL uses the public client clause and conjunction syntax', () => {
  assert.equal(buildQuery({ name: 'jumpman', type: 'prg', rating: '7' }, { id: 'relevance', direction: null }, definitions), '(name:"jumpman") & (type:prg) & (rating:>=7)');
});
test('AQL sorting uses allowed server sort fields and direction', () => {
  assert.equal(buildQuery({}, { id: 'rating', direction: null }, definitions), '(sort:rating) & (order:desc)');
});
test('AQL preserves Unicode text and apostrophes', () => {
  assert.equal(quoteText("Morten's blå demo"), '"Morten\'s blå demo"');
});
for (const text of ['a" & (rating:0)', 'a\\b', '(name:test)', 'x|y', 'a\nb']) {
  test(`Ambiguous AQL syntax is rejected: ${JSON.stringify(text)}`, () => assert.throws(() => quoteText(text), /cannot contain/));
}
test('AQL rejects unknown filter fields', () => assert.throws(() => buildQuery({ injected: 'hello' }, { id: 'relevance', direction: null }, definitions), /Unsupported search filter/));
test('AQL rejects values not advertised in presets', () => assert.throws(() => buildQuery({ repo: 'arbitrary' }, { id: 'relevance', direction: null }, definitions), /valid source/));
test('Unverified preset keys do not become controls', () => assert.equal(normalizePresets([{ type: 'sql', values: ['x'] }]).length, 0));
test('Categories require valid server references', () => assert.throws(() => normalizeCategories([{ name: 'Games' }]), /invalid category/));
test('Live preset entries map AQL keys separately from display names', () => {
  assert.deepEqual(normalizePresets([{ type: 'repo', values: [{ aqlKey: 'csdb', name: 'CSDB' }] }])[0].options, [{ value: 'csdb', label: 'CSDB' }]);
});
test('Live category mappings provide readable type and source metadata', () => {
  const presets = normalizePresets([{ type: 'repo', values: [{ aqlKey: 'csdb', name: 'CSDB' }] }]);
  assert.deepEqual(normalizeCategories([{ id: 0, name: 'games', groupingName: 'Games', type: 'csdb' }], presets), [{ id: 0, name: 'Games', source: 'CSDB' }]);
});
test('The type quick filter uses server categories', () => assert.equal(quickFilters(normalizePresets([{ type: 'category', values: [{ aqlKey: 'games', name: 'Games' }] }]))[0].key, 'category'));
test('Incomplete items have a title fallback', () => assert.equal(normalizeItem({ id: 'x', category: 0 }).title, 'Untitled release'));
test('Unknown years remain absent', () => assert.equal(normalizeItem({ id: 'x', category: 0, year: 0 }).year, null));
test('A provider item ID alone never becomes a CSDB link', () => assert.equal(normalizeItem({ id: '123', category: 0 }).originalUrl, null));
test('Explicit CSDB release IDs support an original link', () => assert.equal(normalizeItem({ id: 'x', category: 0, csdbId: 123 }).originalUrl, 'https://csdb.dk/release/?id=123'));
test('Explicit safe CSDB URLs are preserved', () => assert.equal(normalizeItem({ id: '42', category: 1, csdbUrl: 'https://csdb.dk/release/?id=123' }).originalUrl, 'https://csdb.dk/release/?id=123'));
for (const csdbUrl of ['javascript:alert(1)', 'https://csdb.dk@evil.example/release/', 'https://evil.example/']) {
  test(`Original release links reject unsafe URLs: ${csdbUrl}`, () => assert.equal(normalizeItem({ id: '42', category: 1, csdbUrl }).originalUrl, null));
}
test('A missing file size remains unknown', () => assert.equal(normalizeFiles({ contentEntry: [{ id: 0, path: 'x.prg' }] }, { id: 'x', categoryId: 0 })[0].size, null));
test('Malformed file collections are errors', () => assert.throws(() => normalizeFiles({}, {}), /invalid file list/));
test('A full page advances by the number received', () => assert.equal(normalizePage([{ id: 'x', category: 0 }], { offset: 20, limit: 1 }).nextOffset, 21));
test('A short page ends pagination', () => assert.equal(normalizePage([], { offset: 20, limit: 10 }).hasMore, false));
test('D64 actions include mount and run', () => assert.deepEqual(allowedActions('d64'), ['mount', 'run', 'save', 'download']));
for (const type of ['sid', 'g64', 'd71', 'd81']) {
  test(`${type} cannot be sent to the emulator`, () => assert.deepEqual(allowedActions(type), ['download']));
}
test('Direct run requires exactly one file', () => assert.equal(directRunFile({ files: [{ mediaType: 'prg' }, { mediaType: 'sid' }] }), null));
test('Filenames discard path components and control characters', () => assert.equal(safeFilename('../../bad\u0000.prg'), 'bad_.prg'));
test('External URLs reject credentials', () => assert.equal(safeExternalUrl('https://user:password@csdb.dk/release/?id=1'), null));
test('Legacy Library metadata remains valid without source fields', () => assert.deepEqual(sourceMetadata({ id: 'old', name: 'x.prg' }), {}));
test('Library source metadata preserves zero-valued identifiers', () => assert.equal(sourceMetadata({ source: 'assembly64', assembly64ItemId: 'item', assembly64FileId: 'file', assembly64CategoryId: 0 }).provenance.itemRef.categoryId, 0));

test('The API has no implicit live transport', async () => assert.rejects(createAssembly64Api().categories(), { name: 'Assembly64Error', message: 'Assembly64 connection is unavailable. Reload the app and try again.' }));
test('Requests encode query values and carry the stable client ID', async () => {
  let captured;
  const api = createAssembly64Api({ requestIntervalMs: 0, transport: async (url, options) => { captured = { url, options }; return json([]); } });
  await api.search({ offset: 20, limit: 20, query: '(name:"blå demo")' });
  assert.deepEqual([new URL(captured.url).pathname, new URL(captured.url).searchParams.get('query'), captured.options.headers['Client-Id'], captured.options.cache], ['/leet/search/aql/20/20', '(name:"blå demo")', 'c64ready', 'no-store']);
});
test('API 404 errors explain missing releases', async () => assert.rejects(createAssembly64Api({ requestIntervalMs: 0, transport: async () => new Response('', { status: 404 }) }).meta({ id: 'x', categoryId: 0 }), /no longer available/));
test('API invalid JSON is a comprehensible error', async () => assert.rejects(createAssembly64Api({ requestIntervalMs: 0, transport: async () => new Response('<html>') }).categories(), /invalid JSON/));
test('API offline requests never call transport', async () => {
  let calls = 0;
  const api = createAssembly64Api({ requestIntervalMs: 0, online: () => false, transport: async () => { calls++; return json([]); } });
  await assert.rejects(api.categories(), /Offline/);
  assert.equal(calls, 0);
});
test('Preset cache expires after five minutes', async () => {
  let now = 0, calls = 0;
  const api = createAssembly64Api({ requestIntervalMs: 0, now: () => now, transport: async () => { calls++; return json([]); } });
  await api.presets(); await api.presets(); now = 300001; await api.presets();
  assert.equal(calls, 2);
});
test('Timeout aborts pending requests', async () => {
  const api = createAssembly64Api({ requestIntervalMs: 0, timeoutMs: 10, transport: (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  await assert.rejects(api.presets(), /timed out/);
});
test('Stream limits are enforced without content-length', async () => assert.rejects(readLimited(new Response(new Uint8Array(101)), 100), /size limit/));
test('Stream cancellation interrupts a stalled body', async () => {
  const controller = new AbortController();
  const response = new Response(new ReadableStream({ start() {} }));
  const result = readLimited(response, 100, controller.signal);
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
});
function chunkedResponse(chunks, headers = {}) {
  return new Response(new ReadableStream({ start(controller) {
    for (const size of chunks) controller.enqueue(new Uint8Array(size));
    controller.close();
  } }), { headers });
}
test('Known-length downloads report cumulative byte counts and completion', async () => {
  const events = [];
  await readLimited(chunkedResponse([2, 3], { 'content-length': '5' }), 100, undefined, { onProgress: event => events.push(event) });
  assert.deepEqual(events, [{ loaded: 0, total: 5, done: false }, { loaded: 2, total: 5, done: false }, { loaded: 5, total: 5, done: false }, { loaded: 5, total: 5, done: true }]);
});
test('Unknown-length downloads retain indeterminate totals', async () => {
  const events = [];
  await readLimited(chunkedResponse([2, 3]), 100, undefined, { onProgress: event => events.push(event) });
  assert.ok(events.every(event => event.total === null));
});
test('File-list sizes provide progress when HTTP length is absent', async () => {
  const events = [];
  await readLimited(chunkedResponse([2, 3]), 100, undefined, { expectedSize: 5, onProgress: event => events.push(event) });
  assert.equal(events[1].total, 5);
});
test('Compressed HTTP lengths are not compared to decoded byte progress', async () => {
  const events = [];
  await readLimited(chunkedResponse([10]), 100, undefined, { onProgress: event => events.push(event) });
  const compressed = [];
  await readLimited(chunkedResponse([10], { 'content-length': '5', 'content-encoding': 'gzip' }), 100, undefined, { onProgress: event => compressed.push(event) });
  assert.deepEqual(compressed, events);
});
test('Stale size hints switch to indeterminate progress instead of exceeding 100 percent', async () => {
  const events = [];
  await readLimited(chunkedResponse([3, 4]), 100, undefined, { expectedSize: 5, onProgress: event => events.push(event) });
  assert.deepEqual(events[2], { loaded: 7, total: null, done: false });
});
test('Aborted transfers never report completion', async () => {
  const events = [], controller = new AbortController();
  await assert.rejects(readLimited(chunkedResponse([2, 3]), 100, controller.signal, { onProgress: event => { events.push(event); if (event.loaded === 2) controller.abort(); } }), { name: 'AbortError' });
  assert.equal(events.some(event => event.done), false);
});
test('Assembly64 downloads forward byte progress', async () => {
  const controller = new Assembly64Controller({ requestIntervalMs: 0, transport: async () => chunkedResponse([2, 3], { 'content-length': '5' }) });
  const events = [];
  await controller.download({ ref: { itemId: 'x', categoryId: 0, id: 'file' } }, { onProgress: event => events.push(event) });
  assert.deepEqual(events.at(-1), { loaded: 5, total: 5, done: true });
});
test('Progress labels show percentage and bytes for known sizes', () => assert.equal(progressText({ loaded: 5, total: 10 }), 'Downloading 50% · 5 B / 10 B'));
test('Progress labels show byte counts without inventing percentages', () => assert.equal(progressText({ loaded: 2048, total: null }), 'Downloading 2.0 KiB · size unknown'));
test('Opening media has a distinct stage after download completion', () => assert.equal(progressText({ stage: 'open' }), 'Opening media…'));
test('A missing release cancels its parallel file-list request', async () => {
  let entriesSignal;
  const controller = new Assembly64Controller({ requestIntervalMs: 0, transport: async (url, { signal }) => {
    if (url.includes('/meta/')) return new Response('', { status: 404 });
    entriesSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  await assert.rejects(controller.getDetails({ ref: { id: 'missing', categoryId: 1 } }), /no longer available/);
  assert.equal(entriesSignal.aborted, true, 'Missing releases leave no file-list request running');
});
test('Favorites survive store reconstruction', () => {
  const storage = memoryStorage();
  createAssembly64Store( storage).toggleFavorite(normalizeItem({ id: 'x', category: 0 }));
  assert.equal(createAssembly64Store( storage).favorites()[0].ref.id, 'x');
});
test('Saved searches preserve all filters and sorting', () => {
  const store = createAssembly64Store( memoryStorage());
  store.saveSearch('My search', { name: 'x', group: 'g', rating: '7' }, { id: 'date', direction: null });
  assert.deepEqual([store.searches()[0].query.filters, store.searches()[0].query.sort], [{ name: 'x', group: 'g', rating: '7' }, { id: 'date', direction: null }]);
});
test('Named searches can be renamed and deleted', () => {
  const store = createAssembly64Store( memoryStorage());
  const saved = store.saveSearch('Before', {}, { id: 'relevance', direction: null });
  store.renameSearch(saved.id, 'After');
  assert.equal(store.searches()[0].name, 'After');
  store.deleteSearch(saved.id);
  assert.equal(store.searches().length, 0);
});
test('Corrupt local bookmarks do not break startup', () => {
  const storage = memoryStorage(); storage.setItem('c64emu.mediaBrowser.assembly64.favorites', '{bad');
  assert.deepEqual(createAssembly64Store( storage).favorites(), []);
});

function mediaPort(overrides = {}) {
  const calls = [];
  return { calls, isRunning: () => true, powerOn: async () => true, getAutorunEnabled: () => false,
    save: async (...args) => { calls.push(['save', ...args]); return true; },
    ...Object.fromEntries(['prg', 'disk', 'crt', 'tap', 'reu'].map(type => [type, async (...args) => calls.push([type, ...args])])), ...overrides };
}
for (const type of ['prg', 'd64', 'crt', 'tap', 'reu']) {
  test(`${type.toUpperCase()} passes validated media to its public media port`, async () => {
    const port = mediaPort();
    await createOpenMedia(port)({ name: `sample.${type}`, bytes: type === 'tap' ? buildMixtape() : sampleMedia(type), mediaType: type, saveToLibrary: false });
    assert.equal(port.calls[0][0], type === 'd64' ? 'disk' : type);
  });
}
test('A .t64 runs the program inside it and keeps the archive in the Library', async () => {
  // The two go different ways on purpose: the loader is handed the program, the
  // Library is handed the archive it came out of, under the archive's own name.
  const archive = sampleMedia('t64');
  const asked = [];
  const port = mediaPort({ archive: async (bytes, name) => { asked.push(name); return { data: sampleMedia('prg'), name: 'BROWSER PRG.prg' }; } });
  const result = await createOpenMedia(port)({ name: 'sample.t64', bytes: archive, mediaType: 't64' });
  assert.deepEqual(asked, ['sample.t64'], 'the archive is opened once, by its own name');
  assert.deepEqual([port.calls[0][0], port.calls[0][2]], ['prg', 'BROWSER PRG.prg'], 'the loader gets the program');
  const save = port.calls.find(call => call[0] === 'save');
  assert.deepEqual([save[1], save[2]], ['t64', 'sample.t64'], 'the Library gets the archive');
  assert.equal(result.mediaType, 't64');
});
test('Saving a .t64 to the Library never asks which program', async () => {
  let asked = 0;
  const port = mediaPort({ archive: async () => { asked++; return null; } });
  await createOpenMedia(port)({ name: 'sample.t64', bytes: sampleMedia('t64'), mediaType: 't64', action: 'save' });
  assert.equal(asked, 0, 'nothing is about to run, so there is nothing to choose');
  assert.equal(port.calls[0][0], 'save');
});
test('A dismissed .t64 chooser loads nothing and saves nothing', async () => {
  const port = mediaPort({ archive: async () => null });
  const result = await createOpenMedia(port)({ name: 'sample.t64', bytes: sampleMedia('t64'), mediaType: 't64' });
  assert.equal(port.calls.length, 0);
  assert.match(result.message, /cancelled/);
});
test('A file that is not an archive is refused before it reaches the Library', () => {
  assert.throws(() => validateMedia(sampleMedia('prg'), 't64'), /not a \.t64 archive/);
});
for (const targetDrive of [8, 9]) {
  test(`D64 honors drive ${targetDrive} and writable selection`, async () => {
    const port = mediaPort();
    await createOpenMedia(port)({ name: 'sample.d64', bytes: sampleMedia('d64'), mediaType: 'd64', targetDrive, writeProtected: false, autorun: true, saveToLibrary: false });
    assert.deepEqual([port.calls[0][1].writeProtected, port.calls[0][2]], [false, { targetDrive, autorun: true }]);
  });
}
test('D64 defaults to protected drive 8 and the app autorun preference', async () => {
  const port = mediaPort();
  await createOpenMedia(port)({ name: 'sample.d64', bytes: sampleMedia('d64'), mediaType: 'd64', saveToLibrary: false });
  assert.deepEqual([port.calls[0][1].writeProtected, port.calls[0][2]], [true, { targetDrive: 8, autorun: false }]);
});
test('Mount only suppresses autorun even when explicitly enabled', async () => {
  const port = mediaPort();
  await createOpenMedia(port)({ name: 'sample.d64', bytes: sampleMedia('d64'), mediaType: 'd64', action: 'mount', autorun: true, saveToLibrary: false });
  assert.equal(port.calls[0][2].autorun, false);
});
test('Missing ROMs prevent media insertion', async () => {
  const port = mediaPort({ isRunning: () => false, powerOn: async () => false });
  await assert.rejects(createOpenMedia(port)({ bytes: sampleMedia('prg'), mediaType: 'prg' }), /required ROMs/);
  assert.equal(port.calls.length, 0);
});
test('Save-only does not boot a powered-off machine', async () => {
  const port = mediaPort({ isRunning: () => false, powerOn: async () => { throw new Error('Must not boot'); } });
  await createOpenMedia(port)({ name: 'x.prg', bytes: sampleMedia('prg'), mediaType: 'prg', action: 'save' });
  assert.equal(port.calls[0][0], 'save');
});
test('Library metadata accompanies saved media', async () => {
  const port = mediaPort();
  await createOpenMedia(port)({ name: 'x.prg', bytes: sampleMedia('prg'), mediaType: 'prg', action: 'save', metadata: { source: 'test-catalog', releaseTitle: 'Example' } });
  assert.deepEqual(port.calls[0][4], { source: 'test-catalog', releaseTitle: 'Example' });
});
test('Invalid D64 bytes never power on the emulator', async () => {
  const port = mediaPort({ isRunning: () => false, powerOn: async () => { throw new Error('Must not boot'); } });
  await assert.rejects(createOpenMedia(port)({ bytes: new Uint8Array(10), mediaType: 'd64' }), /D64 size/);
});
test('Invalid CRT packet lengths cannot reach the cartridge loader', () => {
  const bytes = sampleMedia('crt'); new DataView(bytes.buffer).setUint32(68, 16);
  assert.throws(() => validateMedia(bytes, 'crt'), /CHIP length/);
});
test('Truncated TAP data fails header length validation', () => assert.throws(() => validateMedia(sampleMedia('tap').slice(0, 22), 'tap'), /payload length/));

function zipFixture(name = 'folder/demo.prg', input = sampleMedia('prg'), method = 0) {
  const path = new TextEncoder().encode(name);
  const data = method === 8 ? deflateRawSync(input) : input;
  const central = 30 + path.length + data.length, end = central + 46 + path.length;
  const bytes = new Uint8Array(end + 22), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true); view.setUint16(8, method, true); view.setUint32(14, crc32(input), true);
  view.setUint32(18, data.length, true); view.setUint32(22, input.length, true); view.setUint16(26, path.length, true);
  bytes.set(path, 30); bytes.set(data, 30 + path.length);
  view.setUint32(central, 0x02014b50, true); view.setUint16(central + 10, method, true); view.setUint32(central + 16, crc32(input), true);
  view.setUint32(central + 20, data.length, true); view.setUint32(central + 24, input.length, true); view.setUint16(central + 28, path.length, true); bytes.set(path, central + 46);
  view.setUint32(end, 0x06054b50, true); view.setUint16(end + 8, 1, true); view.setUint16(end + 10, 1, true); view.setUint32(end + 12, end - central, true); view.setUint32(end + 16, central, true);
  return bytes;
}
for (const method of [0, 8]) test(`ZIP method ${method} extracts only the selected bytes`, async () => assert.deepEqual(await inspectZip(zipFixture('demo.prg', sampleMedia('prg'), method))[0].extract(), sampleMedia('prg')));
for (const name of ['../evil.prg', '/evil.prg', 'C:/evil.prg', 'folder/../evil.prg', 'a\\evil.prg']) test(`ZIP rejects unsafe path ${name}`, () => assert.throws(() => inspectZip(zipFixture(name)), /Unsafe/));
test('ZIP expansion bombs are rejected before decompression', () => assert.throws(() => inspectZip(zipFixture('x.prg', new Uint8Array(1000000), 8)), /Unsafe/));
test('ZIP corruption is rejected by CRC', async () => {
  const bytes = zipFixture('demo.prg'); bytes[38] ^= 0xff;
  await assert.rejects(inspectZip(bytes)[0].extract(), /CRC/);
});
test('Nested ZIP files are never extracted recursively', () => assert.equal(inspectZip(zipFixture('nested.zip')).length, 0));

test('Newest resolves to the advertised date field in descending order', () => {
  assert.equal(buildQuery({}, { id: 'newest', direction: null }, definitions), '(sort:date) & (order:desc)');
});
test('Newest falls back to the advertised year field', () => {
  const fields = filterDefinitions(normalizePresets([{ type: 'sort', values: ['year'] }, { type: 'order', values: ['desc'] }]));
  assert.equal(buildQuery({}, { id: 'newest', direction: null }, fields), '(sort:year) & (order:desc)');
});
test('An explicit relevance sort remains valid for an empty search', () => {
  assert.equal(buildQuery({}, { id: 'relevance', direction: null }, definitions), '');
});

test('Newest has one option without a duplicate raw date field', () => {
  assert.deepEqual(sortOptions(definitions).filter(option => ['newest', 'date'].includes(option.value)), [{ value: 'newest', label: 'Newest' }]);
});
test('Legacy saved date sorts remain selectable', () => {
  assert.ok(sortOptions(definitions, 'date').some(option => option.value === 'date'));
});
