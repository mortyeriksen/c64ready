// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { sourceMetadata } from '../media/source-metadata.js';

export function savedLibraryFiles(item, entries) {
  const saved = new Set();
  if (!item.ref?.id || !Number.isSafeInteger(item.ref.categoryId)) return saved;
  for (const entry of entries) {
    const provenance = sourceMetadata(entry).provenance;
    if (provenance?.provider !== 'assembly64' || provenance.itemRef?.id !== item.ref.id || provenance.itemRef?.categoryId !== item.ref.categoryId) continue;
    for (const file of item.files) {
      if (provenance.fileId === file.id && entry.type === file.mediaType) saved.add(file.id);
    }
  }
  return saved;
}
