// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { validateDeviceModule, sha256Hex, MAX_DEVICE_BYTES } from './plugins.js';

// Read metadata for the trust review without running any plugin code.
export async function inspectDeviceSource(source) {
  if (typeof source !== 'string') throw new Error('Device source must be text.');
  if (new TextEncoder().encode(source).length > MAX_DEVICE_BYTES) throw new Error('The file is larger than 1 MB.');
  const { readDeviceExports } = await import('./metadata.js');
  const exports = readDeviceExports(source);
  const meta = validateDeviceModule({ meta: exports.meta, create: exports.hasCreate ? () => {} : undefined });
  const hash = await sha256Hex(source);
  return { meta, hash, size: new TextEncoder().encode(source).length };
}
