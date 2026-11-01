// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/admin.mjs — the admin console's gate and files. The console signs in
// with a passkey of its own (server/admin-passkeys.mjs); a sign-in sets a
// short-lived HttpOnly, same-site cookie, which every console page, request and
// the live socket present. The first passkey is set up with a one-time setup
// key: made on the admin's computer (`npm run admin-key`, only its hash on the
// server), or shown in the dev server's terminal. A signed-in console makes
// keys for more devices. No key is ever written to a log.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { b64url, verifyRegistration, verifyAssertion } from './webauthn.mjs';

const COOKIE = 'c64chat_admin';
const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

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
  '/admin/players.js': { file: 'players.js', type: 'text/javascript; charset=utf-8' },
  '/admin/admin.css': { file: 'admin.css', type: 'text/css; charset=utf-8', open: true },
  '/admin/login': { file: 'login.html', type: 'text/html; charset=utf-8', open: true },
  '/admin/login.js': { file: 'login.js', type: 'text/javascript; charset=utf-8', open: true },
};
const cache = new Map();

/** The console file at a path, or null. `open` files are shown before signing in. */
export function adminAsset(path) {
  const a = ASSETS[path];
  if (!a) return null;
  if (!cache.has(a.file)) cache.set(a.file, read(a.file));
  return { ...a, body: cache.get(a.file) };
}

