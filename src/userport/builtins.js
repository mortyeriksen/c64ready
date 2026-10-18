// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/userport/builtins.js – the devices that ship with the app. They are
// plugins like any other, loaded from their source text through the same path
// as an installed device, so the built-ins exercise the public API.

import wifiModemSource from './devices/wifi-modem.js?raw';

export const BUILTIN_DEVICES = [
  { id: 'builtin.wifi-modem', file: 'wifi-modem.js', source: wifiModemSource },
];
