// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
export class DownloadError extends Error {}

export async function readLimited(response, maxBytes, signal, { onProgress, expectedSize } = {}) {
  const header = response.headers.get('content-length');
  const length = /^\d+$/.test(header || '') ? Number(header) : null;
  if (length > maxBytes) { await response.body?.cancel(); throw new DownloadError('Download exceeds the size limit.'); }
  if (!response.body) throw new DownloadError('The server returned an empty response.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const encoding = response.headers.get('content-encoding');
  const hint = !encoding || encoding === 'identity' ? length ?? expectedSize : expectedSize;
  let expected = Number.isSafeInteger(hint) && hint > 0 ? hint : null;
  const report = done => onProgress?.({ loaded: total, total: expected, done });
  const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    report(false);
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new DownloadError('Download exceeds the size limit.');
      if (expected !== null && total > expected) expected = null;
      chunks.push(value);
      report(false);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    if (expected !== null && total !== expected) expected = null;
    report(true);
    return bytes;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
