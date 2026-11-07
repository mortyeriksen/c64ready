// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/accounts.mjs — accounts that sign in with a passkey, no password and
// no third party. The JSON API under /api, for the app's pages (CORS limited to
// the chat's own origins):
//
//   POST   /api/auth/register/options   { name }                → { challengeId, publicKey }
//   POST   /api/auth/register/verify    { challengeId, credential } → { token, user, recoveryCode }
//   POST   /api/auth/login/options      {}                      → { challengeId, publicKey }
//   POST   /api/auth/login/verify       { challengeId, credential } → { token, user }
//   POST   /api/auth/logout             (Bearer token)          → { ok }
//   GET    /api/me                      (Bearer token)          → { user }
//   DELETE /api/me                      (Bearer token)          → { ok }  the account, its passkeys and sessions
//   GET    /api/me/passkeys             (Bearer token)          → { passkeys: [{ id, createdAt, lastUsedAt, transports }] }
//   POST   /api/me/passkeys/options     (Bearer token)          → { challengeId, publicKey }  another passkey for the account
//   POST   /api/me/passkeys/verify      (Bearer token) { challengeId, credential } → { passkeys }
//   POST   /api/me/passkeys/delete      (Bearer token) { id }   → { passkeys }  never the last one
//   POST   /api/me/recovery             (Bearer token)          → { recoveryCode }  a new code; the old one stops working
//   POST   /api/auth/recover/options    { name, code }          → { challengeId, publicKey }
//   POST   /api/auth/recover/verify     { challengeId, credential } → { token, user, recoveryCode }
//
// A recovery code is shown once, when it is made, and kept only as its
// SHA-256. With the account's name it adds a passkey on a new device and signs
// in; the code is then replaced. Five wrong codes from one address lock that
// address out of the account's recovery for an hour, and a wrong name answers
// the same as a wrong code.
//
// A session token is random and kept only as its SHA-256. The passkey's
// relying party is the page's own host, so the same account works on every
// allowed origin with that host.

import crypto from 'node:crypto';
import { clientAddress, addressKey, isLoopbackOrigin, Admission } from './address.mjs';
import { LIMITS, cleanName, isReservedNick, wordFilter } from './protocol.mjs';
import { b64url, verifyRegistration, verifyAssertion } from './webauthn.mjs';
import { forgetDeleted } from './db.mjs';

export const ACCOUNT_DEFAULTS = Object.freeze({
  challengeMs: 5 * 60_000,
  sessionMs: 180 * 24 * 3600_000,
  maxChallenges: 10_000,
  challengesPerAddress: 20,   // sign-in challenges one address may hold at once
  signupsPerHour: 10,         // new accounts from one address in an hour: a class or an office gets through, bulk sign-ups do not
  // The rest of the API, per address: requests a second, and at once. Generous,
  // since a school or an office shares one address.
  readRate: 20, readBurst: 120,
  maxBody: 16 * 1024,
  maxPictureBody: 160 * 1024,  // a picture's request: the image as base64, with room
  maxPictureBytes: 96 * 1024,
  pictureSide: 256,
  recoveryTries: 5,
  recoveryLockMs: 3600_000,
  confirmMs: 10 * 60_000,     // how long a passkey's confirmation lets the session change the account
  loginsMs: 90 * 24 * 3600_000,  // how long the admin's login history is kept
});

// Recovery codes: 20 characters of Crockford's base32 (100 bits), shown in
// groups of five. Reading them back forgives case, spaces, dashes and the
// letters that look like digits.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newRecoveryCode() {
  const bytes = crypto.randomBytes(20);
  let s = '';
  for (const b of bytes) s += CROCKFORD[b & 31];
  return s.match(/.{5}/g).join('-');
}
export function normalizeRecoveryCode(code) {
  if (typeof code !== 'string' || code.length > 64) return '';
  return code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}
