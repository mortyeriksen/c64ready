// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
const NAME = 'c64emu-iec-devices';
async function transaction(mode, fn) {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('devices', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('devices', mode), result = fn(tx.objectStore('devices'));
      tx.oncomplete = () => resolve(result?.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export const listIecInstalled = () => transaction('readonly', s => s.getAll());
export const putIecInstalled = record => transaction('readwrite', s => s.put(record));
export const removeIecInstalled = id => transaction('readwrite', s => s.delete(id));
