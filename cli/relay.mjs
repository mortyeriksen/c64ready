// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/relay.mjs — a WebSocket-to-TCP relay for the user port modem, with no
// dependencies. A browser opens ws://<server><prefix>/<host>/<port> and the
// relay connects that TCP address and passes bytes both ways as binary frames
// (RFC 6455). The URL shape is fTelnet's, so relays built for it work too.

import net from 'node:net';
import dns from 'node:dns';
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Who may use the relay. A browser always sends Origin and a page cannot fake
// it, so a browser request must come from a page on this computer (served on a
// loopback name or address, on any port, so the app on a dev server may use
// the relay of c64rdy serve) or from one of `origins`, the sites the app itself
// is published on. A page on another IP address must be the app this server
// serves. A DNS name rebound to this machine is refused. Without the check any
// web page the user has open could open TCP connections through it. Programs
// that send no Origin are local and can connect themselves anyway.
export function fromOwnApp(req, origins = []) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (origins.includes(origin)) return true;
  let o;
  try { o = new URL(origin); } catch { return false; }
  const name = o.hostname.replace(/^\[|\]$/g, '');
  if (name === 'localhost' || (net.isIP(name) !== 0 && isLoopback(name))) return true;
  return o.host === String(req.headers.host || '') && net.isIP(name) !== 0;
}
const MAX_FRAME = 1 << 20;

// Addresses on the user's own machine or network: loopback, private and
// carrier-grade NAT ranges, link-local, multicast and reserved. The relay
// refuses them unless allowLocal is set, so nothing in the app (an installed
// device, a typed ATD) can reach the router or other machines on the network,
// which browsers keep web pages away from.
const LOCAL = new net.BlockList();
for (const [a, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) LOCAL.addSubnet(a, bits, 'ipv4');
for (const [a, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) LOCAL.addSubnet(a, bits, 'ipv6');

/** True for an address on this machine or its network, or for anything that is not an address. */
export function isLocalAddress(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const family = net.isIP(ip);
  if (!family) return true;
  return LOCAL.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

function isLoopback(ip) {
  return ip === '::1' || /^127\./.test(ip) || /^::ffff:127\./i.test(ip);
}

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
 * `onConnect(host, port)` may return false to refuse a target. Targets on this
 * machine or its network are refused unless `allowLocal`. Every refusal goes
 * to `block` (default: `log`), so a server can show it whatever else it logs.
 * `origins` lists sites, besides pages on this computer, whose pages may use it. With
 * `exclusive: false` other upgrade requests are left for the server's other
 * handlers (a dev server's hot reload). Returns the handler, already attached.
 */
export function attachRelay(server, { prefix = '/relay', onConnect = null, log = () => {}, block = log, exclusive = true, allowLocal = false, origins = [] } = {}) {
  const route = new RegExp(`^${prefix.replace(/[/.]/g, '\\$&')}/([^/?#]+)/(\\d{1,5})$`);
  const handler = (req, sock, head) => {
    const m = route.exec((req.url || '').split('?')[0]);
    const key = req.headers['sec-websocket-key'];
    if (!m || !key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return false;
    const host = decodeURIComponent(m[1]);
    const port = Number(m[2]);
    if (!fromOwnApp(req, origins)) {
      block(`relay blocked ${host}:${port}: asked by a page from ${req.headers.origin}, which may not use this relay`);
      sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return true;
    }
    if (head && head.length) sock.unshift(head);
    if (port < 1 || port > 65535 || (onConnect && onConnect(host, port) === false)) {
      block(`relay blocked ${host}:${port}`);
      sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return true;
    }
    const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((p) => p.trim()).filter(Boolean);
    const protocol = offered.includes('binary') ? 'binary' : offered[0];
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    log(`relay → ${host}:${port}`);

    let tcp = null;
    let open = false;
    // `addrs`, when given, are the checked addresses: net.connect tries them
    // in turn (IPv6 and IPv4, as it would for the name) without looking the
    // name up again.
    const connect = (addrs) => {
      if (sock.destroyed) return;
      const lookup = addrs && ((name, opts, cb) => (opts.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family)));
      tcp = net.connect({ host, port, autoSelectFamily: true, ...(lookup ? { lookup } : {}) });
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
    };
    if (allowLocal) connect(null);
    else {
      // Resolve once and connect only to the addresses checked, so a name
      // cannot answer differently the second time.
      dns.lookup(host, { all: true }, (err, addrs) => {
        if (err || !addrs.length) {
          log(`relay ✗ ${host}:${port} ${err ? err.code || err.message : 'no address'}`);
          sock.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        } else if (addrs.some((a) => isLocalAddress(a.address))) {
          block(`relay blocked ${host}:${port}: it is on this computer or its local network (--allow-local permits it)`);
          sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        } else {
          connect(addrs);
        }
      });
    }

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
        if (!masked || len > MAX_FRAME) { sock.destroy(); if (tcp) tcp.destroy(); return; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        buf = buf.subarray(off + 4 + len);
        if (opcode === 0x8) { if (tcp) tcp.end(); sock.end(frame(Buffer.alloc(0), 8)); return; }
        if (opcode === 0x9) { sock.write(frame(payload, 0xA)); continue; }
        if ((opcode === 0x0 || opcode === 0x1 || opcode === 0x2) && open) tcp.write(payload);
      }
    });
    sock.on('close', () => { if (tcp) tcp.destroy(); });
    sock.on('error', () => { if (tcp) tcp.destroy(); });
    return true;
  };
  server.on('upgrade', (req, sock, head) => {
    if (!handler(req, sock, head) && exclusive) sock.destroy();
  });
  return handler;
}