const codeHash = (code) => sha256hex(`c64ready-recovery:${normalizeRecoveryCode(code)}`);

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** The key two names are compared under: "Zaxxon" and "ZAXXON" are one name. */
export const nameKey = (name) => name.normalize('NFKC').toLowerCase();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
/**
 * A browser's own description of itself, cut to what the admin needs: the
 * browser and the system ("Chrome on macOS"). Nothing else of it is kept.
 */
export function deviceOf(agent) {
  const a = String(agent || '');
  if (!a) return null;
  const browser = /Edg\//.test(a) ? 'Edge' : /OPR\//.test(a) ? 'Opera' : /Firefox\//.test(a) ? 'Firefox' : /Chrome\//.test(a) ? 'Chrome' : /Safari\//.test(a) ? 'Safari' : 'a browser';
  const system = /iPhone/.test(a) ? 'iPhone' : /iPad/.test(a) ? 'iPad' : /Android/.test(a) ? 'Android' : /Mac OS X|Macintosh/.test(a) ? 'macOS' : /Windows/.test(a) ? 'Windows' : /CrOS/.test(a) ? 'ChromeOS' : /Linux/.test(a) ? 'Linux' : null;
  return system ? `${browser} on ${system}` : browser;
}

/** A response that is not JSON: bytes and their type. */
class Raw {
  constructor(bytes, type, headers = {}) { this.bytes = bytes; this.type = type; this.headers = headers; }
}

/**
 * What an image is, read from its header: { type, width, height } for a PNG,
 * JPEG or WebP, else null. Nothing else is ever stored or served as a picture.
 */
