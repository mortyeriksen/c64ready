// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import fs from 'node:fs';
import { assetPath } from '../test/external-assets.js';

// Use the ROM setup cache without serving copyrighted ROMs as public assets.
export async function createGuideContext(browser, options, { roms = true } = {}) {
  const context = await browser.newContext(options);
  const cache = {};
  for (const [slot, asset] of Object.entries({ kernal: 'kernal', basic: 'basic', charRom: 'chargen', drive1541: 'drive1541' })) {
    const file = roms && assetPath(asset);
    if (file) cache[`c64emu.rom.${slot}`] = fs.readFileSync(file).toString('base64');
  }
  await context.addInitScript(roms => {
    for (const [key, value] of Object.entries(roms)) localStorage.setItem(key, value);
    localStorage.setItem('c64emu.equipmentHintShown', '1');
    localStorage.setItem('c64emu.themePickerShown', '1');
    localStorage.setItem('c64emu.theme', 'phosphor');
    localStorage.setItem('c64emu.appearance', 'dark');
  }, cache);
  return context;
}
