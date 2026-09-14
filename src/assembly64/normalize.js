// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { mediaTypeOf, safeExternalUrl, safeFilename } from '../media/formats.js';

const text = value => typeof value === 'string' ? value.slice(0, 4000) : null;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const names = value => Array.isArray(value) ? value.map(text).filter(Boolean).join(', ') : text(value);
export function normalizeItem(raw, categories = []) {
  if (!raw || !['string', 'number'].includes(typeof raw.id) || !String(raw.id).length || String(raw.id).length > 512 || !Number.isSafeInteger(raw.category) || raw.category < 0) throw new Error('Assembly64 returned an invalid item reference.');
  const category = categories.find(c => c.id === raw.category);
  const year = number(raw.year);
  const originalUrl = safeExternalUrl(raw.csdbUrl, ['csdb.dk', 'www.csdb.dk']);
  const releaseId = /^[1-9]\d*$/.test(String(raw.csdbId)) ? String(raw.csdbId) : null;
  return {
    id: JSON.stringify([raw.category, String(raw.id)]), provider: 'assembly64', ref: { id: String(raw.id), categoryId: raw.category },
    title: text(raw.name) || 'Untitled release', kind: text(raw.kind) || category?.name || 'Unknown type',
    source: text(raw.source) || category?.source || 'Unknown source',
    producer: names(raw.group) || names(raw.producer) || null,
    year: year > 0 ? year : null, date: text(raw.released) || text(raw.updated), rating: number(raw.rating),
    description: text(raw.description),
    facts: [['Group / producer', names(raw.group) || names(raw.producer)], ['Handle / artist', names(raw.handle)], ['Party', text(raw.event)], ['Competition', text(raw.compo)], ['Place', number(raw.place)]]
      .filter(([, value]) => value != null && value !== '').map(([label, value]) => ({ label, value })),
    originalUrl: originalUrl || (releaseId ? `https://csdb.dk/release/?id=${releaseId}` : null),
    files: Array.isArray(raw.files) ? normalizeFiles({ contentEntry: raw.files }, { id: String(raw.id), categoryId: raw.category }) : [],
  };
}
export function normalizeFiles(raw, item) {
  if (!raw || !Array.isArray(raw.contentEntry) || raw.contentEntry.length > 4096) throw new Error('Assembly64 returned an invalid file list.');
  const seen = new Set();
  return raw.contentEntry.map(file => {
    if (!file || !['string', 'number'].includes(typeof file.id) || !String(file.id).length || String(file.id).length > 512 || seen.has(String(file.id)) || typeof file.path !== 'string') throw new Error('Assembly64 returned an invalid file reference.');
    seen.add(String(file.id));
    const name = safeFilename(file.path);
    const size = Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : null;
    return { id: String(file.id), ref: { itemId: item.id, categoryId: item.categoryId, id: String(file.id), size }, name, mediaType: mediaTypeOf(name), size };
  });
}
export function normalizePage(raw, { offset, limit }, categories) {
  if (!Array.isArray(raw) || raw.length > limit) throw new Error('Assembly64 returned an invalid search page.');
  return { items: raw.map(item => normalizeItem(item, categories)), nextOffset: offset + raw.length, hasMore: raw.length === limit };
}
