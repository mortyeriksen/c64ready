// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

export function validSecondSidAddress(address) {
  return Number.isInteger(address) && !(address & 31) &&
    ((address >= 0xD420 && address <= 0xD7E0) || (address >= 0xDE00 && address <= 0xDFE0));
}
