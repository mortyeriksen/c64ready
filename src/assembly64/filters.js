// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

const textFilters = [
  { key: 'name', label: 'Search title', type: 'text' },
  { key: 'group', label: 'Group / producer', type: 'text' },
  { key: 'handle', label: 'Handle / artist', type: 'text' },
  { key: 'event', label: 'Party / event', type: 'text' },
];
const labels = { category: 'Type / category', type: 'File format', repo: 'Source', subcat: 'Subcategory', rating: 'Minimum rating', year: 'Year', date: 'Date', latest: 'Recency', updated: 'Updated', sort: 'Sort field', order: 'Sort direction' };
export function normalizePresets(value) {
  if (!Array.isArray(value)) throw new Error('Assembly64 returned invalid search presets.');
  const seen = new Set();
  return value.filter(p => p && Object.hasOwn(labels, p.type) && !seen.has(p.type) && seen.add(p.type)).map(p => {
    if (!Array.isArray(p.values)) throw new Error('Assembly64 returned invalid preset values.');
    const options = p.values.map(v => {
      const key = typeof v === 'string' ? v : v?.aqlKey;
      if (typeof key !== 'string' || key.length > 120) throw new Error('Assembly64 returned invalid preset values.');
      return { value: key, label: typeof v?.name === 'string' ? v.name.slice(0, 120) : key };
    }).filter(v => /^[\p{L}\p{N} _./+>=-]+$/u.test(v.value));
    return { key: p.type, label: labels[p.type], type: 'select', options };
  });
}
export function normalizeCategories(value, presets = []) {
  if (!Array.isArray(value)) throw new Error('Assembly64 returned invalid categories.');
  return value.map(c => {
    if (!c || !Number.isSafeInteger(c.id) || typeof c.name !== 'string') throw new Error('Assembly64 returned an invalid category.');
    const source = presets.find(p => p.key === 'repo')?.options.find(o => o.value === c.type)?.label;
    return { id: c.id, name: (c.groupingName || c.description || c.name).slice(0, 200), source: source || (typeof c.source === 'string' ? c.source.slice(0, 100) : typeof c.type === 'string' ? c.type.slice(0, 100) : null) };
  });
}
export const filterDefinitions = presets => [...textFilters.map(f => ({ ...f })), ...presets];
export function sortOptions(definitions, selectedId = null) {
  const values = definitions.find(f => f.key === 'sort')?.options.map(o => o.value) || [];
  const options = [{ value: 'relevance', label: 'Relevance' }, ...[
    [values.includes('date') ? 'date' : 'year', 'Newest'], ['rating', 'Rating'], ['name', 'Title'],
  ].filter(([value]) => values.includes(value)).map(([value, label]) => ({ value: label === 'Newest' ? 'newest' : value, label }))];
  const newestField = values.includes('date') ? 'date' : 'year';
  return [...options, ...(definitions.find(f => f.key === 'sort')?.options || []).filter(o => !options.some(s => s.value === o.value) && (o.value !== newestField || o.value === selectedId))];
}
export const quickFilters = fields => ['group', 'category', 'repo'].map(key => fields.find(field => field.key === key)).filter(Boolean);
export const advancedFilters = fields => fields.filter(field => !['sort', 'order'].includes(field.key));
export const sortDirections = fields => (fields.find(field => field.key === 'order')?.options || []).filter(option => ['asc', 'desc'].includes(option.value));
