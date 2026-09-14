// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { el, button, renderField } from './dom.js';
import { openBrowserDialog } from './browser-dialog.js';
import { openDetailsDialog } from './details-dialog.js';
import { singleLoadableFile } from '../media/formats.js';
import { createFavoriteIcon } from './icons.js';
import { defaultSort } from './query.js';
import { createDownloadProgress } from './progress.js';
import { canvas } from '../dom.js';

export function createAssembly64Control(root, controller, store, perform) {
  let browser, availableFields = controller.fields, request, generation = 0, items = [], busy = false, quickCategory = 'demos', quickSource = '', lastQuickSearch = null;
  const loadButtons = new Map();
  const form = el('form', null, { class: 'mb-launcher' });
  const input = el('input', null, { type: 'search', placeholder: 'Search titles…', 'aria-label': 'Search media', maxlength: 200, autocomplete: 'off' });
  const searchField = el('label', null, { class: 'mb-field' }); searchField.append(input);
  const type = el('div', null, { class: 'mb-launcher-type' });
  const producer = el('input', null, { type: 'search', placeholder: 'Group / producer…', 'aria-label': 'Group / producer', maxlength: 200, autocomplete: 'off' });
  const producerField = el('label', null, { class: 'mb-field' }); producerField.append(producer);
  const source = el('div', null, { class: 'mb-launcher-source' });
  const filtersRow = el('div', null, { class: 'mb-launcher-filters' }); filtersRow.append(producerField, type);
  const quick = button('⌕', null, { type: 'submit', class: 'btn mb-quick-search', 'aria-label': 'Quick search', title: 'Quick search · top 10 results' });
  const panel = el('div', null, { class: 'mb-quick-panel', hidden: '' });
  const status = el('p', '', { class: 'mb-quick-status', role: 'status', 'aria-live': 'polite' });
  const results = el('div', null, { class: 'mb-quick-results', 'aria-label': 'Quick search results' });
  const progress = createDownloadProgress({ card: true });
  const refine = button('REFINE SEARCH', () => open('results', true), { class: 'btn mb-refine', 'aria-haspopup': 'dialog' });
  const clear = button('CLEAR', () => {
    clearQuick(); input.value = ''; producer.value = ''; quickCategory = 'demos'; quickSource = ''; syncFilters();
  }, { class: 'btn' });
  const quickActions = el('div', null, { class: 'mb-quick-actions', hidden: '' });
  quickActions.append(refine, clear);
  panel.append(status, results, quickActions);
  const hint = el('span', '', { class: 'mb-launcher-hint', role: 'status', hidden: '' });
  function cancelQuick() {
    generation++; request?.abort(); request = null; busy = false;
    for (const [item, node] of loadButtons) updateLoadLabel(item, node);
    progress.finish(); results.setAttribute('aria-busy', 'false'); updateButtons();
  }
  function clearQuick() { cancelQuick(); items = []; results.replaceChildren(); loadButtons.clear(); panel.hidden = true; lastQuickSearch = null; quickActions.hidden = true; }
  function open(view = 'results', refining = false) {
    cancelQuick();
    if (refining && lastQuickSearch) controller.setQuery({ ...lastQuickSearch }, defaultSort(lastQuickSearch));
    else if (view === 'results') controller.setQuery({ category: 'demos' }, defaultSort());
    else controller.resetQuery();
    if (!browser || browser.closed) browser = openBrowserDialog(controller, store, perform, { view });
    if (view === 'results') controller.search();
  }
  const browse = button('EXPLORE', () => open(), { class: 'btn', 'aria-haspopup': 'dialog' });
  const favorite = button('FAVORITES', () => open('favorites'), { class: 'btn', 'aria-haspopup': 'dialog' });
  favorite.prepend(createFavoriteIcon());
  const navigation = el('div', null, { class: 'mb-launcher-navigation' }); navigation.append(browse, favorite);
  filtersRow.append(quick);
  form.append(searchField, source, filtersRow); root.append(navigation, form, panel, hint);

  function updateButtons() {
    quick.disabled = busy || !controller.online();
    for (const node of results.querySelectorAll('button')) node.disabled = busy || !controller.online() || node.dataset.checking === 'true';
  }
  function syncFilters() {
    const field = controller.fields.find(field => field.key === 'category');
    type.replaceChildren();
    type.append(renderField({ ...(field || { type: 'select', options: [] }), label: 'Type', hideLabel: true }, quickCategory, value => {
      quickCategory = value; clearQuick();
    }));
    const sourceField = controller.fields.find(field => field.key === 'repo');
    source.replaceChildren();
    source.append(renderField({ ...(sourceField || { type: 'select', options: [] }), label: 'Source', hideLabel: true, emptyLabel: 'All sources' }, quickSource, value => {
      quickSource = value; clearQuick();
    }));
  }
  function renderResults() {
    results.replaceChildren(); loadButtons.clear();
    for (const item of items) {
      const row = el('div', null, { class: 'mb-quick-result' });
      const summary = el('div', null, { class: 'mb-quick-summary' });
      const title = button(item.title, () => openDetailsDialog(controller, item, perform), { class: 'mb-title', 'aria-haspopup': 'dialog' });
      if (item.producer) title.append(' ', el('span', `— ${item.producer}`, { class: 'mb-producer' }));
      summary.append(title);
      summary.append(el('span', [item.kind, item.source, item.year].filter(Boolean).join(' · '), { class: 'mb-meta' }));
      const loadButton = button('', () => singleLoadableFile(item) ? load(item) : openDetailsDialog(controller, item, perform), { class: 'btn' });
      loadButtons.set(item, loadButton); updateLoadLabel(item, loadButton, !item.files.length);
      row.append(summary, loadButton);
      results.append(row);
    }
    updateButtons();
  }
  function updateLoadLabel(item, node, checking = false) {
    const file = singleLoadableFile(item);
    const label = file ? `LOAD ${file.mediaType.toUpperCase()}` : '';
    node.hidden = !file;
    node.dataset.checking = String(checking);
    node.disabled = busy || !controller.online() || checking;
    if (file) node.removeAttribute('aria-haspopup');
    else node.setAttribute('aria-haspopup', 'dialog');
    node.textContent = label;
    node.setAttribute('aria-label', `${label} — ${item.title}`);
    node.title = checking ? 'Checking file formats…' : file ? file.name : 'Choose a file from this release';
  }
  async function resolveFormats(signal, current) {
    const pending = items.filter(item => !item.files.length);
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
      while (pending.length && !signal.aborted) {
        const item = pending.shift();
        try {
          const files = await controller.getFiles(item, { signal });
          if (current !== generation) return;
          item.files = files;
          updateLoadLabel(item, loadButtons.get(item));
        } catch {
          if (current !== generation) return;
          const node = loadButtons.get(item);
          updateLoadLabel(item, node); node.title = 'File formats unavailable. Open release details to retry.';
        }
      }
    }));
  }
  async function load(item) {
    const file = singleLoadableFile(item);
    if (!file) return openDetailsDialog(controller, item, perform);
    cancelQuick(); const current = generation;
    request = new AbortController(); const { signal } = request;
    busy = true; updateButtons();
    const row = loadButtons.get(item).closest('.mb-quick-result');
    progress.start(file.name, { row, label: row.querySelector('.mb-meta') });
    try {
      const result = await perform(item, file, { action: 'run' }, signal, progress.update);
      if (current === generation) await progress.waitMinimum();
      if (current === generation) status.textContent = result.message;
    } catch (error) { if (current === generation) { await progress.waitMinimum(); if (current === generation) status.textContent = error.message; } }
    finally { if (current === generation) { busy = false; progress.finish(); updateButtons(); } }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    cancelQuick(); const current = generation;
    request = new AbortController(); const { signal } = request;
    const filters = { name: input.value, group: producer.value, category: type.querySelector('select').value, repo: quickSource };
    lastQuickSearch = filters; quickActions.hidden = true;
    busy = true; items = []; results.replaceChildren(); panel.hidden = false;
    results.setAttribute('aria-busy', 'true'); status.textContent = 'Searching…'; updateButtons();
    try {
      const found = await controller.quickSearch(filters, { signal });
      if (current !== generation) return;
      items = found; renderResults(); quickActions.hidden = false;
      status.textContent = items.length ? `${items.length === 10 ? 'Top 10' : items.length} ${items.length === 1 ? 'result' : 'results'}` : 'No results. Try fewer filters.';
      busy = false; results.setAttribute('aria-busy', 'false'); updateButtons();
      await resolveFormats(signal, current);
    } catch (error) { if (current === generation) { status.textContent = error.message; quickActions.hidden = false; } }
    finally { if (current === generation) { busy = false; results.setAttribute('aria-busy', 'false'); updateButtons(); } }
  });
  input.addEventListener('input', clearQuick);
  producer.addEventListener('input', clearQuick);
  const stopKeys = event => {
    if (event.key === 'Tab' || event.key === 'Shift' || event.target === input || event.target === producer) event.stopPropagation();
  };
  const releaseFocus = event => {
    if (event.target.closest('button') || (event.type === 'change' && event.target.matches('select'))) canvas.focus({ preventScroll: true });
  };
  root.addEventListener('keydown', stopKeys);
  root.addEventListener('click', releaseFocus, true);
  root.addEventListener('change', releaseFocus, true);
  const unsubscribe = controller.subscribe(() => {
    if (availableFields !== controller.fields) { availableFields = controller.fields; syncFilters(); }
    hint.hidden = controller.online(); hint.textContent = controller.online() ? '' : 'Offline · bookmarks available';
    updateButtons();
  });
  const network = () => {
    if (!controller.online()) { cancelQuick(); controller.cancel(); controller.emit({ status: 'offline', message: 'Offline — use LOAD LIB to open saved media.' }); }
    else controller.emit({ status: 'idle', message: 'Connection restored. Search is available.' });
  };
  window.addEventListener('online', network); window.addEventListener('offline', network);
  syncFilters();
  return {
    dispose() {
      cancelQuick(); browser?.close(); unsubscribe(); controller.dispose();
      window.removeEventListener('online', network); window.removeEventListener('offline', network);
      root.removeEventListener('keydown', stopKeys);
      root.removeEventListener('click', releaseFocus, true);
      root.removeEventListener('change', releaseFocus, true);
    },
  };
}
