// Device plugin checks (src/userport/plugins.js): what makes a file a valid
// user port device, per the device API (docs/USERPORT-DEVICES.md): a `meta`
// export with id, name, version and a supported apiVersion, and a `create`
// function. The "builtin." id prefix is reserved for the app's own devices.

import fs from 'node:fs';
import { validateDeviceModule, importDeviceSource, inspectDeviceSource, sha256Hex, MAX_DEVICE_BYTES } from '../../src/userport/plugins.js';

let testNo = 0, failing = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (!current.length) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    failing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of current) console.log(`     - ${m}`);
    current = [];
  }
}
const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

const good = { meta: { id: 'example.leds', name: 'LEDs', version: '1.0.0', apiVersion: 1 }, create() { return {}; } };
const withMeta = (patch) => ({ ...good, meta: { ...good.meta, ...patch } });

{
  const m = validateDeviceModule(good);
  expect(m.id === 'example.leds' && m.apiVersion === 1 && m.author === '', `valid module accepted: ${JSON.stringify(m)}`);
  ok('a module with meta and create is a device');
}

{
  expect(throwsWith(() => validateDeviceModule({ create() {} }), /meta/), 'missing meta refused');
  expect(throwsWith(() => validateDeviceModule({ meta: good.meta }), /create/), 'missing create refused');
  for (const k of ['id', 'name', 'version']) {
    expect(throwsWith(() => validateDeviceModule(withMeta({ [k]: '' })), new RegExp(`meta\\.${k}`)), `empty meta.${k} refused`);
  }
  expect(throwsWith(() => validateDeviceModule(withMeta({ id: 'Has Spaces' })), /lowercase/), 'an id with spaces refused');
  ok('missing meta, create, id, name or version is refused with a reason');
}

{
  expect(throwsWith(() => validateDeviceModule(withMeta({ apiVersion: 2 })), /not supported/), 'apiVersion 2 refused');
  expect(throwsWith(() => validateDeviceModule(withMeta({ apiVersion: undefined })), /not supported/), 'no apiVersion refused');
  ok('only supported API versions are accepted');
}

{
  expect(throwsWith(() => validateDeviceModule(withMeta({ id: 'builtin.mine' })), /reserved/), 'builtin.* refused for installs');
  expect(validateDeviceModule(withMeta({ id: 'builtin.mine' }), { allowBuiltin: true }).id === 'builtin.mine', 'allowed for the app\'s own');
  ok('the builtin. prefix is reserved');
}

{
  const src = `export const meta = { id: 'example.echo', name: 'Echo', version: '0.1.0', apiVersion: 1 };
export function create(port, host) { return { n: 1 }; }`;
  const a = await importDeviceSource(src);
  const b = await importDeviceSource(src);
  expect(typeof a.create === 'function' && a.create().n === 1, 'imported from source text');
  const info = await inspectDeviceSource(src);
  expect(info.meta.id === 'example.echo' && info.hash === await sha256Hex(src) && info.hash.length === 64, 'inspect gives meta and SHA-256');
  let refused = false;
  try { await importDeviceSource('x'.repeat(MAX_DEVICE_BYTES + 1)); } catch (e) { refused = /1 MB/.test(e.message); }
  expect(refused, 'over 1 MB refused');
  ok('a device is imported from its source text, hashed, and size-limited');
}

{
  const src = fs.readFileSync(new URL('../../src/userport/devices/wifi-modem.js', import.meta.url), 'utf8');
  const mod = await importDeviceSource(src);
  const meta = validateDeviceModule(mod, { allowBuiltin: true });
  expect(meta.id === 'builtin.wifi-modem', 'the built-in modem loads through the plugin path');
  ok('the built-in modem passes the same checks as an installed device');
}

console.log(failing ? `\n${failing} of ${testNo} FAILED` : `\nall ${testNo} passed`);
process.exit(failing ? 1 : 0);
