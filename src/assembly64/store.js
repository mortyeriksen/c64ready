// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { normalizeItem } from './normalize.js';
import { validateSearchState } from './query.js';
import { migrateFavorite, migrateSearch } from './legacy.js';
import { safeExternalUrl } from '../media/formats.js';

export function createAssembly64Store(storage = globalThis.localStorage) {
  const key = name => `c64emu.mediaBrowser.assembly64.${name}`;
  function read(name) {
    try { const value = JSON.parse(storage.getItem(key(name)) || '[]'); return Array.isArray(value) ? value.slice(0, 500) : []; }
    catch { return []; }
  }
  function write(name, value) {
    if (value.length > 500) throw new Error('The local bookmark limit is 500 entries.');
    try { storage.setItem(key(name), JSON.stringify(value)); }
    catch { throw new Error('Could not save bookmarks. Browser storage may be full or disabled.'); }
  }
  function favorite(item) {
    try {
      const value = item?.schemaVersion === 2 ? item : migrateFavorite(item);
      if (value?.provider !== 'assembly64') return null;
      const normalized = normalizeItem({ id: value.ref?.id, category: value.ref?.categoryId, name: value.title, group: value.producer || value.facts?.find(fact => fact.label === 'Group / producer')?.value, kind: value.kind, source: value.source, year: value.year, rating: value.rating });
      if (normalized.id !== value.id) return null;
      return { ...normalized, originalUrl: safeExternalUrl(value.originalUrl, ['csdb.dk', 'www.csdb.dk']), schemaVersion: 2 };
    } catch { return null; }
  }
  const favorites = () => read('favorites').map(favorite).filter(Boolean);
  function savedSearch(record) {
    try {
      const s = record?.schemaVersion === 2 && record.queryVersion === 2 ? record : migrateSearch(record);
      if (!s || s.pluginId !== 'assembly64' || s.queryVersion !== 2 || typeof s.id !== 'string' || typeof s.name !== 'string') return null;
      return { schemaVersion: 2, id: s.id, name: s.name.slice(0, 100), pluginId: 'assembly64', queryVersion: 2, query: validateSearchState(s.query), createdAt: s.createdAt };
    } catch { return null; }
  }
  const searches = () => read('savedSearches').map(savedSearch).filter(Boolean);
  return {
    favorites, searches,
    isFavorite: item => favorites().some(f => f.id === item.id),
    toggleFavorite(item) {
      const normalized = favorite({ ...item, schemaVersion: 2 });
      if (!normalized) throw new Error('Invalid favorite.');
      const all = read('favorites');
      const matches = f => { const value = favorite(f); return value && value.id === item.id; };
      const found = all.some(matches);
      write('favorites', found ? all.filter(f => !matches(f)) : [...all, normalized]);
      return !found;
    },
    saveSearch(name, filters, sort) {
      name = String(name).trim().slice(0, 100);
      if (!name) throw new Error('Give the search a name.');
      const search = { schemaVersion: 2, id: crypto.randomUUID(), name, pluginId: 'assembly64', queryVersion: 2, query: validateSearchState({ filters, sort }), createdAt: Date.now() };
      write('savedSearches', [...read('savedSearches'), search]);
      return search;
    },
    renameSearch(id, name) {
      name = String(name).trim().slice(0, 100);
      if (!name) throw new Error('Give the search a name.');
      write('savedSearches', read('savedSearches').map(s => s.id === id ? { ...(savedSearch(s) || s), name } : s));
    },
    deleteSearch(id) { write('savedSearches', read('savedSearches').filter(s => s.id !== id)); },
  };
}
