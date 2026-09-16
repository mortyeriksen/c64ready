// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { MAX_DOWNLOAD_BYTES, safeFilename } from '../media/formats.js';
import { inspectZip } from '../media/archive.js';
import { copyData } from '../serializable.js';
import { el } from './dom.js';
import { chooseFile } from '../media/choose-file.js';

function chooseArchive(entries, signal) {
  if (!entries.length) throw new Error('The ZIP contains no supported PRG, D64, CRT, TAP, T64 or REU files.');
  return chooseFile('Choose a file from ZIP', entries, {
    label: entry => `${entry.path} · ${entry.size.toLocaleString()} B`,
    note: 'Only the selected media file will be opened and saved. Nested archives are not expanded.',
    signal,
  });
}
export function createAssembly64Actions(controller, openMedia) {
  let busy = false;
  return async function perform(item, file, options, signal, onProgress) {
    if (busy) throw new Error('Another media download is in progress.');
    if (!controller.online()) throw new Error('Offline — new downloads are unavailable. Open saved files with LOAD LIB.');
    if (file.size > MAX_DOWNLOAD_BYTES) throw new Error('Download exceeds the 32 MiB limit.');
    busy = true;
    try {
      let bytes = await controller.download(file, { signal, onProgress: progress => onProgress?.({ ...progress, stage: 'download', name: file.name }) });
      signal?.throwIfAborted();
      if (!(bytes instanceof Uint8Array) || bytes.length > MAX_DOWNLOAD_BYTES) throw new Error('Invalid or oversized download.');
      let name = file.name, mediaType = file.mediaType;
      if (mediaType === 'zip' && options.action !== 'download') {
        onProgress?.({ stage: 'select', name, loaded: 0, total: null });
        const entry = await chooseArchive(inspectZip(bytes), signal);
        if (!entry) return { message: 'Archive selection cancelled.' };
        onProgress?.({ stage: 'extract', name: entry.name, loaded: 0, total: entry.size });
        bytes = await entry.extract(signal, progress => onProgress?.({ ...progress, stage: 'extract', name: entry.name })); name = entry.name; mediaType = entry.mediaType;
      }
      signal?.throwIfAborted();
      if (options.action === 'download') {
        onProgress?.({ stage: 'save', name, loaded: 0, total: null });
        const url = URL.createObjectURL(new Blob([bytes]));
        const a = el('a', null, { href: url, download: safeFilename(name) });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return { message: 'File downloaded.' };
      }
      onProgress?.({ stage: options.action === 'save' ? 'save' : 'open', name, loaded: 0, total: null });
      return await openMedia({ ...options, name, bytes, mediaType, signal,
        metadata: { source: 'assembly64', releaseTitle: item.title, provenance: {
          version: 1, provider: 'assembly64', itemId: item.id, itemRef: copyData(item.ref), fileId: file.id, fileRef: copyData(file.ref),
        } },
      });
    } finally { busy = false; }
  };
}
