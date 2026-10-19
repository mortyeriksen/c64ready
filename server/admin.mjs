// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/admin.mjs — the admin console's gate and files. The pages ask for
// basic auth; a page load also sets a short-lived HttpOnly cookie, which is
// what the console's live socket presents, since a browser does not reliably
// send basic credentials on a WebSocket. Failed logins are limited per address.

import crypto from 'node:crypto';
import fs from 'node:fs';

const COOKIE = 'c64chat_admin';
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();

export const ADMIN_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

const dir = new URL('./admin/', import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, dir));
const ASSETS = {
  '/admin': { file: 'index.html', type: 'text/html; charset=utf-8', page: true },
  '/admin/': { file: 'index.html', type: 'text/html; charset=utf-8', page: true },
  '/admin/admin.js': { file: 'admin.js', type: 'text/javascript; charset=utf-8' },
  '/admin/admin.css': { file: 'admin.css', type: 'text/css; charset=utf-8' },
};
const cache = new Map();

/** The console file at a path, or null. */
export function adminAsset(path) {
  const a = ASSETS[path];
  if (!a) return null;
  if (!cache.has(a.file)) cache.set(a.file, read(a.file));
  return { ...a, body: cache.get(a.file) };
}

/**
 * @param {object} o
 * @param {string} o.user
 * @param {string} o.passwordSha256   hex SHA-256 of the password
 * @param {() => number} o.now
 */
export function createAdminGate({ user, passwordSha256, now, tokenMs = 12 * 3600_000, maxFailures = 5, failureWindowMs = 10 * 60_000 }) {
  const wantPass = Buffer.from(String(passwordSha256 || ''), 'hex');
  if (!user || wantPass.length !== 32) throw new Error('admin needs a user and a 64-digit hex SHA-256 of the password');
  const wantUser = sha256(user);
  const failures = new Map();   // address key → { count, since }
  const tokens = new Map();     // token → expiry

  function credentials(req) {
    const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(String(req.headers.authorization || ''));
    if (!m) return null;
    const text = Buffer.from(m[1], 'base64').toString('utf8');
    const at = text.indexOf(':');
    return at < 0 ? null : { user: text.slice(0, at), pass: text.slice(at + 1) };
  }

  return {
    /** 'ok', 'denied' (ask again) or 'limited' (too many failures from this address). */
    authorize(req, key) {
      const f = failures.get(key);
      if (f && now() - f.since >= failureWindowMs) failures.delete(key);
      if ((failures.get(key)?.count ?? 0) >= maxFailures) return 'limited';
      const c = credentials(req);
      if (!c) return 'denied';
      // Both compared every time, in constant time, so timing tells nothing.
      const userOk = crypto.timingSafeEqual(sha256(c.user), wantUser);
      const passOk = crypto.timingSafeEqual(sha256(c.pass), wantPass);
      if (userOk && passOk) return 'ok';
      const entry = failures.get(key) ?? { count: 0, since: now() };
      entry.count++;
      failures.set(key, entry);
      return 'denied';
    },
    issueToken() {
      const token = crypto.randomBytes(24).toString('base64url');
      tokens.set(token, now() + tokenMs);
      return token;
    },
    cookie(token, secure) {
      return `${COOKIE}=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(tokenMs / 1000)}${secure ? '; Secure' : ''}`;
    },
    /** True when the request carries a live console cookie. */
    tokenFrom(req) {
      for (const part of String(req.headers.cookie || '').split(';')) {
        const [k, v] = part.trim().split('=');
        if (k === COOKIE && v && (tokens.get(v) ?? 0) > now()) return true;
      }
      return false;
    },
    sweep() {
      const t = now();
      for (const [token, until] of tokens) if (until <= t) tokens.delete(token);
      for (const [key, f] of failures) if (t - f.since >= failureWindowMs) failures.delete(key);
    },
  };
}
