// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { createAssembly64Api } from './api.js';
import { filterDefinitions, normalizeCategories, normalizePresets } from './filters.js';
import { buildQuery, defaultQuery, defaultSort, validateSearchState } from './query.js';
import { normalizeItem, normalizeFiles, normalizePage } from './normalize.js';

async function requestTogether(requests, signal) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  try { return await Promise.all(requests.map(request => request(controller.signal))); }
  finally { controller.abort(); signal?.removeEventListener('abort', abort); }
}

export class Assembly64Controller {
  constructor({ limit = 10, online = () => globalThis.navigator?.onLine !== false, ...apiOptions } = {}) {
    this.api = createAssembly64Api({ ...apiOptions, online });
    this.online = online;
    this.limit = limit;
    this.fields = filterDefinitions([]);
    this.categories = [];
    this.generation = 0;
    this.listeners = new Set();
    this.state = { ...defaultQuery(), items: [], status: 'idle', message: '', hasMore: false, offset: 0 };
  }
  async initialize() {
    if (!this.initializing) {
      this.initializationController = new AbortController();
      const { signal } = this.initializationController;
      this.initializing = requestTogether([this.api.categories, this.api.presets], signal).then(([categories, presets]) => {
        signal.throwIfAborted();
        const fields = filterDefinitions(normalizePresets(presets));
        this.categories = normalizeCategories(categories, fields);
        this.fields = fields;
        this.emit({});
      }).catch(error => { this.initializing = null; throw error; });
    }
    return this.initializing;
  }
  async getDetails(item, { signal } = {}) {
    const [meta, entries] = await requestTogether([signal => this.api.meta(item.ref, signal), signal => this.api.entries(item.ref, signal)], signal);
    if (!meta || Array.isArray(meta) || typeof meta !== 'object') throw new Error('Assembly64 returned invalid metadata.');
    const details = normalizeItem({ ...meta, id: item.ref.id, category: item.ref.categoryId, name: meta.name || item.title }, this.categories);
    details.files = normalizeFiles(entries, item.ref);
    return details;
  }
  download(file, { signal, onProgress } = {}) { return this.api.download(file.ref, signal, onProgress); }
  async getFiles(item, { signal } = {}) {
    const raw = await this.api.entries(item.ref, signal);
    signal?.throwIfAborted();
    return normalizeFiles(raw, item.ref);
  }
  async quickSearch(filters, { signal } = {}) {
    signal?.throwIfAborted();
    await this.initialize();
    signal?.throwIfAborted();
    const query = buildQuery({ name: filters.name || '', group: filters.group || '', category: filters.category || '', repo: filters.repo || '' }, defaultSort(filters), this.fields);
    const raw = await this.api.search({ query, offset: 0, limit: 10, signal });
    signal?.throwIfAborted();
    return normalizePage(raw, { offset: 0, limit: 10 }, this.categories).items;
  }
  resetQuery() { const query = defaultQuery(); this.setQuery(query.filters, query.sort); }
  subscribe(fn) { this.listeners.add(fn); fn(this.state); return () => this.listeners.delete(fn); }
  emit(update) { this.state = { ...this.state, ...update }; for (const fn of this.listeners) fn(this.state); }
  cancel() {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    if (this.state.status === 'loading') this.emit({ status: this.state.items.length ? 'ready' : 'idle', message: this.state.items.length ? `${this.state.items.length} results` : 'Search cancelled.' });
  }
  setQuery(filters, sort = this.state.sort) {
    const query = validateSearchState({ filters, sort });
    this.cancel();
    this.emit({ ...query, items: [], offset: 0, hasMore: false, status: 'idle', message: '' });
  }
  async search(more = false) {
    if (more && (!this.state.hasMore || this.state.status === 'loading')) return;
    this.cancel();
    const generation = this.generation;
    if (!this.online()) { this.emit({ status: 'error', message: 'Offline — search is unavailable. Open saved files with LOAD LIB.' }); return; }
    this.controller = new AbortController();
    const offset = more ? this.state.offset : 0;
    this.emit({ status: 'loading', message: 'Searching…', ...(more ? {} : { items: [], hasMore: false }) });
    try {
      await this.initialize();
      if (generation !== this.generation) return;
      const query = buildQuery(this.state.filters, this.state.sort, this.fields);
      const raw = await this.api.search({ query, offset, limit: this.limit, signal: this.controller.signal });
      if (generation !== this.generation) return;
      const page = normalizePage(raw, { offset, limit: this.limit }, this.categories);
      const items = [...new Map([...(more ? this.state.items : []), ...page.items].map(item => [item.id, item])).values()];
      this.emit({ items, offset: page.nextOffset, hasMore: page.hasMore, status: 'ready', message: items.length ? `${items.length} results` : 'No results. Try fewer filters.' });
    } catch (error) {
      if (generation !== this.generation) return;
      this.emit({ status: 'error', message: error.name === 'AbortError' ? 'Search cancelled.' : error.message });
    }
  }
  dispose() { this.cancel(); this.initializationController?.abort(); this.listeners.clear(); }
}
