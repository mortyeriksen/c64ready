// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { copyData } from '../serializable.js';

export const defaultSort = (filters = {}) => ({ id: `${filters.name || ''}${filters.file || ''}`.trim() ? 'relevance' : 'newest', direction: null });
export const defaultQuery = () => ({ filters: {}, sort: defaultSort() });
export function validateSearchState(query) {
  const value = copyData(query);
  if (!value?.filters || Array.isArray(value.filters) || typeof value.filters !== 'object' || typeof value.sort?.id !== 'string' || ![null, 'asc', 'desc'].includes(value.sort.direction)) throw new Error('Invalid saved search.');
  return value;
}

// The published client uses quoted text and parenthesized clauses joined by &.
// Quoting/escape extensions and OR syntax are not part of that contract.
export function quoteText(value) {
  const text = String(value).trim();
  if (text.length > 200) throw new Error('Search text is limited to 200 characters.');
  if (/["\\()&|\u0000-\u001f\u007f]/.test(text)) throw new Error('Search text cannot contain quotes, backslashes, parentheses, & or |.');
  return `"${text}"`;
}
export function buildQuery(filters, sort, definitions) {
  const known = new Map(definitions.map(f => [f.key, f]));
  const state = { ...filters };
  if (sort?.id && sort.id !== 'relevance') {
    const advertised = known.get('sort')?.options || [];
    state.sort = sort.id === 'newest' ? (advertised.some(option => option.value === 'date') ? 'date' : 'year') : sort.id;
    state.order = sort.direction || (sort.id === 'name' ? 'asc' : 'desc');
  }
  const clauses = [];
  for (const [key, value] of Object.entries(state)) {
    if (value === '' || value == null || (typeof value === 'string' && !value.trim())) continue;
    const field = known.get(key);
    if (!field || !/^[a-z]+$/.test(key)) throw new Error(`Unsupported search filter: ${key}`);
    let literal;
    if (field.type === 'text') literal = quoteText(value);
    else {
      if (!field.options?.some(o => o.value === value) || !/^[\p{L}\p{N} _./+>=-]+$/u.test(value)) throw new Error(`Choose a valid ${field.label.toLowerCase()}.`);
      literal = key === 'rating' && /^\d+(\.\d+)?$/.test(value) ? `>=${value}` : value;
    }
    clauses.push(`(${key}:${literal})`);
  }
  return clauses.join(' & ');
}
