// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/account/account.js — the signed-in account: passkey sign-in and sign-up
// through the chat server's /api (server/accounts.mjs), the account's
// passkeys and its recovery code, and the session token kept in localStorage
// so the account stays signed in across visits. The passkey's relying party is
// the page's own host.

import { chatServerUrl } from '../chat/connection.js';
import { shrinkPicture } from './picture.js';

const TOKEN_KEY = 'c64emu.account.token';
// The signed-in account as last confirmed ({ id, name, createdAt }): what the
// app shows while the account server cannot be reached.
const USER_KEY = 'c64emu.account.user';

/** The API's address: the chat server's, over http(s). */
export function apiBase(chatUrl = chatServerUrl()) {
  const u = new URL(chatUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '/api';
  u.search = ''; u.hash = '';
  return u.toString();
}

const store = {
  get() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ } },
};
const lastUser = {
  get() { try { const u = JSON.parse(localStorage.getItem(USER_KEY) || 'null'); return u && Number.isFinite(u.id) && typeof u.name === 'string' ? u : null; } catch { return null; } },
  set(u) { try { if (u) localStorage.setItem(USER_KEY, JSON.stringify(u)); else localStorage.removeItem(USER_KEY); } catch { /* storage blocked */ } },
};

const toB64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64 = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

/** True where the browser can make and use passkeys. */
export function passkeysSupported() {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials?.create;
}

