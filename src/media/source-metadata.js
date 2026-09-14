// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { copyData } from '../serializable.js';
import { migrateLibraryMetadata } from '../assembly64/legacy.js';
export function sourceMetadata(value = {}) {
  const out = {};
  for (const key of ['source', 'releaseTitle']) {
    if (typeof value?.[key] === 'string' && value[key].length <= 512) out[key] = value[key];
  }
  try {
    const provenance = value?.provenance ?? migrateLibraryMetadata(value);
    if (provenance?.version === 1 && typeof provenance.provider === 'string' && provenance.provider === out.source && typeof provenance.itemId === 'string' && typeof provenance.fileId === 'string') {
      out.provenance = {
        version: 1, provider: out.source, itemId: provenance.itemId, fileId: provenance.fileId,
        itemRef: copyData(provenance.itemRef), fileRef: copyData(provenance.fileRef),
      };
    }
  } catch { /* Invalid optional provenance does not invalidate local media. */ }
  return out;
}
