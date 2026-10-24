import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiskQueue } from '../src/media/disk-queue.js';
import { createOpenMedia, validateMedia } from '../src/media/open.js';
import { createAssembly64Actions } from '../src/assembly64/actions.js';
import { sampleMedia } from './fixtures/assembly64.js';

const request = (name = 'disk1.d64', type = 'd64') => {
  let bytes = sampleMedia(type);
  if (type === 'g64') {
    bytes = new Uint8Array(20);
    bytes.set(new TextEncoder().encode('GCR-1541'));
    bytes[9] = 1; bytes[10] = 1;
  }
  return { name, mediaType: type, bytes };
};
function setup(saved = null, overrides = {}) {
  let disk = null, data = saved, fail = false;
  const calls = [];
  const store = { load: async () => structuredClone(data), save: async value => {
    if (fail) throw new Error('quota');
    data = structuredClone(value); calls.push('save');
  } };
  const q = createDiskQueue({ store, current: () => disk, commit: () => calls.push('commit'),
    prepare: async () => calls.push('prepare'), persistDisk: async () => calls.push('persist'),
    mount: async value => { calls.push('mount'); disk = value; }, ...overrides });
  return { q, calls, get data() { return data; }, get disk() { return disk; }, set disk(value) { disk = value; }, set fail(value) { fail = value; } };
}

test('queueing leaves the inserted disk untouched and includes it first', async () => {
  const h = setup(); h.disk = validateMedia(sampleMedia('d64'), 'd64'); h.disk._libName = 'first.d64';
  const current = h.disk;
  await h.q.add([request('second.d64'), request('third.d64')]);
  assert.equal(h.disk, current, 'adding disks never changes mounted media');
  assert.deepEqual(h.q.state.entries.map(e => e.name), ['first.d64', 'second.d64', 'third.d64'], 'an inserted disk starts a new queue');
});

test('next retains earlier disks and stops at the end unless loop is enabled', async () => {
  const h = setup(); await h.q.add([request(), request('disk2.d64')]);
  await h.q.next(); await h.q.next();
  assert.equal(h.q.state.entries.length, 2, 'switching does not consume disks');
  assert.equal(await h.q.next(), false, 'the last disk stops the queue by default');
  await h.q.setLoop(true); await h.q.next();
  assert.equal(h.q.state.index, 0, 'loop returns to the first disk');
});

test('moving disks tracks the mounted disk by identity, not index', async () => {
  const h = setup(); await h.q.add([request(), request('disk2.d64'), request('disk3.d64')]); await h.q.next();
  await h.q.move(h.q.state.entries[0].id, 1);
  assert.equal(h.q.state.index, 1, 'reordering does not change which disk is inserted');
  await h.q.next();
  assert.equal(h.disk._libName, 'disk3.d64', 'next follows the reordered list');
});

test('removing the inserted disk or clearing a queue does not eject it', async () => {
  const h = setup(); await h.q.add([request(), request('disk2.d64')]); await h.q.next(); const inserted = h.disk;
  await h.q.remove(h.q.state.entries[0].id);
  assert.equal(h.disk, inserted, 'removing an entry never ejects it');
  await h.q.clear();
  assert.equal(h.disk, inserted, 'clearing a queue never ejects it');
});

test('saved queue order and write protection survive reload without mounting anything', async () => {
  const h = setup(); await h.q.add([{ ...request(), writeProtected: false }, request('disk2.d64')]);
  await h.q.move(h.q.state.entries[0].id, 1); await h.q.setLoop(true);
  const restored = setup(h.data); await restored.q.ready;
  assert.equal(restored.disk, null, 'restoring the queue does not replace current machine media');
  assert.deepEqual(restored.q.state.entries.map(e => e.name), ['disk2.d64', 'disk1.d64'], 'order survives reload');
  await restored.q.insert(restored.q.state.entries[1].id);
  assert.equal(restored.disk.writeProtected, false, 'write protection survives reload');
  assert.equal(restored.q.state.loop, true, 'loop preference survives reload');
});

test('written data is committed and saved before switching and survives returning', async () => {
  const h = setup(); await h.q.add([request(), request('disk2.d64')]); await h.q.next();
  h.disk.img[100] = 37; h.disk.dirty = true; h.disk.writeProtected = false;
  h.calls.length = 0; await h.q.next();
  assert.ok(h.calls.indexOf('persist') < h.calls.indexOf('mount'), 'outgoing writes persist before the mount');
  assert.equal(h.data.entries[0].bytes[100], 37, 'saved queue includes disk writes');
  await h.q.insert(h.q.state.entries[0].id);
  assert.equal(h.disk.img[100], 37, 'returning keeps written data');
  assert.equal(h.disk.writeProtected, false, 'returning keeps write protection');
});

