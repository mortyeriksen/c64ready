// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/userport.mjs — user port devices in the CLI. Loads a device file, checks
// it like the browser does, and plugs it into a headless machine with a Node
// `host`: no panel, settings kept in memory, sockets straight to TCP (no relay).

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateDeviceModule } from '../src/userport/plugins.js';

// Literal imports, so tools/build-cli.mjs packs the built-in devices.
const loadModem = () => import('../src/userport/devices/modem.js');
const BUILTINS = { modem: loadModem, 'wifi-modem': loadModem };
const LOOPBACK = new Set(['echo', 'loopback']);

export const BUILTIN_DEVICE_NAMES = Object.keys(BUILTINS);

// `spec` is a device file path or the name of a built-in device (`modem`).
export async function loadDevice(spec) {
  if (Object.hasOwn(BUILTINS, spec)) {
    const mod = await BUILTINS[spec]();
    return { file: null, mod, meta: validateDeviceModule(mod, { allowBuiltin: true }) };
  }
  const file = path.resolve(spec);
  if (!fs.existsSync(file)) throw new Error(`no device file at ${spec} (built-in devices: ${BUILTIN_DEVICE_NAMES.join(', ')})`);
  // A query per modification time, so a changed file is imported afresh.
  const mod = await import(`${pathToFileURL(file).href}?t=${fs.statSync(file).mtimeMs}`);
  return { file, mod, meta: validateDeviceModule(mod) };
}

function nodeSocket(hostName, port) {
  const s = { onopen: null, ondata: null, onclose: null, send() {}, close() {} };
  const fire = (fn, ...a) => { if (typeof fn === 'function') fn(...a); };
  if (LOOPBACK.has(hostName)) {
    let open = true;
    s.send = (b) => { if (open) { const c = Uint8Array.from(b); setImmediate(() => open && fire(s.ondata, c)); } };
    s.close = () => { if (open) { open = false; setImmediate(() => fire(s.onclose, 'closed')); } };
    setImmediate(() => fire(s.onopen));
    return s;
  }
  const tcp = net.connect(port, hostName);
  let opened = false, closed = false;
  const finish = (why) => { if (!closed) { closed = true; fire(s.onclose, why); } };
  tcp.setTimeout(15000, () => { if (!opened) tcp.destroy(); });
  tcp.on('connect', () => { opened = true; tcp.setTimeout(0); fire(s.onopen); });
  tcp.on('data', (d) => fire(s.ondata, new Uint8Array(d)));
  tcp.on('error', () => {});
  tcp.on('close', () => finish(opened ? 'closed' : 'failed'));
  s.send = (b) => { if (!closed) tcp.write(Buffer.from(b)); };
  s.close = () => { tcp.destroy(); finish('closed'); };
  return s;
}

export function createNodeHost(meta, { onStatus = () => {} } = {}) {
  const frameHooks = [];
  const store = new Map();
  const sockets = new Set();
  const host = Object.freeze({
    panel: null,
    audio: () => null,
    css: () => null,
    onFrame(fn) { if (typeof fn === 'function') frameHooks.push(fn); },
    status(text) { onStatus(String(text ?? '')); },
    storage: Object.freeze({
      get: (k) => (store.has(k) ? JSON.parse(store.get(k)) : null),
      set: (k, v) => { store.set(k, JSON.stringify(v)); },
    }),
    openSocket(hostName, port) {
      const s = nodeSocket(String(hostName).toLowerCase(), port | 0);
      sockets.add(s);
      const close = s.close;
      s.close = () => { sockets.delete(s); close(); };
      return s;
    },
    log: (...a) => console.error(`[${meta.id}]`, ...a),
  });
  return {
    host,
    frame() { for (const fn of frameHooks) fn(); },
    dispose() { for (const s of sockets) s.close(); sockets.clear(); frameHooks.length = 0; },
  };
}

/**
 * Plug a device file into a C64Machine. Returns { meta, device, frame(),
 * dispose(), error() } where error() is the exception that unplugged the
 * device, if any.
 */
export async function plugDevice(machine, spec, opts = {}) {
  const { mod, meta } = await loadDevice(spec);
  const ctl = createNodeHost(meta, opts);
  let failure = null;
  const device = machine.attachUserport(meta.id, (port) => mod.create(port, ctl.host), meta.version);
  machine.userport.onError = (id, err) => { failure = err; ctl.dispose(); };
  return {
    meta,
    device,
    frame: () => { if (!failure) ctl.frame(); },
    dispose: () => { machine.detachUserport(); ctl.dispose(); },
    error: () => failure,
  };
}
