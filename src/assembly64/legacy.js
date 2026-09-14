// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { normalizeItem } from './normalize.js';

export function migrateFavorite(record) {
  if (record?.provider !== 'assembly64' || record.schemaVersion !== undefined) return null;
  const item = normalizeItem({ id: record.id, category: record.categoryId, name: record.title, group: record.producer || record.group });
  return { ...record, ...item, kind: record.kind, source: record.source, year: record.year, rating: record.rating, originalUrl: record.originalUrl, schemaVersion: 2 };
}
export function migrateSearch(record) {
  if (record?.pluginId !== 'assembly64' || record.queryVersion !== 1 || !record.filters || typeof record.filters !== 'object' || Array.isArray(record.filters)) return null;
  const { sort: fieldSort, order, ...filters } = record.filters;
  return { ...record, schemaVersion: 2, queryVersion: 2, query: { filters, sort: { id: record.sort || fieldSort || 'relevance', direction: order || null } } };
}
export function migrateLibraryMetadata(record) {
  if (record?.source !== 'assembly64' || !Number.isSafeInteger(record.assembly64CategoryId) || record.assembly64CategoryId < 0 || !['string', 'number'].includes(typeof record.assembly64ItemId) || !['string', 'number'].includes(typeof record.assembly64FileId)) return null;
  const itemRef = { id: String(record.assembly64ItemId), categoryId: record.assembly64CategoryId };
  return {
    version: 1, provider: 'assembly64', itemId: JSON.stringify([itemRef.categoryId, itemRef.id]), itemRef,
    fileId: String(record.assembly64FileId),
    fileRef: { itemId: itemRef.id, categoryId: itemRef.categoryId, id: String(record.assembly64FileId) },
  };
}
