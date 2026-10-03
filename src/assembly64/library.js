// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { sourceMetadata } from '../media/source-metadata.js';

// A Library entry is a release's file when its provenance names the same
// Assembly64 item and file, and it holds that file's own media type: an entry
// taken out of a ZIP holds the chosen member, not the archive.
function isSavedFile(entry, item, file) {
  const provenance = sourceMetadata(entry).provenance;
  return provenance?.provider === 'assembly64' && provenance.itemRef?.id === item.ref.id
    && provenance.itemRef?.categoryId === item.ref.categoryId && provenance.fileId === file.id && entry.type === file.mediaType;
}
const hasRef = item => !!item.ref?.id && Number.isSafeInteger(item.ref.categoryId);

export function savedLibraryFiles(item, entries) {
  const saved = new Set();
  if (!hasRef(item)) return saved;
  for (const entry of entries) {
    for (const file of item.files) if (isSavedFile(entry, item, file)) saved.add(file.id);
  }
  return saved;
}

/** The Library entry that holds this release's file, newest first, or null. */
export function libraryEntryFor(item, file, entries) {
  if (!hasRef(item)) return null;
  return entries.find(entry => isSavedFile(entry, item, file)) || null;
}
