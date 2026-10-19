// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { openMedia } from '../media.js';
import { Assembly64Controller } from './controller.js';
import { createAssembly64Control } from './control.js';
import { createAssembly64Actions } from './actions.js';
import { createAssembly64Store } from './store.js';
import { libList, libLoad } from '../media/library.js';
import { confirmDialog } from '../ui/dialogs.js';
import '../styles/styles-assembly64.css';

let _perform = null, _control = null, _controller = null;

/**
 * Load one Assembly64 file by its references, as the chat's LOAD does:
 * { item, cat, file }. The references come from whoever started the room, so
 * the release and its file list are fetched from Assembly64 itself, the file
 * must be one of that release's, and what is loaded is named by the catalog,
 * never by the room, before anything runs. Resolves null when declined.
 */
export async function openAssembly64File(a64) {
  if (!_perform || !_controller) throw new Error('Assembly64 is not available.');
  const details = await _controller.getDetails({ ref: { id: String(a64.item), categoryId: a64.cat }, title: '' });
  const file = details.files.find((f) => f.id === String(a64.file));
  if (!file) throw new Error('That file is not part of the release on Assembly64.');
  const ok = await confirmDialog(`Load "${details.title}" (${file.name}) from Assembly64?`, { title: 'Load from Assembly64', okLabel: 'LOAD' });
  return ok ? _perform(details, file, { action: 'run' }) : null;
}

/** Open the Assembly64 browser on a title search. */
export function searchAssembly64(name) {
  _control?.searchFor(name);
}

export async function initializeAssembly64() {
  const root = document.getElementById('media-browser-body');
  if (!root) return;
  const controller = _controller = new Assembly64Controller({ transport: (...args) => fetch(...args) });
  let storage;
  try { storage = localStorage; } catch { storage = { getItem: () => null, setItem: () => { throw new Error('Storage unavailable'); } }; }
  _perform = createAssembly64Actions(controller, openMedia, { list: libList, load: libLoad });
  _control = createAssembly64Control(root, controller, createAssembly64Store(storage), _perform);
  try { await controller.initialize(); }
  catch (error) { controller.emit({ status: 'error', message: error.message }); }
}
