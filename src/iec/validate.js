// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { validIecAddress } from '../iec.js';

export function validateIecModule(mod) {
  const m = mod?.meta;
  if (!m || m.bus !== 'iec' || m.apiVersion !== 1 || typeof mod.create !== 'function') {
    throw new Error('An IEC device exports meta with bus: "iec", apiVersion: 1, and a create function.');
  }
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(m.id) || m.id.startsWith('builtin.')) throw new Error('IEC device id must use lowercase letters, digits, dots and dashes, without builtin.');
  if (typeof m.name !== 'string' || !m.name.trim() || typeof m.version !== 'string' || !m.version.trim()) throw new Error('The device needs a name and version.');
  if (m.address != null && !validIecAddress(m.address)) throw new Error('Default IEC address must be 4 to 30, excluding drives 8 and 9.');
  return { id: m.id, name: m.name.trim(), version: m.version.trim(), bus: 'iec', apiVersion: 1,
    address: m.address ?? 4, author: typeof m.author === 'string' ? m.author : '', description: typeof m.description === 'string' ? m.description : '' };
}