export function imageInfo(b) {
  if (!b || b.length < 30) return null;
  if (b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString('latin1', 12, 16) === 'IHDR') {
    return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    // JPEG: walk the segments to the frame header (SOF0-SOF15, but not DHT/JPG/DAC).
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1], len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: 'image/jpeg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
    return null;
  }
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8 ' && b.length >= 30) return { type: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L' && b.length >= 25) { const v = b.readUInt32LE(21); return { type: 'image/webp', width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
    if (chunk === 'VP8X' && b.length >= 30) return { type: 'image/webp', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/**
 * @param {object} o
 * @param {import('node:sqlite').DatabaseSync} o.db
 * @param {string[]} [o.origins]   sites whose pages may call the API
 * @param {boolean} [o.allowLoopback]  pages on this computer may call it too (the dev server)
 * @param {number} [o.trustProxy]  as for the chat
 * @param {string[]} [o.blockedWords]
 * @param {() => number} [o.now]
 * @param {(id: number) => void} [o.onDeleted]  an account its owner deleted: the chat lets it go
 * @param {{ get: (key: string) => object|null }} [o.bans]  banned addresses (server/bans.mjs): only public reading
 * @param {(api: object) => object} [o.extend]  more routes on the same API: given
 *   { db, now, log, HttpError, requireUser, optionalUser }, returns a route map
 *   like the one below (keys "METHOD /path", with :params)
 */
export function createAccounts({ db, origins = [], allowLoopback = false, trustProxy = 0, blockedWords = [], now = Date.now, log = () => {}, limits = {}, extend = null, bans = null, onDeleted = () => {} }) {
  const L = { ...ACCOUNT_DEFAULTS, ...limits };
  const words = wordFilter(blockedWords);
  const challenges = new Map();   // challengeId → { challenge, kind, name?, handle?, userId?, recoveryHash?, expiresAt }
  // Wrong recovery codes, counted per account and client address: a stranger's
  // guesses lock out only the stranger, never the owner.
  const recoveryMisses = new Map();   // "userId|address" → { n, until }
  const admission = new Admission({ rate: 1, burst: 20, globalRate: 50, globalBurst: 200, now });
  const reads = new Admission({ rate: L.readRate, burst: L.readBurst, globalRate: 100 * L.readRate, globalBurst: 100 * L.readBurst, now, maxAddresses: 50_000 });

  const allowedOrigin = (origin) => origins.includes(origin) || (allowLoopback && isLoopbackOrigin(origin));

  const q = {
    userByKey: db.prepare('SELECT id, name, created_at, avatar_at FROM users WHERE name_key = ?'),
    userById: db.prepare('SELECT id, name, created_at, avatar_at FROM users WHERE id = ?'),
    picture: db.prepare('SELECT avatar, avatar_type, avatar_at FROM users WHERE id = ?'),
    setPicture: db.prepare('UPDATE users SET avatar = ?, avatar_type = ?, avatar_at = ? WHERE id = ?'),
    userByHandle: db.prepare('SELECT id FROM users WHERE handle = ?'),
    addUser: db.prepare('INSERT INTO users (name, name_key, handle, created_at) VALUES (?, ?, ?, ?)'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    passkey: db.prepare('SELECT id, user_id, public_key, sign_count FROM passkeys WHERE id = ?'),
    passkeysOf: db.prepare('SELECT id, created_at, last_used_at, transports FROM passkeys WHERE user_id = ? ORDER BY created_at'),
    deletePasskey: db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?'),
    userForRecovery: db.prepare('SELECT id, name, handle, recovery_hash FROM users WHERE name_key = ?'),
    handleOf: db.prepare('SELECT handle FROM users WHERE id = ?'),
    setRecovery: db.prepare('UPDATE users SET recovery_hash = ? WHERE id = ?'),
    // Replaces the code only if it is still the one a recovery began with.
    swapRecovery: db.prepare('UPDATE users SET recovery_hash = ? WHERE id = ? AND recovery_hash = ?'),
    addPasskey: db.prepare('INSERT INTO passkeys (id, user_id, public_key, sign_count, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    usePasskey: db.prepare('UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?'),
    addSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, confirmed_at) VALUES (?, ?, ?, ?, ?, ?)'),
    session: db.prepare('SELECT user_id, expires_at, confirmed_at FROM sessions WHERE token_hash = ?'),
    confirmSession: db.prepare('UPDATE sessions SET confirmed_at = ? WHERE token_hash = ?'),
    touchSession: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    expireSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    addLogin: db.prepare('INSERT INTO logins (user_id, at, kind, ok, ip, device) VALUES (?, ?, ?, ?, ?, ?)'),
    expireLogins: db.prepare('DELETE FROM logins WHERE at < ?'),
    createdSince: db.prepare("SELECT ip FROM logins WHERE kind = 'created' AND at >= ?"),
  };
  /** One line of an account's login history: what, from which address and browser, and whether it worked. */
  function logLogin(req, userId, kind, ok = true) {
    try { q.addLogin.run(userId, now(), kind, ok ? 1 : 0, clientAddress(req, trustProxy) || null, deviceOf(req.headers['user-agent'])); } catch { /* the account is gone */ }
  }

  // avatar: the picture's version (when it was set), or 0 without one.
  const publicUser = (u) => ({ id: u.id, name: u.name, createdAt: u.created_at, avatar: u.avatar_at || 0 });
  const passkeyList = (userId) => q.passkeysOf.all(userId).map((p) => ({ id: p.id, createdAt: p.created_at, lastUsedAt: p.last_used_at, transports: JSON.parse(p.transports || '[]') }));
  /** A new recovery code for the account; the old one stops working. */
  function rotateRecovery(userId) {
    const code = newRecoveryCode();
    q.setRecovery.run(codeHash(code), userId);
    dropRecoveries(userId);
    return code;
  }
  /** Recoveries begun with an account's old code are void once it changes. */
  function dropRecoveries(userId) {
    for (const [id, c] of challenges) if (c.kind === 'recover' && c.userId === userId) challenges.delete(id);
  }
  /** The options to make a passkey for an account that exists: its handle, and the passkeys it has. */
  function addPasskeyOptions(req, userId, name, kind, extra = {}) {
    const handle = q.handleOf.get(userId).handle;
    const { id, challenge } = newChallenge(req, { kind, userId, ...extra });
    return {
      challengeId: id,
      publicKey: {
        challenge,
        rp: { name: 'C64 READY' },
        user: { id: b64url.encode(handle), name, displayName: name },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
        excludeCredentials: q.passkeysOf.all(userId).map((p) => ({ type: 'public-key', id: p.id })),
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
        attestation: 'none',
        timeout: L.challengeMs,
      },
    };
  }
  /** Checks a new passkey against its challenge and stores it for the account. */
  function storeNewPasskey(c, credential, userId) {
    let key;
    try { key = verifyRegistration(credential, { challenge: c.challenge, allowedOrigin }); }
    catch (e) { throw new HttpError(400, `passkey not accepted: ${e.message}`); }
    if (q.passkey.get(key.id)) throw new HttpError(409, 'that passkey is already registered');
    q.addPasskey.run(key.id, userId, JSON.stringify(key.jwk), key.signCount, JSON.stringify(key.transports), now());
  }

  /**
   * A sign-in challenge for the asking address. One address holds at most a
   * few at once, and when the store is full the oldest goes, so a flood from
   * many addresses delays a sign-in by one retry rather than locking everyone out.
   */
  function newChallenge(req, entry) {
    const t = now();
    for (const [id, c] of challenges) if (c.expiresAt <= t) challenges.delete(id);
    const addr = addressKey(clientAddress(req, trustProxy));
    let held = 0;
    for (const c of challenges.values()) if (c.addr === addr && ++held >= L.challengesPerAddress) throw new HttpError(429, 'too many attempts, wait a minute');
    while (challenges.size >= L.maxChallenges) challenges.delete(challenges.keys().next().value);
    const id = b64url.encode(crypto.randomBytes(16));
    const challenge = b64url.encode(crypto.randomBytes(32));
    challenges.set(id, { ...entry, addr, challenge, expiresAt: t + L.challengeMs });
    return { id, challenge };
  }
  /** A challenge is good once: taking it removes it. */
  function takeChallenge(id, kind) {
    const c = typeof id === 'string' ? challenges.get(id) : undefined;
    if (c) challenges.delete(id);
    if (!c || c.kind !== kind || c.expiresAt <= now()) throw new HttpError(400, 'the sign-in request expired, try again');
    return c;
  }

  function startSession(userId) {
    const token = b64url.encode(crypto.randomBytes(32)), t = now();
    q.addSession.run(sha256hex(token), userId, t, t + L.sessionMs, t, t);   // a passkey just signed it in
    return token;
  }

  /** The signed-in user for a session token, or null. Also used by the chat. */
  function userForToken(token) {
    if (typeof token !== 'string' || token.length > 100) return null;
    const hash = sha256hex(token);
    const s = q.session.get(hash);
    if (!s) return null;
    if (s.expires_at <= now()) { q.deleteSession.run(hash); return null; }
    q.touchSession.run(now(), hash);
    const u = q.userById.get(s.user_id);
    return u ? publicUser(u) : null;
  }

  const bearer = (req) => /^Bearer ([A-Za-z0-9_-]+)$/.exec(String(req.headers.authorization || ''))?.[1] || null;
  function requireUser(req) {
    const user = userForToken(bearer(req));
    if (!user) throw new HttpError(401, 'not signed in');
    return user;
  }
  const optionalUser = (req) => userForToken(bearer(req));
  /**
   * The signed-in user, when a passkey confirmed the session lately (signing
   * in counts). Changing the account's passkeys or recovery code, or deleting
   * it, needs that: a session token alone cannot take the account over.
   */
  function requireConfirmed(req) {
    const user = requireUser(req);
    const s = q.session.get(sha256hex(bearer(req)));
    if (!s || now() - s.confirmed_at > L.confirmMs) throw new HttpError(403, 'confirm with your passkey');
    return user;
  }

  /** At most L.signupsPerHour new accounts from one address (an IPv6 /64) in an hour. */
  function allowSignup(req) {
    const key = addressKey(clientAddress(req, trustProxy));
    let n = 0;
    for (const r of q.createdSince.all(now() - 3600_000)) if (r.ip && addressKey(r.ip) === key && ++n >= L.signupsPerHour) throw new HttpError(429, 'too many new accounts from here just now, try again in an hour');
  }

  function validName(value) {
    const name = cleanName(value, LIMITS.nick);
    if (!name) throw new HttpError(400, `a name is 1 to ${LIMITS.nick} characters`);
    if (isReservedNick(name) || words.blocks(name)) throw new HttpError(400, 'that name cannot be used');
    if (q.userByKey.get(nameKey(name))) throw new HttpError(409, 'that name is taken');
    return name;
  }

  // ── Handlers ────────────────────────────────────────────────────────────
  const routes = {
    'POST /api/auth/register/options'(body, req) {
      allowSignup(req);
      const name = validName(body.name);
      const handle = crypto.randomBytes(16);
      const { id, challenge } = newChallenge(req, { kind: 'register', name, handle });
      return {
        challengeId: id,
        publicKey: {
          challenge,
          rp: { name: 'C64 READY' },
          user: { id: b64url.encode(handle), name, displayName: name },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
          attestation: 'none',
          timeout: L.challengeMs,
        },
      };
    },
    'POST /api/auth/register/verify'(body, req) {
      const c = takeChallenge(body.challengeId, 'register');
      allowSignup(req);
      let key;
      try { key = verifyRegistration(body.credential, { challenge: c.challenge, allowedOrigin }); }
      catch (e) { throw new HttpError(400, `passkey not accepted: ${e.message}`); }
      if (q.passkey.get(key.id)) throw new HttpError(409, 'that passkey is already registered');
      const t = now();
      let userId;
      db.exec('BEGIN');
      try {
        if (q.userByKey.get(nameKey(c.name))) throw new HttpError(409, 'that name is taken');
        userId = Number(q.addUser.run(c.name, nameKey(c.name), c.handle, t).lastInsertRowid);
        q.addPasskey.run(key.id, userId, JSON.stringify(key.jwk), key.signCount, JSON.stringify(key.transports), t);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      log(`account created: ${c.name}`);
      logLogin(req, userId, 'created');
      return { token: startSession(userId), user: publicUser(q.userById.get(userId)), recoveryCode: rotateRecovery(userId) };
    },
    'POST /api/auth/login/options'(body, req) {
      const { id, challenge } = newChallenge(req, { kind: 'login' });
      return { challengeId: id, publicKey: { challenge, userVerification: 'preferred', allowCredentials: [], timeout: L.challengeMs } };
    },
    'POST /api/auth/login/verify'(body, req) {
      const c = takeChallenge(body.challengeId, 'login');
      const stored = typeof body.credential?.id === 'string' ? q.passkey.get(body.credential.id) : undefined;
      if (!stored) throw new HttpError(401, 'that passkey is not registered here');
      const handle = b64url.decode(body.credential?.response?.userHandle ?? '');
      if (handle?.length) {
        const owner = q.userByHandle.get(handle);
        if (!owner || owner.id !== stored.user_id) throw new HttpError(401, 'that passkey belongs to another account');
      }
      let result;
      try { result = verifyAssertion(body.credential, { jwk: JSON.parse(stored.public_key), signCount: stored.sign_count }, { challenge: c.challenge, allowedOrigin }); }
      catch (e) { logLogin(req, stored.user_id, 'sign-in', false); throw new HttpError(401, `passkey not accepted: ${e.message}`); }
      q.usePasskey.run(result.signCount, now(), stored.id);
      logLogin(req, stored.user_id, 'sign-in');
      return { token: startSession(stored.user_id), user: publicUser(q.userById.get(stored.user_id)) };
    },
    'POST /api/auth/logout'(body, req) {
      logLogin(req, requireUser(req).id, 'sign-out');
      q.deleteSession.run(sha256hex(bearer(req)));
      return { ok: true };
    },
    'GET /api/me'(body, req) {
      return { user: requireUser(req) };
    },
    'GET /api/me/passkeys'(body, req) {
      return { passkeys: passkeyList(requireUser(req).id) };
    },
    'POST /api/me/passkeys/options'(body, req) {
      const user = requireConfirmed(req);
      return addPasskeyOptions(req, user.id, user.name, 'add');
    },
    'POST /api/me/passkeys/verify'(body, req) {
      const user = requireUser(req);
      const c = takeChallenge(body.challengeId, 'add');
      if (c.userId !== user.id) throw new HttpError(400, 'the sign-in request expired, try again');
      storeNewPasskey(c, body.credential, user.id);
      log(`passkey added: ${user.name}`);
      return { passkeys: passkeyList(user.id) };
    },
    'POST /api/me/passkeys/delete'(body, req) {
      const user = requireConfirmed(req);
      const list = q.passkeysOf.all(user.id);
      if (!list.some((p) => p.id === body.id)) throw new HttpError(404, 'no such passkey');
      if (list.length <= 1) throw new HttpError(409, 'an account keeps at least one passkey');
      q.deletePasskey.run(body.id, user.id);
      return { passkeys: passkeyList(user.id) };
    },
    'POST /api/me/recovery'(body, req) {
      return { recoveryCode: rotateRecovery(requireConfirmed(req).id) };
    },
    // A passkey confirms the signed-in session, for the changes that need it.
    'POST /api/me/confirm/options'(body, req) {
      const user = requireUser(req);
      const { id, challenge } = newChallenge(req, { kind: 'confirm', userId: user.id });
      return { challengeId: id, publicKey: { challenge, userVerification: 'preferred', allowCredentials: q.passkeysOf.all(user.id).map((p) => ({ type: 'public-key', id: p.id })), timeout: L.challengeMs } };
    },
    'POST /api/me/confirm/verify'(body, req) {
      const user = requireUser(req);
      const c = takeChallenge(body.challengeId, 'confirm');
      const stored = typeof body.credential?.id === 'string' ? q.passkey.get(body.credential.id) : undefined;
      if (c.userId !== user.id || !stored || stored.user_id !== user.id) throw new HttpError(401, 'that passkey is not this account\'s');
      let result;
      try { result = verifyAssertion(body.credential, { jwk: JSON.parse(stored.public_key), signCount: stored.sign_count }, { challenge: c.challenge, allowedOrigin }); }
      catch (e) { throw new HttpError(401, `passkey not accepted: ${e.message}`); }
      q.usePasskey.run(result.signCount, now(), stored.id);
      q.confirmSession.run(now(), sha256hex(bearer(req)));
      logLogin(req, user.id, 'confirm');
      return { ok: true };
    },
    'POST /api/auth/recover/options'(body, req) {
      const name = cleanName(body.name, LIMITS.nick);
      const u = name ? q.userForRecovery.get(nameKey(name)) : undefined;
      const t = now();
      // One answer for a wrong name, a wrong code and a locked address, so it never tells whether a name exists.
      const refused = new HttpError(401, 'that name and recovery code do not match');
      const given = codeHash(body.code);   // hashed either way, so a wrong name takes as long as a wrong code
      if (!u || !u.recovery_hash) throw refused;
      const key = `${u.id}|${addressKey(clientAddress(req, trustProxy))}`;
      const miss = recoveryMisses.get(key);
      if (miss && miss.until > t) throw refused;
      const a = Buffer.from(given, 'hex'), b = Buffer.from(u.recovery_hash, 'hex');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        logLogin(req, u.id, 'recovery', false);
        const n = (miss && !miss.until ? miss.n : 0) + 1;   // a lock that ran out starts the count again
        recoveryMisses.set(key, n >= L.recoveryTries ? { n: 0, until: t + L.recoveryLockMs } : { n, until: 0 });
        throw refused;
      }
      recoveryMisses.delete(key);
      // The challenge is for this code: if the code is replaced before it is used, it is refused.
      return addPasskeyOptions(req, u.id, u.name, 'recover', { recoveryHash: u.recovery_hash });
    },
    'POST /api/auth/recover/verify'(body, req) {
      const c = takeChallenge(body.challengeId, 'recover');
      // One step: the code is swapped for a new one only if it is still the one
      // this recovery began with, and the passkey is stored with it, or neither is.
      const code = newRecoveryCode();
      db.exec('BEGIN');
      try {
        if (q.swapRecovery.run(codeHash(code), c.userId, c.recoveryHash).changes !== 1) throw new HttpError(401, 'that name and recovery code do not match');
        storeNewPasskey(c, body.credential, c.userId);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      dropRecoveries(c.userId);
      const user = q.userById.get(c.userId);
      logLogin(req, c.userId, 'recovery');
      log(`account recovered: ${user.name}`);
      return { token: startSession(c.userId), user: publicUser(user), recoveryCode: code };
    },
    // The account's picture: a PNG, JPEG or WebP of at most 256x256, public on its profile.
    'POST /api/me/avatar'(body, req) {
      const user = requireUser(req);
      const bytes = typeof body.data === 'string' && /^[A-Za-z0-9+/=]+$/.test(body.data) ? Buffer.from(body.data, 'base64') : null;
      const info = bytes && bytes.length <= L.maxPictureBytes ? imageInfo(bytes) : null;
      if (!info || !info.width || !info.height || info.width > L.pictureSide || info.height > L.pictureSide) {
        throw new HttpError(400, `a badge is a PNG, JPEG or WebP of at most ${L.pictureSide}×${L.pictureSide} pixels and ${L.maxPictureBytes / 1024} KB`);
      }
      q.setPicture.run(bytes, info.type, Math.max(now(), (q.userById.get(user.id).avatar_at || 0) + 1), user.id);
      log(`picture set: ${user.name}`);
      return { user: publicUser(q.userById.get(user.id)) };
    },
    'POST /api/me/avatar/delete'(body, req) {
      const user = requireUser(req);
      q.setPicture.run(null, null, 0, user.id);
      return { user: publicUser(q.userById.get(user.id)) };
    },
    'GET /api/users/:id/avatar'(body, req, { id }) {
      const p = /^\d{1,12}$/.test(id) ? q.picture.get(Number(id)) : undefined;
      if (!p?.avatar) throw new HttpError(404, 'no picture');
      // The address carries the version, so a cached copy is right until the picture changes.
      // The app's page is cross-origin isolated (require-corp) and the API is another
      // site, so the picture says it may be embedded anywhere: it is public anyway.
      return new Raw(Buffer.from(p.avatar), p.avatar_type, { 'Cache-Control': 'public, max-age=86400', 'Content-Security-Policy': "default-src 'none'", 'Cross-Origin-Resource-Policy': 'cross-origin' });
    },
    'DELETE /api/me'(body, req) {
      const user = requireConfirmed(req);
      q.deleteUser.run(user.id);   // everything of the account's goes with it (ON DELETE CASCADE)
      forgetDeleted(db);
      onDeleted(user.id);
      log(`account deleted: ${user.name}`);
      return { ok: true };
    },
  };
  const AUTH_ROUTES = new Set(['POST /api/auth/register/options', 'POST /api/auth/register/verify', 'POST /api/auth/login/options', 'POST /api/auth/login/verify',
    'POST /api/auth/recover/options', 'POST /api/auth/recover/verify', 'POST /api/me/passkeys/options', 'POST /api/me/recovery',
    'POST /api/me/confirm/options', 'POST /api/me/confirm/verify', 'POST /api/me/avatar']);
  if (extend) Object.assign(routes, extend({ db, now, log, HttpError, requireUser, optionalUser }));
  // "GET /api/games/:hash" → a method, a path pattern and the names of its parameters.
  const table = Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(' ');
    const names = [];
    const re = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, n) => { names.push(n); return '([A-Za-z0-9_-]{1,64})'; })}$`);
    return { key, method, re, names, handler };
  });
  function match(method, path) {
    for (const r of table) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (m) return { key: r.key, handler: r.handler, params: Object.fromEntries(r.names.map((n, i) => [n, m[i + 1]])) };
    }
    return null;
  }

  // ── HTTP plumbing ───────────────────────────────────────────────────────
  function readBody(req, max = L.maxBody) {
    return new Promise((resolve, reject) => {
      let size = 0; const parts = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > max) { reject(new HttpError(413, 'request too large')); req.destroy(); return; }
        parts.push(chunk);
      });
      req.on('end', () => {
        if (!size) { resolve({}); return; }
        try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch { reject(new HttpError(400, 'body is not JSON')); }
      });
      req.on('error', reject);
    });
  }

  function send(res, status, body, origin) {
    const raw = body instanceof Raw;
    const headers = { 'Content-Type': raw ? body.type : 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(raw ? body.headers : {}) };
    if (origin) Object.assign(headers, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
    res.writeHead(status, headers).end(raw ? body.bytes : JSON.stringify(body));
  }

  const timer = setInterval(() => {
    admission.sweep();
    reads.sweep();
    for (const [k, m] of recoveryMisses) if (m.until && m.until <= now()) recoveryMisses.delete(k);
    try { q.expireSessions.run(now()); q.expireLogins.run(now() - L.loginsMs); } catch { /* closed */ }
  }, 60_000);
  timer.unref?.();

  return {
    userForToken,
    /** Handles /api/*; returns false for any other path. */
    handleRequest(req, res) {
      const path = String(req.url || '').split('?')[0];
      if (!path.startsWith('/api/')) return false;
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigin(origin)) { send(res, 403, { error: 'origin not allowed' }); return true; }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': origin || '*', Vary: 'Origin',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '600',
        }).end();
        return true;
      }
      const found = match(req.method, path);
      if (!found) { send(res, 404, { error: 'not found' }, origin); return true; }
      const { key, handler, params } = found;
      // A banned address reads what is public, and nothing more: a session from it is signed out (401).
      if (bans?.get(addressKey(clientAddress(req, trustProxy))) && !(req.method === 'GET' && !bearer(req))) {
        send(res, bearer(req) ? 401 : 403, { error: 'this address is banned' }, origin);
        return true;
      }
      // Badges are left out of the read limit: a list shows dozens at once, and each is cached for a day.
      const limiter = AUTH_ROUTES.has(key) ? admission : key === 'GET /api/users/:id/avatar' ? null : reads;
      if (limiter && !limiter.take(addressKey(clientAddress(req, trustProxy)))) {
        send(res, 429, { error: AUTH_ROUTES.has(key) ? 'too many attempts, wait a minute' : 'too many requests, slow down' }, origin);
        return true;
      }
      readBody(req, key === 'POST /api/me/avatar' ? L.maxPictureBody : L.maxBody)
        .then((body) => send(res, 200, handler(body && typeof body === 'object' ? body : {}, req, params), origin))
        .catch((e) => {
          if (!(e instanceof HttpError)) log(`api ${key}: ${e.stack || e.message}`);
          send(res, e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : 'server error' }, origin);
        });
      return true;
    },
    /** Records a line of an account's login history from elsewhere (the admin's sign-out). */
    logLogin,
    /** Takes a picture down (the admin's call). */
    removePicture(userId) { q.setPicture.run(null, null, 0, userId); },
    close() { clearInterval(timer); },
  };
}
