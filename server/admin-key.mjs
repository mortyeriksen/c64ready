// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/admin-key.mjs — `npm run admin-key`: a one-time setup key for the
// admin console's first passkey (or one more, after the others are lost),
// made here on the admin's computer. Only its hash goes on the server, as
// CHAT_ADMIN_SETUP_KEY_SHA256, so the key itself is in no server's log.

import { newSetupKey, setupKeyHash } from './admin.mjs';

const key = newSetupKey();
console.log(`Admin setup key:   ${key}`);
console.log('Enter it at /admin on the device to sign in with, under "Set up this device".');
console.log('');
console.log('Set this on the server, then restart it:');
console.log(`CHAT_ADMIN_SETUP_KEY_SHA256=${setupKeyHash(key)}`);
