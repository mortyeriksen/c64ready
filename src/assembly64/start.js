// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { openMedia } from '../media.js';
import { Assembly64Controller } from './controller.js';
import { createAssembly64Control } from './control.js';
import { createAssembly64Actions } from './actions.js';
import { createAssembly64Store } from './store.js';
import '../styles-assembly64.css';

export async function initializeAssembly64() {
  const root = document.getElementById('media-browser-body');
  if (!root) return;
  const controller = new Assembly64Controller({ transport: (...args) => fetch(...args) });
  let storage;
  try { storage = localStorage; } catch { storage = { getItem: () => null, setItem: () => { throw new Error('Storage unavailable'); } }; }
  createAssembly64Control(root, controller, createAssembly64Store(storage), createAssembly64Actions(controller, openMedia));
  try { await controller.initialize(); }
  catch (error) { controller.emit({ status: 'error', message: error.message }); }
}
