// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { ActionReplayCartridge } from './action-replay.js';
import { EasyFlashCartridge } from './easyflash.js';
import { FinalCartridge3 } from './final3.js';
import { GenericCartridge } from './generic.js';
import { MagicDeskCartridge } from './magicdesk.js';

const CRT_FACTORIES = new Map([
  [0, cart => GenericCartridge.fromCRT(cart)],
  [1, cart => ActionReplayCartridge.fromCRT(cart)],
  [3, cart => FinalCartridge3.fromCRT(cart)],
  [19, cart => MagicDeskCartridge.fromCRT(cart)],
  [32, cart => EasyFlashCartridge.fromCRT(cart)],
]);

export function createCartridgeFromCRT(cart) {
  const factory = CRT_FACTORIES.get(cart.hwType);
  if (!factory) {
    throw new Error(
      `Unsupported cartridge type ${cart.hwType} ("${cart.name}"). ` +
      'Supported: type 0 (generic 8K/16K/Ultimax), type 1 (Action Replay), ' +
      'type 3 (Final Cartridge III), type 19 (Magic Desk), type 32 (EasyFlash).'
    );
  }
  return factory(cart);
}

export function createCartridgeFromConfig(cfg) {
  if (!cfg || (!cfg.type && (!cfg.mode || cfg.mode === 'none'))) return null;
  if (!cfg.type && cfg.mode) return new GenericCartridge(cfg);
  switch (cfg.type) {
    case 'generic': return new GenericCartridge(cfg);
    case 'action-replay': return new ActionReplayCartridge(cfg.romBanks);
    case 'final3': return new FinalCartridge3(cfg.romLoBanks, cfg.romHiBanks);
    case 'magicdesk': return new MagicDeskCartridge(cfg.romLoBanks);
    case 'easyflash': return new EasyFlashCartridge(cfg.romLoBanks, cfg.romHiBanks);
    default:
      throw new Error(`Unknown cartridge configuration "${cfg.type}"`);
  }
}
