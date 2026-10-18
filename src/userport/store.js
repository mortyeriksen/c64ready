// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/userport/store.js – installed user port devices, kept in this browser's
// IndexedDB. One record per device id: its source text, meta, hash and when it
// was installed.

const DB_NAME = 'c64emu-userport-devices';
const STORE = 'devices';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function listInstalled() {
  return withStore('readonly', (s) => s.getAll()).then((rows) => rows || []);
}

export function getInstalled(id) {
  return withStore('readonly', (s) => s.get(id));
}

export function putInstalled(record) {
  return withStore('readwrite', (s) => s.put(record));
}

export function removeInstalled(id) {
  return withStore('readwrite', (s) => s.delete(id));
}
