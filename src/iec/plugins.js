// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { importDeviceSource, sha256Hex, MAX_DEVICE_BYTES } from '../userport/plugins.js';
import { validateIecModule } from './validate.js';
export { validateIecModule } from './validate.js';
export { importDeviceSource, sha256Hex };


export async function inspectIecSource(source) {
  if (typeof source !== 'string') throw new Error('Device source must be text.');
  if (new TextEncoder().encode(source).length > MAX_DEVICE_BYTES) throw new Error('The file is larger than 1 MB.');
  const { readDeviceExports } = await import('../userport/metadata.js');
  const exports = readDeviceExports(source);
  const meta = validateIecModule({ meta: exports.meta, create: exports.hasCreate ? () => {} : undefined });
  return { meta, hash: await sha256Hex(source), size: new TextEncoder().encode(source).length };
}

export async function loadIecSource(source) {
  const mod = await importDeviceSource(source);
  return { mod, meta: validateIecModule(mod) };
}
