// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/chat/connection.js — the chat's link to its server: one WebSocket, the
// session token kept per tab (so a reload lands back in the room within the
// server's grace period), requests answered by id, and reconnection with
// backoff. Nothing connects until connect() is called.

import { PROTOCOL } from '../../server/protocol.mjs';

/** The production chat server: the Railway service's own address (README, Chat server). */
export const CHAT_SERVER = 'wss://c64ready-chat-production.up.railway.app/chat';
const TOKEN_KEY = 'c64emu.chat.token';

/**
 * Where to connect: the production server, in development too, unless
 * localStorage names another (`c64emu.chat.server`), as the tests do to use
 * the dev server's own /chat.
 */
export function chatServerUrl() {
  try {
    const override = localStorage.getItem('c64emu.chat.server');
    if (override) return override;
  } catch { /* storage blocked */ }
  return CHAT_SERVER;
}

function sessionStore() {
  try { return window.sessionStorage; } catch { return null; }
}

/**
 * @param {object} o
 * @param {string} o.url
 * @param {(event: object) => void} o.onEvent      every pushed server event, and welcome
 * @param {(status: string) => void} o.onStatus    'connecting' | 'online' | 'offline' | 'replaced' | 'banned' | 'old'
 */
export function createChatConnection({ url, onEvent, onStatus }) {
  const store = sessionStore();
  let ws = null;
  let status = 'offline';
  let wanted = false;
  let retry = 0;
  let retryTimer = null;
  let nextId = 1;
  const pending = new Map();   // id → { resolve, reject, timer }

  const setStatus = (s) => { if (s !== status) { status = s; onStatus?.(s); } };
  const token = () => { try { return store?.getItem(TOKEN_KEY) || undefined; } catch { return undefined; } };
  const saveToken = (t) => { try { if (t) store?.setItem(TOKEN_KEY, t); else store?.removeItem(TOKEN_KEY); } catch { /* storage blocked */ } };

  function failPending(code) {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error(code), { code })); }
    pending.clear();
  }

  function open() {
    clearTimeout(retryTimer);
    if (!wanted || ws) return;
    setStatus('connecting');
    let sock;
    try { sock = new WebSocket(url); } catch { schedule(); return; }
    ws = sock;
    sock.addEventListener('open', () => sock.send(JSON.stringify({ t: 'hello', v: PROTOCOL, token: token() })));
    sock.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if ((msg.t === 'ok' || msg.t === 'err') && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.t === 'ok') p.resolve(msg);
        else p.reject(Object.assign(new Error(msg.code), { code: msg.code }));
        return;
      }
      if (msg.t === 'welcome') { saveToken(msg.token); retry = 0; setStatus('online'); }
      onEvent?.(msg);
    });
    sock.addEventListener('close', (e) => {
      if (ws !== sock) return;
      ws = null;
      failPending('OFFLINE');
      // Another tab (a duplicated one shares this tab's storage) took the session over.
      if (e.code === 4001) { saveToken(null); wanted = false; setStatus('replaced'); return; }
      if (e.code === 4003) { saveToken(null); wanted = false; setStatus('banned'); return; }
      if (e.code === 4000) { wanted = false; setStatus('old'); return; }
      schedule();
    });
  }

  function schedule() {
    ws = null;
    if (!wanted) { setStatus('offline'); return; }
    setStatus('offline');
    const delay = Math.min(30_000, 1000 * 2 ** retry++) * (0.75 + Math.random() * 0.5);
    retryTimer = setTimeout(open, globalThis.navigator?.onLine === false ? Math.max(delay, 5000) : delay);
  }

  const onOnline = () => { if (wanted && !ws) { retry = 0; open(); } };
  globalThis.addEventListener?.('online', onOnline);

  return {
    get status() { return status; },
    connect() { wanted = true; open(); },
    /** Drop the session for good: the next connect starts a new one. */
    forget() { saveToken(null); },
    hasSession: () => !!token(),
    close() {
      wanted = false;
      clearTimeout(retryTimer);
      const sock = ws;
      ws = null;
      failPending('OFFLINE');
      sock?.close(1000);
      setStatus('offline');
    },
    request(t, fields = {}, timeoutMs = 10_000) {
      if (!ws || status !== 'online') return Promise.reject(Object.assign(new Error('OFFLINE'), { code: 'OFFLINE' }));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ t, id, ...fields }));
      });
    },
  };
}
