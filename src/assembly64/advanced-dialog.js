// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { advancedFilters, sortOptions, sortDirections } from './filters.js';
import { defaultQuery } from './query.js';
import { el, button, createDialog, renderField } from './dom.js';

export function openAdvancedDialog(controller, sync) {
  const dialog = createDialog('Advanced search');
  let draft = structuredClone({ filters: controller.state.filters, sort: controller.state.sort });
  const form = el('form', null, { class: 'mb-grid' });
  const status = el('p', '', { role: 'status' });
  function render() {
    form.replaceChildren();
    for (const field of advancedFilters(controller.fields)) form.append(renderField(field, draft.filters[field.key], value => { draft.filters[field.key] = value; }));
    form.append(renderField({ label: 'Sort field', type: 'select', allowEmpty: false, options: sortOptions(controller.fields, draft.sort.id) }, draft.sort.id, value => { draft.sort.id = value; }));
    if (sortDirections(controller.fields).length) form.append(renderField({ label: 'Sort direction', type: 'select', emptyLabel: 'Default', options: sortDirections(controller.fields) }, draft.sort.direction, value => { draft.sort.direction = value || null; }));
    form.append(button('RESET', () => { controller.resetQuery(); draft = structuredClone(defaultQuery()); sync(); render(); }));
    form.append(button('SHOW RESULTS', null, { type: 'submit', class: 'btn mb-primary' }));
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    controller.setQuery(draft.filters, draft.sort); sync(); dialog.close(); controller.search();
  });
  render();
  dialog.body.append(el('p', 'Combine filters to narrow your search. Leave a field empty to include all values.', { class: 'mb-meta' }), form, status);
  form.querySelector('input')?.focus();
  return dialog;
}
