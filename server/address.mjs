// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/address.mjs — who is asking: the client's address (through a known
// number of proxies), the key it is counted under, and the short hash the
// admin sees and bans by. Addresses themselves are never stored or shown.

import net from 'node:net';
import crypto from 'node:crypto';

/**
 * The client's address. With `trustProxy` set to N, the Nth entry from the
 * right of X-Forwarded-For: each trusted proxy appends the address it saw, so
 * entries a client wrote itself are further left and never chosen.
 */
export function clientAddress(req, trustProxy = 0) {
  const own = req.socket?.remoteAddress || '';
  if (!trustProxy) return own;
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const pick = hops[hops.length - trustProxy];
  return pick && net.isIP(pick) ? pick : own;
}

/**
 * The key an address is counted under. A host usually holds a whole IPv6 /64
 * and can pick any address in it, so the /64 is the address; an IPv4 address
 * on a dual-stack socket (::ffff:a.b.c.d) is its IPv4 one.
 */
export function addressKey(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1];
  if (net.isIP(address) !== 6) return address;
  const [head = '', tail = ''] = address.split('::', 2);
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = address.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/** A hasher keyed with a secret made at start-up: the same address gives the same id until a restart. */
export function addressHasher(secret = crypto.randomBytes(32)) {
  return (key) => crypto.createHmac('sha256', secret).update(key).digest('hex').slice(0, 12);
}

/**
 * True for a page served from this computer (any port): exactly "localhost",
 * or a loopback address. A name that merely starts like one
 * (127.attacker.example, localhost.attacker.example) is someone's domain.
 */
export function isLoopbackOrigin(origin) {
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const name = u.hostname.replace(/^\[|\]$/g, '');
  if (name === 'localhost') return true;
  if (net.isIPv4(name)) return name.startsWith('127.');
  return net.isIPv6(name) && (name === '::1' || /^::ffff:(?:127\.|7f[0-9a-f]{2}:)/i.test(name));
}

/** A token bucket: `rate` per second, holding at most `burst`. */
export class Bucket {
  constructor(rate, burst, now) {
    this.rate = rate;
    this.burst = burst;
    this.now = now;
    this.tokens = burst;
    this.at = now();
  }
  take() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.at) / 1000) * this.rate);
    this.at = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
  giveBack() { this.tokens = Math.min(this.burst, this.tokens + 1); }
}

/** Per-address buckets inside one shared one, bounded in size and forgotten when idle. */
export class Admission {
  constructor({ rate, burst, globalRate, globalBurst, now, maxAddresses = 4096 }) {
    this.rate = rate; this.burst = burst; this.now = now; this.maxAddresses = maxAddresses;
    this.global = new Bucket(globalRate, globalBurst, now);
    this.addresses = new Map();
  }
  take(key) {
    let entry = this.addresses.get(key);
    if (!entry) {
      if (this.addresses.size >= this.maxAddresses) return false;
      entry = { bucket: new Bucket(this.rate, this.burst, this.now), seenAt: 0 };
      this.addresses.set(key, entry);
    }
    entry.seenAt = this.now();
    if (!entry.bucket.take()) return false;
    if (this.global.take()) return true;
    entry.bucket.giveBack();
    return false;
  }
  sweep(idleMs = 5 * 60 * 1000) {
    const cutoff = this.now() - idleMs;
    for (const [key, entry] of this.addresses) if (entry.seenAt <= cutoff) this.addresses.delete(key);
  }
}
