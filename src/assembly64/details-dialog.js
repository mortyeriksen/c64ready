// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { allowedActions, safeExternalUrl } from '../media/formats.js';
import { el, button, createDialog, renderField, closeAssembly64Dialogs } from './dom.js';
import { createDownloadProgress } from './progress.js';
import { libList } from '../media/library.js';
import { savedLibraryFiles } from './library.js';

export async function openDetailsDialog(controller, reference, perform, details = null) {
  const progress = createDownloadProgress({ card: true });
  const dialog = createDialog(reference.title || 'Release details', () => progress.finish());
  dialog.card.classList.add('mb-details');
  const status = el('p', 'Loading release details…', { class: 'mb-detail-status', role: 'status', 'aria-live': 'polite' });
  dialog.body.append(status);
  if (!controller.online()) {
    status.textContent = 'Offline — release details and new downloads are unavailable. Open saved files with LOAD LIB.';
    return dialog;
  }
  try {
    const item = details || await controller.getDetails(reference, { signal: dialog.signal });
    if (dialog.closed) return dialog;
    dialog.body.replaceChildren();
    dialog.setTitle(item.title || reference.title || 'Release details');
    if (item.description) dialog.body.append(el('p', item.description, { class: 'mb-description' }));
    const facts = el('dl', null, { class: 'mb-facts' });
    const values = new Map([['Type', item.kind], ['Source', item.source], ['Date', item.date || item.year], ['Rating', item.rating], ...(item.facts || []).map(fact => [fact.label, fact.value])]);
    for (const [label, value] of values) if (value != null && value !== '') facts.append(el('dt', label), el('dd', value));
    if (facts.children.length) dialog.body.append(facts);
    const originalUrl = safeExternalUrl(item.originalUrl);
    if (originalUrl) dialog.body.append(el('a', 'Original release page ↗', { href: originalUrl, target: '_blank', rel: 'noopener noreferrer' }));
    const options = { targetDrive: 8, writeProtected: true, autorun: undefined, saveToLibrary: true };
    const hasDisk = item.files.some(file => ['d64', 'zip'].includes(file.mediaType));
    const hasOpenable = item.files.some(file => allowedActions(file.mediaType).some(action => ['run', 'extract'].includes(action)));
    const settings = el('fieldset', null, { class: 'mb-grid' });
    settings.append(el('legend', 'Open media'));
    if (hasDisk) settings.append(renderField({ key: 'drive', label: 'D64 target drive', type: 'select', allowEmpty: false, options: [{ value: '8', label: 'Drive 8 (default)' }, { value: '9', label: 'Drive 9' }] }, '8', value => { options.targetDrive = Number(value); }));
    if (item.files.some(file => ['prg', 'd64', 'tap', 'zip'].includes(file.mediaType))) settings.append(renderField({ label: 'Autorun', type: 'select', allowEmpty: false, options: [{ value: 'default', label: 'Follow app setting' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off / mount only' }] }, 'default', value => { options.autorun = value === 'default' ? undefined : value === 'on'; }));
    settings.append(renderField({ label: 'Save selected file to Library', type: 'checkbox' }, true, value => { options.saveToLibrary = value; }));
    if (hasOpenable) dialog.body.append(settings);
    dialog.body.append(el('h3', `Files (${item.files.length})`, { class: 'mb-files-heading' }));
    status.textContent = '';
    const files = el('div', null, { class: 'mb-files' });
    const actionButtons = [];
    let savedFiles = new Set(), busy = false, checkingLibrary = true;
    function updateActions() {
      for (const { button, action, file } of actionButtons) {
        const saved = action === 'save' && savedFiles.has(file.id);
        if (action === 'save') button.textContent = saved ? 'SAVED IN LIB' : 'SAVE TO LIB';
        button.disabled = busy || !controller.online() || saved || (action === 'save' && checkingLibrary);
      }
      for (const node of settings.querySelectorAll('input, select')) node.disabled = busy || !controller.online();
    }
    async function refreshLibrary() {
      checkingLibrary = true; updateActions();
      try {
        const entries = await libList();
        if (!dialog.closed) savedFiles = savedLibraryFiles(item, entries);
      } catch { /* Library failures leave saving available for retry. */ }
      finally { checkingLibrary = false; if (!dialog.closed) updateActions(); }
    }
    if (!item.files.length) files.append(el('p', 'No downloadable files are available.'));
    for (const file of item.files) {
      const row = el('div', null, { class: 'mb-file' });
      const info = el('div', null, { class: 'mb-file-info' });
      info.append(el('strong', file.name), el('span', `${file.mediaType.toUpperCase()} · ${file.size == null ? 'Size unknown' : `${file.size.toLocaleString()} B`}`, { class: 'mb-meta' }));
      const buttons = el('div', null, { class: 'mb-file-actions' });
      row.append(info, buttons);
      const actions = allowedActions(file.mediaType);
      if (!actions.includes('run') && !actions.includes('extract')) info.append(el('p', 'Download only · this format cannot be opened.'));
      for (const action of actions) {
        const label = { run: 'LOAD', mount: 'MOUNT ONLY', save: 'SAVE TO LIB', download: 'DOWNLOAD', extract: 'CHOOSE FROM ZIP' }[action];
        const btn = button(label, async () => {
          busy = true; updateActions();
          status.textContent = '';
          progress.start(file.name, { row, label: info.querySelector('.mb-meta') });
          try {
            const result = await perform(item, file, { ...options, action: action === 'extract' ? 'run' : action }, dialog.signal, progress.update);
            await progress.waitMinimum();
            if (!dialog.closed) {
              if (['run', 'extract'].includes(action) && result.mediaType) closeAssembly64Dialogs();
              else { status.textContent = result.message; dialog.card.focus({ preventScroll: true }); }
            }
          } catch (error) { await progress.waitMinimum(); if (!dialog.closed) status.textContent = error.message; }
          finally {
            progress.finish();
            if (!dialog.closed) await refreshLibrary();
            busy = false;
            if (!dialog.closed) updateActions();
          }
        });
        actionButtons.push({ button: btn, action, file }); buttons.append(btn);
      }
      files.append(row);
    }
    dialog.body.append(files, status);
    void refreshLibrary();
  } catch (error) { if (!dialog.closed) status.textContent = error.message; }
  return dialog;
}
