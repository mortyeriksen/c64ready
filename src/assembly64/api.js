// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { MAX_DOWNLOAD_BYTES } from '../media/formats.js';
import { DownloadError, readLimited } from '../media/stream.js';
import { createRequestQueue } from './request-queue.js';

export const API_BASE = 'https://hackerswithstyle.se/leet/';
const METADATA_TTL = 5 * 60 * 1000;
const SEARCH_TTL = 30 * 1000;
const CACHE_BYTES = 4 * 1024 * 1024;
const CACHE_ENTRIES = 64;
export class Assembly64Error extends DownloadError {
  constructor(message, status = null) { super(message); this.name = 'Assembly64Error'; this.status = status; }
}
export function createAssembly64Api({ transport, timeoutMs = 15000, online = () => globalThis.navigator?.onLine !== false, now = Date.now, requestIntervalMs = 250 } = {}) {
  const cache = new Map(), pending = new Map();
  const schedule = createRequestQueue({ intervalMs: requestIntervalMs });
  let cacheBytes = 0, retryAt = 0;
  function removeCached(key) {
    const entry = cache.get(key);
    if (entry) { cacheBytes -= entry.size; cache.delete(key); }
  }
  function remember(key, value, size, ttl) {
    for (const [id, entry] of cache) if (entry.expires <= now()) removeCached(id);
    removeCached(key);
    while (cache.size && (cache.size >= CACHE_ENTRIES || cacheBytes + size > CACHE_BYTES)) removeCached(cache.keys().next().value);
    if (size <= CACHE_BYTES) { cache.set(key, { value, size, expires: now() + ttl }); cacheBytes += size; }
  }
  function checkAvailability() {
    if (!online()) throw new Assembly64Error('Offline — Assembly64 search and downloads need a connection.');
    if (retryAt > now()) throw new Assembly64Error(`Assembly64 asked us to slow down. Try again in ${Math.ceil((retryAt - now()) / 1000)} seconds.`, 429);
  }
  async function fetchValue(url, controller, { binary, ttl, onProgress, expectedSize }) {
    checkAvailability();
    const timer = setTimeout(() => controller.abort(new DOMException('Assembly64 request timed out. Try again.', 'TimeoutError')), timeoutMs);
    try {
      const response = await transport(url, { method: 'GET', headers: { 'Client-Id': 'c64ready', Accept: binary ? 'application/octet-stream' : 'application/json' }, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal });
      controller.signal.throwIfAborted();
      if (!response.ok) {
        const retry = response.headers.get('retry-after');
        if (response.status === 429 || (response.status === 503 && retry)) {
          const delay = /^\d+$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry) - now();
          retryAt = Math.max(retryAt, now() + (Number.isFinite(delay) && delay > 0 ? delay : 30000));
        }
        await response.body?.cancel();
        checkAvailability();
        throw new Assembly64Error(response.status === 404 ? 'This item or file is no longer available.' : `Assembly64 HTTP ${response.status}. Try again later.`, response.status);
      }
      const bytes = await readLimited(response, binary ? MAX_DOWNLOAD_BYTES : 2 * 1024 * 1024, controller.signal, { onProgress, expectedSize });
      if (binary) return bytes;
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw new Assembly64Error('Assembly64 returned invalid JSON.'); }
      if (ttl) remember(url, value, bytes.length, ttl);
      return value;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof DownloadError) throw error;
      throw new Assembly64Error('Could not reach Assembly64. Check your connection or try again.');
    } finally { clearTimeout(timer); }
  }
  function subscribe(entry, signal, binary) {
    return new Promise((resolve, reject) => {
      const subscriber = {};
      let settled = false;
      function finish(error, value) {
        if (settled) return;
        settled = true; signal?.removeEventListener('abort', abort); entry.subscribers.delete(subscriber);
        if (error) reject(error); else resolve(binary ? value : structuredClone(value));
      }
      function abort() {
        finish(signal.reason);
        if (!entry.settled && !entry.subscribers.size) entry.controller.abort(signal.reason);
      }
      entry.subscribers.add(subscriber);
      signal?.addEventListener('abort', abort, { once: true });
      entry.promise.then(value => finish(null, value), error => finish(error));
      if (signal?.aborted) abort();
    });
  }
  async function request(path, { signal, binary = false, ttl = 0, query, onProgress, expectedSize } = {}) {
    signal?.throwIfAborted();
    if (typeof transport !== 'function') throw new Assembly64Error('Assembly64 connection is unavailable. Reload the app and try again.');
    if (!online()) checkAvailability();
    const address = new URL(path, API_BASE);
    if (query !== undefined) address.searchParams.set('query', query);
    const url = address.href;
    const cached = cache.get(url);
    if (ttl && cached?.expires > now()) {
      cache.delete(url); cache.set(url, cached);
      return structuredClone(cached.value);
    }
    if (cached) removeCached(url);
    checkAvailability();
    let entry = binary ? null : pending.get(url);
    if (!entry || entry.controller.signal.aborted) {
      entry = { controller: new AbortController(), subscribers: new Set(), settled: false };
      entry.promise = schedule(() => fetchValue(url, entry.controller, { binary, ttl, onProgress, expectedSize }), entry.controller.signal)
        .finally(() => { entry.settled = true; if (pending.get(url) === entry) pending.delete(url); });
      if (!binary) pending.set(url, entry);
    }
    return subscribe(entry, signal, binary);
  }
  const part = value => {
    if (!['string', 'number'].includes(typeof value) || !String(value).length || String(value).length > 512 || ['.', '..'].includes(String(value))) throw new Assembly64Error('Invalid Assembly64 reference.');
    return encodeURIComponent(String(value));
  };
  return {
    categories: signal => request('search/categories', { signal, ttl: METADATA_TTL }),
    presets: signal => request('search/aql/presets', { signal, ttl: METADATA_TTL }),
    search: ({ offset, limit, query, signal }) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Assembly64Error('Invalid search page.');
      return request(`search/aql/${offset}/${limit}`, { query, signal, ttl: SEARCH_TTL });
    },
    meta: (ref, signal) => request(`search/meta/${part(ref.id)}/${part(ref.categoryId)}`, { signal, ttl: METADATA_TTL }),
    entries: (ref, signal) => request(`search/entries/${part(ref.id)}/${part(ref.categoryId)}`, { signal, ttl: METADATA_TTL }),
    download: (ref, signal, onProgress) => request(`search/bin/${part(ref.itemId)}/${part(ref.categoryId)}/${part(ref.id)}`, { signal, binary: true, onProgress, expectedSize: ref.size }),
    zip: (ref, signal, onProgress) => request(`search/zip/${part(ref.id)}/${part(ref.categoryId)}`, { signal, binary: true, onProgress }),
  };
}
