// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/ws.mjs — the server side of a WebSocket (RFC 6455) for JSON text
// messages, with no dependencies. Fragmented messages are joined, pings are
// answered, and a peer that sends binary, unmasked, malformed or oversized
// frames, splits a message into too many fragments or takes too long over
// one, or lets too much unsent data pile up, is dropped.

import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// A fragmented message may have at most this many pieces, empty ones included,
// and must be complete within this long.
const MAX_FRAGMENTS = 16;
const FRAGMENT_MS = 5000;

function frame(payload, opcode) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/** Refuse an upgrade request with a plain HTTP status. */
export function refuseUpgrade(sock, status, text) {
  sock.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Complete the handshake on an upgrade request. Returns the connection, or null
 * (after answering 400) when the request is not a valid WebSocket upgrade.
 * The connection calls onmessage(text) and onclose() once each is set.
 */
export function acceptWebSocket(req, sock, head, { maxPayload = 8192, maxBuffered = 1 << 20 } = {}) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13') {
    refuseUpgrade(sock, 400, 'Bad Request');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);
  return new WsConn(sock, head, maxPayload, maxBuffered);
}

const decoder = new TextDecoder('utf-8', { fatal: true });

class WsConn {
  constructor(sock, head, maxPayload, maxBuffered) {
    this.sock = sock;
    this.maxPayload = maxPayload;
    this.maxBuffered = maxBuffered;
    this.closed = false;
    this.alive = true;
    this.onmessage = null;
    this.onclose = null;
    this._buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this._parts = null;
    this._partsBytes = 0;
    this._partsAt = 0;
    sock.on('data', (d) => this._data(d));
    sock.on('close', () => this._gone());
    sock.on('error', () => this._gone());
    if (this._buf.length) queueMicrotask(() => this._data(Buffer.alloc(0)));
  }

  send(text) {
    if (this.closed) return;
    if (this.sock.writableLength > this.maxBuffered) { this.terminate(); return; }
    this.sock.write(frame(Buffer.from(text, 'utf8'), 1));
  }

  /** Close politely: a close frame with a code the client can read, then the socket. */
  close(code = 1000, reason = '') {
    if (this.closed) return;
    const r = Buffer.from(String(reason).slice(0, 100), 'utf8');
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0); r.copy(p, 2);
    this.sock.end(frame(p, 8));
    this._gone();
  }

  terminate() {
    this.sock.destroy();
    this._gone();
  }

  /** A keep-alive round: a peer that has not answered the previous ping is dropped. */
  ping() {
    if (this.closed) return;
    if (!this.alive) { this.terminate(); return; }
    this.alive = false;
    this.sock.write(frame(Buffer.alloc(0), 9));
  }

  _gone() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  _data(d) {
    if (this.closed) return;
    let buf = this._buf.length ? Buffer.concat([this._buf, d]) : d;
    for (;;) {
      if (buf.length < 2) break;
      const fin = buf[0] & 0x80;
      const opcode = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      // No extension was agreed, so the reserved bits must be clear (§5.2), and
      // a control frame is whole and at most 125 bytes (§5.5).
      if ((buf[0] & 0x70) || (opcode >= 0x8 && (!fin || len > 125))) { this.close(1002, 'protocol'); return; }
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      // A client frame must be masked (§5.1).
      if (!masked || len > this.maxPayload) { this.close(1009, 'too big'); return; }
      if (buf.length < off + 4 + len) break;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (opcode === 0x8) { this.close(1000); return; }
      if (opcode === 0x9) {
        // Pings answered faster than the peer reads them pile up like any other unsent data.
        if (this.sock.writableLength > this.maxBuffered) { this.terminate(); return; }
        this.sock.write(frame(payload, 0xA));
        continue;
      }
      if (opcode === 0xA) { this.alive = true; continue; }
      if (opcode === 0x2) { this.close(1003, 'text only'); return; }
      if (opcode === 0x1) {
        if (this._parts) { this.close(1002, 'protocol'); return; }
        if (fin) { this._deliver(payload); if (this.closed) return; }
        else { this._parts = [payload]; this._partsBytes = payload.length; this._partsAt = Date.now(); }
        continue;
      }
      if (opcode === 0x0) {
        if (!this._parts) { this.close(1002, 'protocol'); return; }
        this._partsBytes += payload.length;
        if (this._partsBytes > this.maxPayload || this._parts.length >= MAX_FRAGMENTS || Date.now() - this._partsAt > FRAGMENT_MS) {
          this.close(1009, 'too big'); return;
        }
        this._parts.push(payload);
        if (fin) { const whole = Buffer.concat(this._parts); this._parts = null; this._deliver(whole); if (this.closed) return; }
        continue;
      }
      this.close(1002, 'protocol');
      return;
    }
    this._buf = buf;
  }

  _deliver(payload) {
    let text;
    try { text = decoder.decode(payload); } catch { this.close(1007, 'utf-8'); return; }
    this.onmessage?.(text);
  }
}
