// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { validateMedia } from './open.js';
import { DISK_MEDIA, safeFilename } from './formats.js';
import { sourceMetadata } from './source-metadata.js';

const MAX_DISKS = 64;
const MAX_BYTES = 128 * 1024 * 1024;
const diskType = disk => disk.isG64 ? 'g64' : disk.kind || 'd64';

// Queue images have their own storage: Library eviction, deletion and same-name
// replacements cannot change a disk that is already in the queue.
export function createDiskQueueStore() {
  let opened;
  const db = () => opened ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('c64emu-disk-queue', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('queue');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  async function access(mode, value) {
    const database = await db();
    return new Promise((resolve, reject) => {
      const tx = database.transaction('queue', mode);
      const store = tx.objectStore('queue');
      const request = mode === 'readonly' ? store.get('drive8') : store.put(value, 'drive8');
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('Disk queue storage failed.'));
    });
  }
  return { load: () => access('readonly'), save: value => access('readwrite', value) };
}

export function createDiskQueue({ store, current, commit, prepare, mount, persistDisk, changed = () => {} }) {
  let entries = [], loop = false, busy = false, error = '';
  let serial = 0;
  const snapshot = (items = entries, repeat = loop) => ({ version: 1, loop: repeat, entries: items.map(e => ({
    id: e.id, name: e.name, type: diskType(e.disk), bytes: e.disk.img.slice(),
    writeProtected: e.disk.writeProtected !== false, metadata: e.metadata,
  })) });
  const emit = () => changed();
  const make = (disk, name, metadata = {}) => ({ id: `disk-${++serial}`, disk, name, metadata: sourceMetadata(metadata) });
  function limits(items) {
    if (items.length > MAX_DISKS) throw new Error(`The queue can hold up to ${MAX_DISKS} disks.`);
    if (items.reduce((size, e) => size + e.disk.img.length, 0) > MAX_BYTES) throw new Error('The queue can hold up to 128 MiB of disk images.');
  }
  const ready = (async () => {
    try {
      const saved = await store.load();
      if (!saved) return;
      if (saved.version !== 1 || !Array.isArray(saved.entries) || saved.entries.length > MAX_DISKS) throw new Error('Invalid saved disk queue.');
      const restored = saved.entries.map(e => {
        if (!DISK_MEDIA.includes(e.type)) throw new Error('Invalid disk type in saved queue.');
        const disk = validateMedia(e.bytes, e.type);
        disk._libName = safeFilename(e.name);
        disk.writeProtected = e.writeProtected !== false;
        return make(disk, disk._libName, e.metadata);
      });
      limits(restored);
      entries = restored;
      loop = saved.loop === true;
    } catch (e) { error = `Could not restore disk queue: ${e.message}`; }
    finally { emit(); }
  })();
  async function run(action) {
    if (busy) throw new Error('A disk queue operation is already in progress.');
    busy = true; emit();
    try { await ready; error = ''; return await action(); }
    catch (e) { error = e.message; throw e; }
    finally { busy = false; emit(); }
  }
  async function save(items = entries, repeat = loop) {
    commit?.();
    limits(items);
    try { await store.save(snapshot(items, repeat)); }
    catch { throw new Error('Could not save disk queue. Check browser storage space. The disk has not been changed.'); }
  }
  function index() { return entries.findIndex(e => e.disk === current()); }
  function nextEntry() {
    if (!entries.length) return null;
    const i = index();
    if (i < 0) return entries[0];
    return entries[i + 1] || (loop && entries.length > 1 ? entries[0] : null);
  }
  async function insert(entry) {
    if (!entry || entry.disk === current()) return false;
    const outgoing = current();
    await prepare?.(entry.disk);
    if (current() !== outgoing) throw new Error('The inserted disk changed. Choose the queued disk again.');
    commit?.();
    if (outgoing?.dirty) await persistDisk?.(outgoing);
    await save();
    if (current() !== outgoing) throw new Error('The inserted disk changed. Choose the queued disk again.');
    const mounted = await mount(entry.disk, entry.metadata, async () => {
      // Persist again after eject commits the last writes and the image can
      // no longer change underneath an asynchronous storage transaction.
      if (outgoing?.dirty) await persistDisk?.(outgoing);
      await save();
    });
    if (mounted === false) throw new Error('Disk swap cancelled by another media operation.');
    return true;
  }
  return {
    ready,
    get state() { return { entries: entries.map(e => ({ id: e.id, name: e.name, current: e.disk === current() })), loop, busy, error, index: index(), next: nextEntry()?.name || null }; },
    refresh: emit,
    add: requests => run(async () => {
      const added = requests.map(request => {
        if (!DISK_MEDIA.includes(request.mediaType)) throw new Error('Only disk images can be queued.');
        const disk = validateMedia(request.bytes.slice(), request.mediaType);
        disk._libName = safeFilename(request.name);
        disk.writeProtected = request.writeProtected !== false;
        return make(disk, disk._libName, request.metadata);
      });
      const items = [...entries];
      const inserted = current();
      if (!items.length && inserted) items.push(make(inserted, inserted._libName || `${inserted.diskName}.${diskType(inserted)}`));
      let count = 0;
      for (const entry of added) {
        if (items.some(e => e.name === entry.name && diskType(e.disk) === diskType(entry.disk)
          && e.disk.img.length === entry.disk.img.length && e.disk.img.every((v, i) => v === entry.disk.img[i]))) continue;
        items.push(entry); count++;
      }
      await save(items); entries = items;
      return count;
    }),
    next: () => run(() => insert(nextEntry())),
    insert: id => run(() => insert(entries.find(e => e.id === id))),
    move: (id, to) => run(async () => {
      const from = entries.findIndex(e => e.id === id);
      if (from < 0 || !Number.isInteger(to) || to < 0 || to >= entries.length || from === to) return;
      const items = [...entries];
      items.splice(to, 0, items.splice(from, 1)[0]);
      await save(items); entries = items;
    }),
    remove: id => run(async () => { const items = entries.filter(e => e.id !== id); await save(items); entries = items; }),
    clear: () => run(async () => { await save([]); entries = []; }),
    setLoop: value => run(async () => { await save(entries, !!value); loop = !!value; }),
    checkpoint: () => run(() => save()),
  };
}