/** The creation options from JSON, with the challenge, user id and any passkeys to leave out as bytes. */
export function creationOptions(json) {
  return {
    ...json, challenge: fromB64(json.challenge), user: { ...json.user, id: fromB64(json.user.id) },
    ...(json.excludeCredentials ? { excludeCredentials: json.excludeCredentials.map((c) => ({ ...c, id: fromB64(c.id) })) } : {}),
  };
}
/** The request options from JSON, with the challenge (and any listed ids) as bytes. */
export function requestOptions(json) {
  return { ...json, challenge: fromB64(json.challenge), allowCredentials: (json.allowCredentials || []).map((c) => ({ ...c, id: fromB64(c.id) })) };
}
/** A PublicKeyCredential as the JSON the server checks (base64url fields). */
export function credentialJson(cred) {
  const r = cred.response;
  const response = { clientDataJSON: toB64(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = toB64(r.attestationObject);
    response.transports = typeof r.getTransports === 'function' ? r.getTransports() : [];
  } else {
    response.authenticatorData = toB64(r.authenticatorData);
    response.signature = toB64(r.signature);
    if (r.userHandle) response.userHandle = toB64(r.userHandle);
  }
  return { id: cred.id, rawId: toB64(cred.rawId), type: cred.type, response };
}

/**
 * The account client. `fetch` and `credentials` are injectable for tests.
 * Errors carry the server's message (it is written to be shown).
 */
export function createAccount({ base = apiBase(), fetchImpl = (...a) => fetch(...a), credentials = () => navigator.credentials, onChange = () => {} } = {}) {
  let user = null;

  async function call(method, path, body) {
    const token = store.get();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try { res = await fetchImpl(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
    catch { throw new Error('The account server cannot be reached. Try again in a moment.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || `The account server answered ${res.status}.`);
      e.status = res.status;
      throw e;
    }
    return data;
  }
  function signedIn(data) {
    store.set(data.token);
    user = data.user;
    lastUser.set(user);
    onChange(user);
    return user;
  }
  function signedOut() {
    store.set(null);
    lastUser.set(null);
    user = null;
    onChange(null);
  }
  /**
   * Runs an account change that needs a recent passkey confirmation: when the
   * server asks for one (403), the passkey confirms the session, and it runs again.
   */
  async function confirmed(change) {
    try { return await change(); } catch (e) {
      if (e.status !== 403) throw e;
      const opts = await call('POST', '/me/confirm/options', {});
      const cred = await credentials().get({ publicKey: requestOptions(opts.publicKey) });
      if (!cred) throw new Error('No passkey was chosen.');
      await call('POST', '/me/confirm/verify', { challengeId: opts.challengeId, credential: credentialJson(cred) });
      return change();
    }
  }
  // While the account server cannot be reached, the session is checked again:
  // when the browser comes back online, and after a wait that grows to 5 minutes.
  let retrying = false, retryWait = 15_000;

  return {
    get user() { return user; },
    get token() { return store.get(); },
    /**
     * Checks a stored session with the server; null when signed out. Only the
     * server saying no (401) signs out: while it cannot be reached, the account
     * stays as last seen and is checked again when the browser is back online.
     */
    async restore() {
      if (!store.get()) { user = null; return null; }
      try { user = (await call('GET', '/me')).user; lastUser.set(user); retryWait = 15_000; }
      catch (e) {
        if (e.status === 401) { store.set(null); lastUser.set(null); user = null; }
        else {
          user = lastUser.get();
          if (!retrying && typeof window !== 'undefined') {
            retrying = true;
            const again = () => { if (!retrying) return; retrying = false; window.removeEventListener('online', again); clearTimeout(timer); this.restore(); };
            const timer = setTimeout(again, retryWait);
            retryWait = Math.min(retryWait * 2, 300_000);
            window.addEventListener('online', again);
          }
        }
      }
      onChange(user);
      return user;
    },
    /** Creates an account under `name` with a new passkey, and signs in. Returns { user, recoveryCode }. */
    async register(name) {
      const opts = await call('POST', '/auth/register/options', { name });
      const cred = await credentials().create({ publicKey: creationOptions(opts.publicKey) });
      if (!cred) throw new Error('No passkey was made.');
      const data = await call('POST', '/auth/register/verify', { challengeId: opts.challengeId, credential: credentialJson(cred) });
      return { user: signedIn(data), recoveryCode: data.recoveryCode };
    },
    /** A lost passkey: the name and recovery code make a passkey on this device and sign in. Returns { user, recoveryCode }, the new code. */
    async recover(name, code) {
      const opts = await call('POST', '/auth/recover/options', { name, code });
      const cred = await credentials().create({ publicKey: creationOptions(opts.publicKey) });
      if (!cred) throw new Error('No passkey was made.');
      const data = await call('POST', '/auth/recover/verify', { challengeId: opts.challengeId, credential: credentialJson(cred) });
      return { user: signedIn(data), recoveryCode: data.recoveryCode };
    },
    /** The account's passkeys: [{ id, createdAt, lastUsedAt, transports }]. */
    async passkeys() { return (await call('GET', '/me/passkeys')).passkeys; },
    /** Another passkey for the account, on this device or a security key. Returns the passkeys. */
    async addPasskey() {
      const opts = await confirmed(() => call('POST', '/me/passkeys/options', {}));
      const cred = await credentials().create({ publicKey: creationOptions(opts.publicKey) });
      if (!cred) throw new Error('No passkey was made.');
      return (await call('POST', '/me/passkeys/verify', { challengeId: opts.challengeId, credential: credentialJson(cred) })).passkeys;
    },
    /** Removes one of the account's passkeys (never the last). Returns the passkeys. */
    async removePasskey(id) { return (await confirmed(() => call('POST', '/me/passkeys/delete', { id }))).passkeys; },
    /** A new recovery code; the old one stops working. */
    async newRecoveryCode() { return (await confirmed(() => call('POST', '/me/recovery', {}))).recoveryCode; },
    /** Signs in with any passkey this site holds. */
    async signIn() {
      const opts = await call('POST', '/auth/login/options', {});
      const cred = await credentials().get({ publicKey: requestOptions(opts.publicKey) });
      if (!cred) throw new Error('No passkey was chosen.');
      try {
        return signedIn(await call('POST', '/auth/login/verify', { challengeId: opts.challengeId, credential: credentialJson(cred) }));
      } catch (e) {
        if (e.status === 401 && /not registered/.test(e.message)) {
          // Tell the browser this passkey is gone here, so its chooser stops offering it (where supported).
          globalThis.PublicKeyCredential?.signalUnknownCredential?.({ rpId: location.hostname, credentialId: cred.id })?.catch?.(() => {});
          const gone = new Error('That passkey is not registered here. Its account may be gone. Try another passkey, or create an account.');
          gone.status = 401;
          throw gone;
        }
        throw e;
      }
    },
    async signOut() {
      try { await call('POST', '/auth/logout'); } catch { /* signed out here either way */ }
      signedOut();
    },
    /** Sets the account's picture from an image file (shrunk to fit 256x256 here first, never cropped). Returns the user. */
    async setPicture(file) {
      const data = await shrinkPicture(file);
      user = (await call('POST', '/me/avatar', { data })).user;
      lastUser.set(user);
      onChange(user);
      return user;
    },
    /** Takes the account's picture down. Returns the user. */
    async removePicture() {
      user = (await call('POST', '/me/avatar/delete', {})).user;
      lastUser.set(user);
      onChange(user);
      return user;
    },
    /** A user's picture address, or null without one. */
    pictureUrl(u) { return u?.avatar ? `${base}/users/${u.id}/avatar?v=${u.avatar}` : null; },
    /** Deletes the account, its passkeys and sessions on the server. */
    async deleteAccount() {
      await confirmed(() => call('DELETE', '/me'));
      signedOut();
    },
  };
}