test('writes completed during eject are saved before attaching the next disk', async () => {
  const h = setup(null, { mount: async (disk, metadata, beforeAttach) => {
    if (h.disk) { h.disk.img[101] = 48; h.disk.dirty = true; }
    await beforeAttach();
    h.disk = disk;
  } });
  await h.q.add([request(), request('disk2.d64')]); await h.q.next();
  await h.q.next();
  assert.equal(h.data.entries[0].bytes[101], 48, 'the saved outgoing image includes final eject writes');
});

test('storage failures leave the current disk and queue order unchanged', async () => {
  const h = setup(); await h.q.add([request(), request('disk2.d64')]); await h.q.next(); const disk = h.disk;
  h.fail = true;
  await assert.rejects(h.q.next(), /Could not save disk queue/);
  assert.equal(h.disk, disk, 'failed persistence never ejects a disk');
  await assert.rejects(h.q.move(h.q.state.entries[0].id, 1), /Could not save disk queue/);
  assert.equal(h.q.state.index, 0, 'failed reorder is not applied');
});

test('failed Library persistence protects modified media outside the queue', async () => {
  const h = setup(null, { persistDisk: async () => { throw new Error('Library full'); } });
  await h.q.add([request()]);
  h.disk = validateMedia(sampleMedia('d64'), 'd64'); h.disk.dirty = true;
  const disk = h.disk;
  await assert.rejects(h.q.next(), /Library full/);
  assert.equal(h.disk, disk, 'a modified disk stays inserted when it cannot be saved');
});

test('same filename with different bytes stays a distinct queued disk', async () => {
  const h = setup(); const a = request(), b = request(); b.bytes[100] = 12;
  await h.q.add([a, b]);
  assert.equal(h.q.state.entries.length, 2, 'different content is never replaced by filename');
  assert.equal(await h.q.add([a]), 0, 'an identical disk is not added twice');
  a.bytes[100] = 99;
  await h.q.next();
  assert.notEqual(h.disk.img[100], 99, 'queued data owns its bytes');
});

test('queue operations exclude overlapping switches', async () => {
  let release;
  const h = setup(null, { prepare: () => new Promise(resolve => { release = resolve; }) });
  await h.q.add([request(), request('disk2.d64')]);
  const first = h.q.next(); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(h.q.next(), /already in progress/);
  release(); await first;
});

test('a manual media change during preparation cancels the queued insertion', async () => {
  const h = setup(null, { prepare: async () => { h.disk = validateMedia(sampleMedia('d64'), 'd64'); } });
  await h.q.add([request()]);
  await assert.rejects(h.q.next(), /inserted disk changed/);
  assert.ok(!h.calls.includes('mount'), 'an intervening media choice is never overwritten');
});

for (const type of ['d64', 'd71', 'd81', 'g64']) test(`${type} disks can be queued and mounted`, async () => {
  const h = setup(); await h.q.add([request(`disk.${type}`, type)]); await h.q.next();
  assert.ok(h.disk, 'the supported disk image mounts');
});

test('invalid media and non-disk files leave the queue unchanged', async () => {
  const h = setup();
  await assert.rejects(h.q.add([{ ...request(), bytes: new Uint8Array(20) }]), /D64 size/);
  await assert.rejects(h.q.add([request('file.prg', 'prg')]), /Only disk images/);
  assert.equal(h.q.state.entries.length, 0, 'invalid media is not queued');
});

test('queue media action bypasses power, reset, SID and autorun', async () => {
  const calls = [];
  const forbidden = () => { throw new Error('must not affect the machine'); };
  const open = createOpenMedia({ powerOn: forbidden, isRunning: forbidden, reset: forbidden, getAutorunEnabled: forbidden,
    configureSid: forbidden, disk: forbidden, queue: async r => { calls.push(r); return 1; } });
  await open({ ...request(), action: 'queue', reset: true, autorun: true, saveToLibrary: false });
  assert.equal(calls.length, 1, 'queue action only queues the disk');
  await assert.rejects(open({ ...request(), action: 'queue', targetDrive: 9 }), /drive 8 only/);
});

test('Assembly64 queue action downloads before queueing without opening media', async () => {
  const h = setup(); let downloads = 0;
  const controller = { online: () => true, download: async () => { downloads++; return sampleMedia('d64'); } };
  const open = createOpenMedia({ queue: r => h.q.add([r]), isRunning: () => { throw new Error('must not boot'); } });
  const perform = createAssembly64Actions(controller, open);
  await perform({ title: 'Game', id: '1', ref: { id: '1', categoryId: 3 } }, { id: '2', name: 'disk.d64', mediaType: 'd64', ref: { id: '2' } }, { action: 'queue', saveToLibrary: false });
  assert.equal(downloads, 1, 'Assembly64 bytes are fetched when queued');
  assert.equal(h.data.entries[0].metadata.releaseTitle, 'Game', 'release metadata follows the queued disk');
  assert.equal(h.disk, null, 'queueing a catalog disk does not mount it');
});
