// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/userport/plugins.js – user port device plugins: checking a device module,
// importing one from its source text, and hashing that source. Runs in the
// browser and in Node.

import { USERPORT_API_VERSION } from '../userport.js';

export const SUPPORTED_API_VERSIONS = [1, USERPORT_API_VERSION];
export const MAX_DEVICE_BYTES = 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;

// Throws an Error that says what is wrong, in words for the install dialog.
export function validateDeviceModule(mod, { allowBuiltin = false } = {}) {
  if (!mod || typeof mod !== 'object') throw new Error('The file is not a JavaScript module.');
  const meta = mod.meta;
  if (!meta || typeof meta !== 'object') throw new Error('The module has no "meta" export.');
  if (typeof mod.create !== 'function') throw new Error('The module has no "create" function export.');
  for (const key of ['id', 'name', 'version']) {
    if (typeof meta[key] !== 'string' || !meta[key].trim()) throw new Error(`meta.${key} is missing.`);
  }
  if (!ID.test(meta.id)) throw new Error('meta.id must be lowercase letters, digits, dots and dashes.');
  if (!allowBuiltin && meta.id.startsWith('builtin.')) throw new Error('Ids starting with "builtin." are reserved.');
  if (!SUPPORTED_API_VERSIONS.includes(meta.apiVersion)) {
    throw new Error(`meta.apiVersion ${meta.apiVersion} is not supported. This version of C64 READY. supports ${SUPPORTED_API_VERSIONS.join(', ')}.`);
  }
  return {
    id: meta.id,
    name: meta.name.trim(),
    version: meta.version.trim(),
    apiVersion: meta.apiVersion,
    author: typeof meta.author === 'string' ? meta.author.trim() : '',
    description: typeof meta.description === 'string' ? meta.description.trim() : '',
  };
}

// Import a device module from its source text. Each call gives a fresh module
// instance, so module-level state never carries over between plug-ins.
export async function importDeviceSource(source) {
  if (typeof source !== 'string') throw new Error('Device source must be text.');
  if (new TextEncoder().encode(source).length > MAX_DEVICE_BYTES) throw new Error('The file is larger than 1 MB.');
  if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL && typeof window !== 'undefined') {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      return await import(/* @vite-ignore */ url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const b64 = typeof Buffer !== 'undefined'
    ? Buffer.from(source, 'utf8').toString('base64')
    : btoa(unescape(encodeURIComponent(source)));
  return import(/* @vite-ignore */ `data:text/javascript;base64,${b64}`);
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Read a device file's source, import it and check it: what the install
// dialog shows before anything is stored.
export async function inspectDeviceSource(source) {
  const mod = await importDeviceSource(source);
  const meta = validateDeviceModule(mod);
  const hash = await sha256Hex(source);
  return { meta, hash, size: new TextEncoder().encode(source).length };
}