// Setup keys: 20 characters of Crockford's base32 in groups of five, like a recovery code.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newSetupKey() {
  const bytes = crypto.randomBytes(20);
  const s = Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
  return s.match(/.{5}/g).join('-');
}
/** A key as typed: case, spaces, dashes and look-alike letters forgiven. Its SHA-256, in hex. */
export function setupKeyHash(key) {
  const k = String(key ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return sha256hex(`c64ready-admin-setup:${k}`);
}

/**
 * @param {object} o
 * @param {ReturnType<import('./admin-passkeys.mjs').createAdminPasskeys>} o.passkeys
 * @param {() => number} o.now
 * @param {string} [o.setupKeySha256]   hex hash of a setup key made with `npm run admin-key`
 * @param {(hash: string) => boolean} [o.keyUsed]  whether that key was used already (kept in the database)
 * @param {(hash: string) => void} [o.useKey]
 * @param {(token: string) => void} [o.onRevoke]  a sign-in ended (signed out, or run out): close what it opened
 */
export function createAdminGate({ passkeys, now, setupKeySha256 = null, keyUsed = () => false, useKey = () => {}, onRevoke = () => {},
  tokenMs = 12 * 3600_000, keyMs = 10 * 60_000, challengeMs = 5 * 60_000, maxFailures = 10, failureWindowMs = 10 * 60_000 }) {
  const tokens = new Map();      // token → expiry
  const keys = new Map();        // setup key hash → expiry (Infinity for the configured or the dev key)
  const challenges = new Map();  // id → { kind, challenge, keyHash?, expiresAt }
  const failures = new Map();    // address key → { count, since }
  if (setupKeySha256 && /^[0-9a-f]{64}$/i.test(setupKeySha256) && !keyUsed(setupKeySha256.toLowerCase())) keys.set(setupKeySha256.toLowerCase(), Infinity);

  const issue = () => { const t = crypto.randomBytes(24).toString('base64url'); tokens.set(t, now() + tokenMs); return t; };
  const cookie = (token, secure, age = Math.floor(tokenMs / 1000)) => `${COOKIE}=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  function tokenOf(req) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [k, v] = part.trim().split('=');
      if (k === COOKIE && v && (tokens.get(v) ?? 0) > now()) return v;
    }
    return null;
  }
  const limited = (key) => (failures.get(key)?.count ?? 0) >= maxFailures && now() - failures.get(key).since < failureWindowMs;
  function failed(key) {
    const f = failures.get(key);
    const e = f && now() - f.since < failureWindowMs ? f : { count: 0, since: now() };
    e.count++;
    failures.set(key, e);
  }
  // One address holds a few challenges at once, and when the store is full the
  // oldest goes: a flood from many addresses costs the admin a retry, never the console.
  function challenge(addr, entry) {
    const t = now();
    for (const [id, c] of challenges) if (c.expiresAt <= t) challenges.delete(id);
    let held = 0;
    for (const c of challenges.values()) if (c.addr === addr && ++held >= 5) throw Object.assign(new Error('too many tries, wait a few minutes'), { status: 429 });
    while (challenges.size >= 1000) challenges.delete(challenges.keys().next().value);
    const id = b64url.encode(crypto.randomBytes(16)), value = b64url.encode(crypto.randomBytes(32));
    challenges.set(id, { ...entry, addr, challenge: value, expiresAt: t + challengeMs });
    return { id, challenge: value };
  }
  function take(id) {
    const c = typeof id === 'string' ? challenges.get(id) : undefined;
    if (c) challenges.delete(id);
    if (!c || c.expiresAt <= now()) throw Object.assign(new Error('the sign-in request expired, try again'), { status: 400 });
    return c;
  }
  const keyValid = (hash) => (keys.get(hash) ?? 0) > now();

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const parts = [];
      req.on('data', (c) => { size += c.length; if (size > 16 * 1024) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else parts.push(c); });
      req.on('end', () => { try { resolve(size ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('not JSON'), { status: 400 })); } });
      req.on('error', reject);
    });
  }
  const json = (res, status, body, extra = {}) => res.writeHead(status, { 'Content-Type': 'application/json', ...ADMIN_HEADERS, ...extra }).end(JSON.stringify(body));

  // Each route: (body, ctx) → result, or [result, headers]. ctx: { req, addr, secure, allowedOrigin, signedIn }
  const ROUTES = {
    // Which way in: a passkey, or setting one up with a key.
    'GET /admin/auth/state': (b, ctx) => ({ signedIn: ctx.signedIn, passkeys: passkeys.count() > 0 }),
    'POST /admin/auth/options'(b, ctx) {
      if (limited(ctx.addr)) throw Object.assign(new Error('too many tries, wait a few minutes'), { status: 429 });
      if (b.mode === 'setup') {
        const hash = setupKeyHash(b.key);
        if (!keyValid(hash)) { failed(ctx.addr); throw Object.assign(new Error('that setup key does not work'), { status: 401 }); }
        const { id, challenge: c } = challenge(ctx.addr, { kind: 'setup', keyHash: hash });
        return { challengeId: id, publicKey: {
          challenge: c, rp: { name: 'C64 READY. admin' },
          user: { id: b64url.encode(Buffer.from('c64ready-admin')), name: 'admin', displayName: 'C64 READY. admin' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
          excludeCredentials: passkeys.list().map((p) => ({ type: 'public-key', id: p.id })),
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }, attestation: 'none', timeout: challengeMs,
        } };
      }
      if (!passkeys.count()) throw Object.assign(new Error('no admin passkey yet: set one up with the setup key'), { status: 409 });
      const { id, challenge: c } = challenge(ctx.addr, { kind: 'login' });
      return { challengeId: id, publicKey: { challenge: c, userVerification: 'preferred', allowCredentials: passkeys.list().map((p) => ({ type: 'public-key', id: p.id })), timeout: challengeMs } };
    },
    'POST /admin/auth/verify'(b, ctx) {
      const c = take(b.challengeId);
      if (c.kind === 'setup') {
        if (!keyValid(c.keyHash)) throw Object.assign(new Error('that setup key does not work any more'), { status: 401 });
        let key;
        try { key = verifyRegistration(b.credential, { challenge: c.challenge, allowedOrigin: ctx.allowedOrigin }); }
        catch (e) { throw Object.assign(new Error(`passkey not accepted: ${e.message}`), { status: 400 }); }
        passkeys.add(key, b.label);
        keys.delete(c.keyHash);
        useKey(c.keyHash);
      } else {
        const stored = passkeys.get(b.credential?.id);
        if (!stored) { failed(ctx.addr); throw Object.assign(new Error('that passkey is not an admin passkey'), { status: 401 }); }
        let r;
        try { r = verifyAssertion(b.credential, stored, { challenge: c.challenge, allowedOrigin: ctx.allowedOrigin }); }
        catch (e) { failed(ctx.addr); throw Object.assign(new Error(`passkey not accepted: ${e.message}`), { status: 401 }); }
        passkeys.use(stored.id, r.signCount);
      }
      return [{ ok: true }, { 'Set-Cookie': cookie(issue(), ctx.secure) }];
    },
    'POST /admin/auth/logout'(b, ctx) {
      const t = tokenOf(ctx.req);
      if (t) { tokens.delete(t); onRevoke(t); }
      return [{ ok: true }, { 'Set-Cookie': cookie('', ctx.secure, 0) }];
    },
    // Signed in: the console's passkeys, a key for another device, and removing one.
    'GET /admin/auth/passkeys': () => ({ passkeys: passkeys.list() }),
    'POST /admin/auth/add'() {
      const key = newSetupKey();
      keys.set(setupKeyHash(key), now() + keyMs);
      return { key, expires: now() + keyMs };
    },
    'POST /admin/auth/remove'(b) {
      if (passkeys.count() <= 1) throw Object.assign(new Error('the console keeps at least one passkey'), { status: 409 });
      if (!passkeys.remove(b.id)) throw Object.assign(new Error('no such passkey'), { status: 404 });
      return { passkeys: passkeys.list() };
    },
  };
  const OPEN = new Set(['GET /admin/auth/state', 'POST /admin/auth/options', 'POST /admin/auth/verify', 'POST /admin/auth/logout']);

  return {
    /** True when the request carries a live console cookie. */
    tokenFrom: (req) => !!tokenOf(req),
    /** The request's live console sign-in (its token), or null. */
    tokenOf,
    /** Whether a sign-in is still live: not signed out, not run out. */
    valid: (token) => !!token && (tokens.get(token) ?? 0) > now(),
    /** A setup key for the dev server's terminal: good until a passkey is set up with it. Null once one exists. */
    devSetupKey() {
      if (passkeys.count()) return null;
      const key = newSetupKey();
      keys.set(setupKeyHash(key), Infinity);
      return key;
    },
    /**
     * The gate's own routes under /admin/auth. ctx: { addr, secure,
     * allowedOrigin(origin), sameOrigin } — a POST must come from the console's own page.
     */
    handles: (method, path) => Object.hasOwn(ROUTES, `${method} ${path}`),
    async handle(req, res, path, ctx) {
      const key = `${req.method} ${path}`;
      const signedIn = !!tokenOf(req);
      if (!OPEN.has(key) && !signedIn) { json(res, 401, { error: 'sign in first' }); return; }
      if (req.method === 'POST' && !ctx.sameOrigin) { json(res, 403, { error: 'not from the console' }); return; }
      try {
        const body = req.method === 'POST' ? await readJson(req) : {};
        const out = ROUTES[key](body && typeof body === 'object' ? body : {}, { ...ctx, req, signedIn });
        const [result, headers] = Array.isArray(out) ? out : [out, {}];
        json(res, 200, result, headers);
      } catch (e) {
        json(res, e.status || 500, { error: e.status ? e.message : 'server error' });
      }
    },
    sweep() {
      const t = now();
      for (const [token, until] of tokens) if (until <= t) { tokens.delete(token); onRevoke(token); }
      for (const [h, until] of keys) if (until <= t) keys.delete(h);
      for (const [k, f] of failures) if (t - f.since >= failureWindowMs) failures.delete(k);
    },
  };
}
