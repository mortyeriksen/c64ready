// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateDeviceModule } from '../src/userport/plugins.js';
import { validateIecModule } from '../src/iec/validate.js';

// Explicit CLI file arguments are trusted code, imported with their local dependencies.
export async function loadDeviceFile(spec, { bus = null } = {}) {
  const file = path.resolve(spec);
  if (!fs.existsSync(file)) throw new Error(`no device file at ${spec}`);
  const mod = await import(`${pathToFileURL(file).href}?t=${fs.statSync(file).mtimeMs}`);
  const connector = mod.meta?.bus === 'iec' ? 'iec' : 'userport';
  if (bus && connector !== bus) throw new Error(`Expected ${bus === 'iec' ? 'an IEC' : 'a User Port'} device, got ${connector}: ${spec}`);
  const meta = connector === 'iec' ? validateIecModule(mod) : validateDeviceModule(mod);
  return { file, mod, meta, bus: connector };
}
