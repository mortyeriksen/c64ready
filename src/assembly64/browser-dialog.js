// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { el, button, renderField, createDialog, closeAssembly64Dialogs } from './dom.js';
import { quickFilters, advancedFilters, sortOptions } from './filters.js';
import { directRunFile } from '../media/formats.js';
import { openAdvancedDialog } from './advanced-dialog.js';
import { openDetailsDialog } from './details-dialog.js';
import { createTypeIcon } from './icons.js';
import { createDownloadProgress } from './progress.js';

function nameDialog(title, initial, submit) {
  const dialog = createDialog(title);
  const form = el('form', null, { class: 'mb-name-form' });
  const field = renderField({ label: 'Name', type: 'text' }, initial, () => {});
  const status = el('p', '', { role: 'status' });
  form.append(field, button('SAVE', null, { type: 'submit', class: 'btn mb-primary' }), status);
  form.addEventListener('submit', event => {
    event.preventDefault();
    try { submit(field.querySelector('input').value); dialog.close(); }
    catch (error) { status.textContent = error.message; }
  });
  dialog.body.append(form); field.querySelector('input').focus();
}

export function openBrowserDialog(controller, store, perform, { view = 'results' } = {}) {
  let timer, unsubscribe = () => {}, mode = view, downloading = false;
  let availableFields = controller.fields;
  const progress = createDownloadProgress();
  const dialog = createDialog('Assembly64 Browser', () => { clearTimeout(timer); progress.finish(); controller.cancel(); unsubscribe(); });
  dialog.card.classList.add('mb-browser');
  const header = el('div', null, { class: 'mb-browser-heading' });
  header.append(
    el('span', 'The all-in-one tool for everything ever released for the Commodore 64.', { class: 'mb-tagline' }),
    el('a', 'Read more...', { href: 'https://assembly64.hackerswithstyle.se/assembly/index.html', target: '_blank', rel: 'noopener noreferrer' }),
  );
  const searchForm = el('form', null, { class: 'mb-searchbar' });
  const input = el('input', null, { type: 'search', placeholder: 'Search titles…', 'aria-label': 'Search title', maxlength: 200, autocomplete: 'off' });
  input.value = controller.state.filters.name || '';
  const search = button('SEARCH', null, { type: 'submit', class: 'btn mb-primary' });
  searchForm.append(el('span', '⌕', { class: 'mb-search-icon', 'aria-hidden': true }), input, search);
  const navigation = el('nav', null, { class: 'mb-navigation', 'aria-label': 'Assembly64 browser views' });
  const tabs = new Map();
  for (const [key, label] of [['results', 'Explore'], ['favorites', 'Favorites'], ['saved', 'Saved searches']]) {
    const tab = button(label, () => setView(key), { class: 'mb-tab', 'aria-pressed': key === mode });
    tabs.set(key, tab); navigation.append(tab);
  }
  const layout = el('div', null, { class: 'mb-browser-layout' });
  const sidebar = el('aside', null, { class: 'mb-sidebar', 'aria-label': 'Search filters' });
  const fields = el('div', null, { class: 'mb-filter-fields' });
  const filterHeading = el('div', null, { class: 'mb-sidebar-heading' });
  const reset = button('Reset', () => {
    clearTimeout(timer); mode = 'results'; controller.resetQuery(); sync(); controller.search();
  }, { class: 'mb-text-button' });
  filterHeading.append(el('h3', 'Refine search'), reset);
  const advanced = button('ADVANCED', () => { clearTimeout(timer); openAdvancedDialog(controller, () => { mode = 'results'; sync(); }); }, { class: 'btn mb-advanced' });
  const sidebarNote = el('div', null, { class: 'mb-sidebar-note' });
  sidebarNote.append(el('span', 'READY TO LOAD', { class: 'mb-eyebrow' }), el('p', 'PRG · D64 · CRT · TAP · T64 · SID · REU'), el('p', 'Open media in your emulator, or save a copy to Library for later.'));
  sidebar.append(filterHeading, fields, advanced, sidebarNote);
  const main = el('section', null, { class: 'mb-browser-main', 'aria-label': 'Catalog' });
  const resultHeader = el('div', null, { class: 'mb-result-header' });
  const count = el('h3', 'Explore the catalog', { 'aria-live': 'polite', 'aria-atomic': true });
  const save = button('＋ Save search', () => nameDialog('Save search', '', name => {
    store.saveSearch(name, controller.state.filters, controller.state.sort); status.textContent = 'Search saved.';
  }), { class: 'mb-text-button' });
  resultHeader.append(count, save);
  const chips = el('div', null, { class: 'mb-active-filters', 'aria-label': 'Active filters' });
  const status = el('p', '', { class: 'mb-status', role: 'status', 'aria-live': 'polite' });
  const results = el('div', null, { class: 'mb-results', 'aria-label': 'Search results' });
  const more = button('LOAD MORE ↓', () => controller.search(true), { class: 'btn mb-more' });
  main.append(resultHeader, chips, status, results, more); layout.append(sidebar, main);
  const footer = el('div', null, { class: 'mb-browser-footer' });
  footer.append(el('span', 'Save files to Library to open them offline.'), el('span', 'ESC to close', { class: 'mb-escape-hint' }));
  dialog.body.append(header, searchForm, navigation, layout, progress.root, footer);

  function setView(next) {
    clearTimeout(timer); mode = next;
    if (mode !== 'results') { controller.cancel(); render(controller.state); }
    else if (controller.state.status === 'idle' && !controller.state.items.length && controller.online()) controller.search();
    else render(controller.state);
  }
  function updateFilter(key, value) {
    if (controller.state.filters[key] === value && (controller.state.filters.name || '') === input.value) return;
    clearTimeout(timer); mode = 'results';
    controller.setQuery({ ...controller.state.filters, name: input.value, [key]: value });
    timer = setTimeout(() => controller.search(), 300);
  }
  function sync() {
    input.value = controller.state.filters.name || '';
    fields.replaceChildren();
    for (const field of quickFilters(controller.fields)) {
      const node = renderField(field, controller.state.filters[field.key], value => updateFilter(field.key, value));
      if (field.key === 'group') {
        node.classList.add('mb-producer-field');
        node.querySelector('input').addEventListener('keydown', event => {
          if (event.key === 'Enter') { event.preventDefault(); searchForm.requestSubmit(); }
        });
      }
      fields.append(node);
    }
    fields.append(renderField({ label: 'Sort by', type: 'select', allowEmpty: false, options: sortOptions(controller.fields, controller.state.sort.id) }, controller.state.sort.id, value => {
      clearTimeout(timer); mode = 'results';
      const filters = { ...controller.state.filters, name: input.value };
      controller.setQuery(filters, { id: value, direction: null }); timer = setTimeout(() => controller.search(), 300);
    }));
  }
  searchForm.addEventListener('submit', event => {
    event.preventDefault();
    if (controller.state.status === 'loading') return;
    clearTimeout(timer); mode = 'results';
    controller.setQuery({ ...controller.state.filters, name: input.value }); controller.search();
  });
  input.addEventListener('input', () => {
    clearTimeout(timer); mode = 'results';
    controller.setQuery({ ...controller.state.filters, name: input.value });
  });
  function render(state) {
    if (availableFields !== controller.fields) { availableFields = controller.fields; sync(); }
    for (const [key, tab] of tabs) tab.setAttribute('aria-pressed', String(key === mode));
    sidebar.hidden = mode !== 'results';
    layout.classList.toggle('mb-without-sidebar', mode !== 'results');
    save.hidden = mode !== 'results';
    chips.hidden = mode !== 'results';
    search.disabled = state.status === 'loading' || !controller.online();
    results.setAttribute('aria-busy', String(state.status === 'loading'));
    more.hidden = mode !== 'results' || !state.hasMore;
    more.disabled = state.status === 'loading' || !controller.online();
    count.classList.toggle('mb-loading', state.status === 'loading' && mode === 'results');
    const quickKeys = ['name', 'group', 'category', 'repo'];
    const active = Object.entries(state.filters).filter(([, value]) => value !== '' && value != null);
    const advancedCount = active.filter(([key]) => !quickKeys.includes(key)).length;
    advanced.textContent = advancedCount ? `ADVANCED · ${advancedCount}` : 'ADVANCED';
    chips.replaceChildren();
    for (const [key, value] of active) {
      const field = advancedFilters(controller.fields).find(f => f.key === key);
      const label = field?.label || key;
      const display = entry => field?.options?.find(option => option.value === entry)?.label || entry;
      const valueLabel = Array.isArray(value) ? value.map(display).join(', ') : display(value);
      chips.append(button(`${label}: ${valueLabel} ×`, () => {
        clearTimeout(timer);
        const filters = { ...controller.state.filters }; delete filters[key];
        controller.setQuery(filters); sync(); controller.search();
      }, { class: 'mb-filter-chip', 'aria-label': `Remove ${label} filter` }));
    }
    results.replaceChildren();
    if (mode === 'saved') {
      const searches = store.searches(); count.textContent = `${searches.length} saved ${searches.length === 1 ? 'search' : 'searches'}`; status.textContent = '';
      for (const item of searches) {
        const row = el('div', null, { class: 'mb-saved-row' });
        const summary = el('div');
        summary.append(button(item.name, () => {
          clearTimeout(timer); mode = 'results'; controller.setQuery(item.query.filters, item.query.sort); sync(); controller.search();
        }, { class: 'mb-title' }), el('p', `${Object.values(item.query.filters).filter(Boolean).length} filters · ${sortOptions(controller.fields).find(option => option.value === item.query.sort.id)?.label || item.query.sort.id}`, { class: 'mb-meta' }));
        row.append(el('span', '⌕', { class: 'mb-format-icon', 'aria-hidden': true }), summary,
          button('Rename', () => nameDialog('Rename search', item.name, name => { store.renameSearch(item.id, name); render(controller.state); }), { class: 'mb-text-button' }),
          button('Delete', () => { try { store.deleteSearch(item.id); render(controller.state); } catch (error) { status.textContent = error.message; } }, { class: 'mb-text-button' }));
        results.append(row);
      }
      if (!searches.length) empty('No saved searches yet', 'Choose your filters in Explore, then select Save search.', '⌕');
      return;
    }
    const items = mode === 'favorites' ? store.favorites() : state.items;
    count.textContent = mode === 'favorites' ? `${items.length} ${items.length === 1 ? 'favorite' : 'favorites'}` : state.status === 'loading' ? 'Searching the catalog' : state.status === 'idle' ? 'Explore the catalog' : `${items.length} ${items.length === 1 ? 'release' : 'releases'}${state.hasMore ? ' loaded' : ''}`;
    status.textContent = mode === 'favorites' ? '' : state.status === 'ready' || state.status === 'loading' ? '' : state.message;
    for (const item of items) {
      const row = el('article', null, { class: 'mb-result' });
      const viewDetails = () => openDetailsDialog(controller, item, perform);
      const formats = [...new Set((item.files || []).map(f => f.mediaType.toUpperCase()))];
      const icon = createTypeIcon(item.kind);
      const title = button(item.title, viewDetails, { class: 'mb-title' });
      if (item.producer) title.append(el('span', ` — ${item.producer}`, { class: 'mb-producer' }));
      const summary = el('div', null, { class: 'mb-result-summary' });
      summary.append(title, el('p', [item.kind, item.source, item.year || item.date].filter(Boolean).join(' · '), { class: 'mb-meta' }));
      const tags = el('div', null, { class: 'mb-format-tags' });
      if (formats.length > 1) for (const format of formats) tags.append(el('span', format));
      summary.append(tags);
      const rating = el('span', item.rating == null ? '—' : `★ ${item.rating}`, { class: 'mb-rating', 'aria-label': item.rating == null ? 'No rating' : `Rating ${item.rating}` });
      const star = button(store.isFavorite(item) ? '★' : '☆', () => {
        try {
          store.toggleFavorite(item);
          if (mode === 'favorites') render(controller.state);
          else { star.textContent = store.isFavorite(item) ? '★' : '☆'; star.setAttribute('aria-pressed', String(store.isFavorite(item))); }
        } catch (error) { status.textContent = error.message; }
      }, { class: 'mb-star', 'aria-label': `Favorite ${item.title}`, 'aria-pressed': store.isFavorite(item) });
      const actions = el('div', null, { class: 'mb-row-actions' });
      actions.append(button('VIEW', viewDetails, { class: 'btn mb-view' }));
      const file = directRunFile(item);
      if (file) {
        const run = button('LOAD', async () => {
          if (downloading) return;
          downloading = true; setBusy(true); status.textContent = ''; progress.start(file.name);
          try {
            const result = await perform(item, file, { action: 'run' }, dialog.signal, progress.update);
            if (!dialog.closed) {
              if (result.mediaType) closeAssembly64Dialogs();
              else status.textContent = result.message;
            }
          } catch (error) { if (!dialog.closed) status.textContent = error.message; }
          finally { progress.finish(); downloading = false; setBusy(false); }
        }, { class: 'btn mb-run', 'data-mb-download': '' });
        run.disabled = downloading || !controller.online(); actions.append(run);
      }
      row.append(icon, summary, rating, star, actions);
      row.addEventListener('click', event => { if (!event.target.closest('button, a')) viewDetails(); });
      results.append(row);
    }
    if (!items.length && state.status !== 'loading') {
      if (mode === 'favorites') empty('No favorites yet', 'Star a release in Explore to bookmark it here.', '☆');
      else if (state.status === 'error' || state.status === 'offline') empty(controller.online() ? 'Search unavailable' : 'You’re offline', '', '⌁');
      else if (state.status === 'ready') empty('No releases found', 'Try another title or use fewer filters.', '⌕');
      else empty('Search the catalog', 'Enter a title or select SEARCH to browse everything.', '⌕');
    }
  }
  function setBusy(busy) {
    for (const node of results.querySelectorAll('[data-mb-download]')) node.disabled = busy || !controller.online();
  }
  function empty(title, text, symbol) {
    const panel = el('div', null, { class: 'mb-empty' });
    panel.append(el('span', symbol, { class: 'mb-empty-symbol', 'aria-hidden': true }), el('h4', title));
    if (text) panel.append(el('p', text));
    results.append(panel);
  }
  if (mode !== 'results') controller.cancel();
  unsubscribe = controller.subscribe(render); sync();
  dialog.sync = sync;
  if (!window.matchMedia?.('(pointer: coarse)').matches) input.focus();
  return dialog;
}
