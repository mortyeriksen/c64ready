// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/admin/login.js — the console's sign-in: the admin passkey, or setting
// one up on this device with a one-time key (server/admin.mjs).

const $ = (id) => document.getElementById(id);
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `The server answered ${r.status}.`);
  return data;
}
/** The credential as the server reads it: base64url fields. */
function credentialJson(cred) {
  const r = cred.response, response = { clientDataJSON: toB64(r.clientDataJSON) };
  if (r.attestationObject) { response.attestationObject = toB64(r.attestationObject); response.transports = r.getTransports?.() ?? []; }
  else { response.authenticatorData = toB64(r.authenticatorData); response.signature = toB64(r.signature); if (r.userHandle) response.userHandle = toB64(r.userHandle); }
  return { id: cred.id, rawId: toB64(cred.rawId), type: cred.type, response };
}
const say = (text) => { $('msg').textContent = text; };
const done = () => { location.href = '/admin'; };

async function signIn() {
  say('');
  try {
    const o = await post('/admin/auth/options', { mode: 'login' });
    const pk = o.publicKey;
    const cred = await navigator.credentials.get({ publicKey: { ...pk, challenge: fromB64(pk.challenge), allowCredentials: pk.allowCredentials.map((c) => ({ ...c, id: fromB64(c.id) })) } });
    await post('/admin/auth/verify', { challengeId: o.challengeId, credential: credentialJson(cred) });
    done();
  } catch (e) { say(e.name === 'NotAllowedError' ? 'No passkey was chosen.' : e.message); }
}

async function setUp(e) {
  e.preventDefault();
  say('');
  try {
    const o = await post('/admin/auth/options', { mode: 'setup', key: $('setup-key').value });
    const pk = o.publicKey;
    const cred = await navigator.credentials.create({ publicKey: { ...pk, challenge: fromB64(pk.challenge), user: { ...pk.user, id: fromB64(pk.user.id) }, excludeCredentials: pk.excludeCredentials.map((c) => ({ ...c, id: fromB64(c.id) })) } });
    await post('/admin/auth/verify', { challengeId: o.challengeId, credential: credentialJson(cred), label: $('setup-label').value });
    done();
  } catch (err) { say(err.name === 'NotAllowedError' ? 'No passkey was made.' : err.message); }
}

$('btn-signin').addEventListener('click', signIn);
$('setup-form').addEventListener('submit', setUp);
fetch('/admin/auth/state').then((r) => r.json()).then((s) => {
  if (s.signedIn) done();
  // Before the first passkey there is nothing to sign in with yet.
  $('signin').hidden = !s.passkeys;
}).catch(() => {});
