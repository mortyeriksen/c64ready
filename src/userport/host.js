// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/userport/host.js – the `host` object a user port device gets in the
// browser: its panel, a per-frame hook, a status line, settings storage and
// TCP connections through the relay. Everything here runs in wall-clock time,
// between emulated frames.
import { SPEAKER_ON_SVG, SPEAKER_MUTE_SVG } from '../ui/pixel-speaker.js';

const LOOPBACK_HOSTS = new Set(['echo', 'loopback']);
const CONNECT_TIMEOUT_MS = 15000;

export function relayUrl(base, host, port) {
  return `${base.replace(/\/+$/, '')}/${encodeURIComponent(host)}/${port}`;
}

// The relay to use when the user has not set one: the app's own, when the CLI
// (or the dev server) serves the app on this machine.
export function defaultRelayBase(loc = globalThis.location) {
  if (!loc) return '';
  const local = loc.hostname === 'localhost' || loc.hostname === '127.0.0.1' || loc.hostname === '[::1]';
  if (!local) return '';
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/relay`;
}

// A connection object as devices see it. Events fire asynchronously, so the
// device can set its handlers right after openSocket returns.
function makeSocket() {
  return { onopen: null, ondata: null, onclose: null, send() {}, close() {} };
}

function fire(fn, ...args) {
  if (typeof fn === 'function') fn(...args);
}

function openLoopback() {
  const s = makeSocket();
  let open = true;
  s.send = (bytes) => {
    if (!open) return;
    const copy = Uint8Array.from(bytes);
    setTimeout(() => { if (open) fire(s.ondata, copy); }, 0);
  };
  s.close = () => {
    if (!open) return;
    open = false;
    setTimeout(() => fire(s.onclose, 'closed'), 0);
  };
  setTimeout(() => fire(s.onopen), 0);
  return s;
}

function openRelay(base, host, port) {
  const s = makeSocket();
  if (!base) {
    setTimeout(() => fire(s.onclose, 'no relay'), 0);
    return s;
  }
  let ws;
  try {
    ws = new WebSocket(relayUrl(base, host, port), ['binary']);
  } catch {
    setTimeout(() => fire(s.onclose, 'bad relay address'), 0);
    return s;
  }
  ws.binaryType = 'arraybuffer';
  let opened = false, closed = false;
  // Bytes from the device are gathered and sent once per turn of the event
  // loop: the emulator runs whole frames, so this is one message per frame.
  let pending = [];
  const flush = () => {
    if (!pending.length || ws.readyState !== WebSocket.OPEN) return;
    let n = 0;
    for (const p of pending) n += p.length;
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of pending) { out.set(p, at); at += p.length; }
    pending = [];
    ws.send(out);
  };
  const timer = setTimeout(() => { if (!opened) ws.close(); }, CONNECT_TIMEOUT_MS);
  const finish = (why) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    fire(s.onclose, why);
  };
  ws.onopen = () => { opened = true; clearTimeout(timer); fire(s.onopen); flush(); };
  ws.onmessage = (e) => fire(s.ondata, new Uint8Array(e.data));
  ws.onerror = () => {};
  ws.onclose = () => finish(opened ? 'closed' : 'failed');
  s.send = (bytes) => {
    if (closed) return;
    const first = pending.length === 0;
    pending.push(Uint8Array.from(bytes));
    if (first) queueMicrotask(flush);
  };
  s.close = () => {
    if (closed) return;
    try { ws.close(); } catch { /* already closing */ }
    finish('closed');
  };
  return s;
}

/**
 * Build the host object for one plugged-in device.
 *   meta        the device's checked meta
 *   panelHost   element the device's ShadowRoot panel goes in (or null)
 *   setStatus   (text) => void, the card's status line
 *   relayBase   () => string, the relay currently configured
 * Returns { host, frame(), dispose() }.
 */
export function createBrowserHost({ meta, panelHost, setStatus, relayBase = defaultRelayBase, getAudio = () => null }) {
  const frameHooks = [];
  const sockets = new Set();
  let panel = null;
  if (panelHost) {
    panelHost.replaceChildren();
    const box = document.createElement('div');
    box.className = 'userport-device-panel';
    panelHost.append(box);
    panel = box.attachShadow({ mode: 'open' });
  }
  const keyFor = (key) => `c64emu.userport.dev.${meta.id}.${key}`;
  let relayAddress = '';
  try {
    const saved = localStorage.getItem(keyFor('relay'));
    relayAddress = saved == null ? localStorage.getItem('c64emu.userport.relay') || '' : JSON.parse(saved);
    if (typeof relayAddress !== 'string') relayAddress = '';
  } catch { /* storage blocked */ }
  const host = Object.freeze({
    panel,
    relay: Object.freeze({
      get: () => relayAddress,
      defaultBase: () => relayBase(),
      set(value) {
        const v = String(value).trim();
        if (v) {
          try { if (!/^wss?:$/.test(new URL(v).protocol)) return false; } catch { return false; }
        }
        relayAddress = v;
        try { localStorage.setItem(keyFor('relay'), JSON.stringify(v)); return true; } catch { return false; }
      },
    }),
    audio: () => getAudio(),
    icons: Object.freeze({ speakerOn: SPEAKER_ON_SVG, speakerMute: SPEAKER_MUTE_SVG }),
    css(text) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(String(text));
      return sheet;
    },
    onFrame(fn) {
      if (typeof fn === 'function') frameHooks.push(fn);
    },
    status(text) {
      setStatus(String(text ?? ''));
    },
    storage: Object.freeze({
      get(key) {
        try {
          const v = localStorage.getItem(keyFor(key));
          return v == null ? null : JSON.parse(v);
        } catch { return null; }
      },
      set(key, value) {
        try { localStorage.setItem(keyFor(key), JSON.stringify(value)); } catch { /* storage full or blocked */ }
      },
    }),
    openSocket(hostName, port) {
      const name = String(hostName).toLowerCase();
      const s = LOOPBACK_HOSTS.has(name) ? openLoopback() : openRelay(relayAddress || relayBase(), name, port | 0);
      sockets.add(s);
      const userClose = s.close;
      s.close = () => { sockets.delete(s); userClose(); };
      return s;
    },
    log(...args) {
      console.log(`[${meta.id}]`, ...args);
    },
  });
  return {
    host,
    frame() {
      for (const fn of frameHooks) fn();
    },
    dispose() {
      frameHooks.length = 0;
      for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
      sockets.clear();
      if (panelHost) panelHost.replaceChildren();
    },
  };
}
