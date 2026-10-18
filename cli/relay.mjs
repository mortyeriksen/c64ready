// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/relay.mjs — a WebSocket-to-TCP relay for the user port modem, with no
// dependencies. A browser opens ws://<server><prefix>/<host>/<port> and the
// relay connects that TCP address and passes bytes both ways as binary frames
// (RFC 6455). The URL shape is fTelnet's, so relays built for it work too.

import net from 'node:net';
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Who may use the relay. A browser always sends Origin and a page cannot fake
// it, so a browser request must come from the app this server itself serves,
// and on a loopback name or an IP address: a DNS name rebound to this machine
// is refused as well. Without the check any web page the user has open could
// open TCP connections into their network. Programs that send no Origin are
// local and can open those connections themselves anyway.
export function fromOwnApp(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  let o;
  try { o = new URL(origin); } catch { return false; }
  if (o.host !== String(req.headers.host || '')) return false;
  const name = o.hostname.replace(/^\[|\]$/g, '');
  return name === 'localhost' || net.isIP(name) !== 0;
}
const MAX_FRAME = 1 << 20;

function frame(payload, opcode = 2) {
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

/**
 * Serve the relay on an http.Server's upgrade requests under `prefix`.
 * `onConnect(host, port)` may return false to refuse a target. With
 * `exclusive: false` other upgrade requests are left for the server's other
 * handlers (a dev server's hot reload). Returns the handler, already attached.
 */
export function attachRelay(server, { prefix = '/relay', onConnect = null, log = () => {}, exclusive = true } = {}) {
  const route = new RegExp(`^${prefix.replace(/[/.]/g, '\\$&')}/([^/?#]+)/(\\d{1,5})$`);
  const handler = (req, sock, head) => {
    const m = route.exec((req.url || '').split('?')[0]);
    const key = req.headers['sec-websocket-key'];
    if (!m || !key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return false;
    if (!fromOwnApp(req)) {
      sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return true;
    }
    if (head && head.length) sock.unshift(head);
    const host = decodeURIComponent(m[1]);
    const port = Number(m[2]);
    if (port < 1 || port > 65535 || (onConnect && onConnect(host, port) === false)) {
      sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return true;
    }
    const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((p) => p.trim()).filter(Boolean);
    const protocol = offered.includes('binary') ? 'binary' : offered[0];
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    log(`relay → ${host}:${port}`);

    const tcp = net.connect(port, host);
    let open = false;
    tcp.setNoDelay(true);
    tcp.on('connect', () => {
      open = true;
      sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n`
        + (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : '') + '\r\n');
    });
    tcp.on('data', (d) => { if (!sock.destroyed) sock.write(frame(d)); });
    tcp.on('error', (e) => {
      log(`relay ✗ ${host}:${port} ${e.code || e.message}`);
      if (!open) sock.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      else sock.destroy();
    });
    tcp.on('close', () => {
      if (open && !sock.destroyed) sock.end(frame(Buffer.alloc(0), 8));
    });

    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        const masked = buf[1] & 0x80;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        // A client frame must be masked (RFC 6455 §5.1).
        if (!masked || len > MAX_FRAME) { sock.destroy(); tcp.destroy(); return; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        buf = buf.subarray(off + 4 + len);
        if (opcode === 0x8) { tcp.end(); sock.end(frame(Buffer.alloc(0), 8)); return; }
        if (opcode === 0x9) { sock.write(frame(payload, 0xA)); continue; }
        if ((opcode === 0x0 || opcode === 0x1 || opcode === 0x2) && open) tcp.write(payload);
      }
    });
    sock.on('close', () => tcp.destroy());
    sock.on('error', () => tcp.destroy());
    return true;
  };
  server.on('upgrade', (req, sock, head) => {
    if (!handler(req, sock, head) && exclusive) sock.destroy();
  });
  return handler;
}
