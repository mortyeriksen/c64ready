// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/webauthn.mjs — passkey checks (WebAuthn Level 2, §7.1 registration and
// §7.2 authentication) with Node's crypto and a small CBOR reader. Attestation
// is not asked for and not judged: a passkey is trusted for the account that
// made it, whatever device holds it.

import crypto from 'node:crypto';

export const b64url = {
  encode: (buf) => Buffer.from(buf).toString('base64url'),
  decode: (s) => (typeof s === 'string' && /^[A-Za-z0-9_-]*$/.test(s) ? Buffer.from(s, 'base64url') : null),
};

/** Decodes one CBOR item at `pos` (RFC 8949, definite lengths only): { value, end }. */
export function cborDecode(buf, pos = 0) {
  const head = () => {
    if (pos >= buf.length) throw new Error('CBOR: truncated');
    const b = buf[pos++], major = b >> 5, info = b & 31;
    let n;
    if (info < 24) n = info;
    else if (info === 24) { n = buf[pos]; pos += 1; }
    else if (info === 25) { n = buf.readUInt16BE(pos); pos += 2; }
    else if (info === 26) { n = buf.readUInt32BE(pos); pos += 4; }
    else if (info === 27) { n = Number(buf.readBigUInt64BE(pos)); pos += 8; }
    else throw new Error('CBOR: indefinite or reserved length');
    if (pos > buf.length) throw new Error('CBOR: truncated');
    return { major, info, n };
  };
  const item = () => {
    const { major, info, n } = head();
    switch (major) {
      case 0: return n;
      case 1: return -1 - n;
      case 2: case 3: {
        if (pos + n > buf.length) throw new Error('CBOR: truncated');
        const bytes = buf.subarray(pos, pos + n); pos += n;
        return major === 2 ? Buffer.from(bytes) : bytes.toString('utf8');
      }
      case 4: { const a = []; for (let i = 0; i < n; i++) a.push(item()); return a; }
      case 5: { const m = new Map(); for (let i = 0; i < n; i++) { const k = item(); m.set(k, item()); } return m; }
      case 6: return item();   // a tag: its content
      default:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        throw new Error('CBOR: unsupported simple value');
    }
  };
  const value = item();
  return { value, end: pos };
}

const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40;

/** Authenticator data (§6.1): rpIdHash, flags, signCount and, when present, the credential. */
export function parseAuthData(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 37) throw new Error('authenticator data too short');
  const out = {
    rpIdHash: buf.subarray(0, 32), flags: buf[32], signCount: buf.readUInt32BE(33),
    userPresent: !!(buf[32] & FLAG_UP), userVerified: !!(buf[32] & FLAG_UV),
  };
  if (buf[32] & FLAG_AT) {
    if (buf.length < 55) throw new Error('attested credential data too short');
    const idLen = buf.readUInt16BE(53);
    if (buf.length < 55 + idLen) throw new Error('credential id truncated');
    out.credentialId = Buffer.from(buf.subarray(55, 55 + idLen));
    const { value, end } = cborDecode(buf, 55 + idLen);
    out.coseKey = value;
    out.credentialKeyEnd = end;
  }
  return out;
}

/**
 * A COSE public key (RFC 9053) as a JWK, for the three algorithms the options
 * offer: ES256 (-7), EdDSA (-8) and RS256 (-257). null for anything else.
 */
export function coseToJwk(cose) {
  if (!(cose instanceof Map)) return null;
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) {
    const x = cose.get(-2), y = cose.get(-3);
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) return null;
    return { kty: 'EC', crv: 'P-256', x: b64url.encode(x), y: b64url.encode(y), alg: 'ES256' };
  }
  if (kty === 1 && alg === -8 && cose.get(-1) === 6) {
    const x = cose.get(-2);
    if (!Buffer.isBuffer(x) || x.length !== 32) return null;
    return { kty: 'OKP', crv: 'Ed25519', x: b64url.encode(x), alg: 'EdDSA' };
  }
  if (kty === 3 && alg === -257) {
    const n = cose.get(-1), e = cose.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e) || n.length < 256) return null;
    return { kty: 'RSA', n: b64url.encode(n), e: b64url.encode(e), alg: 'RS256' };
  }
  return null;
}

function verifySignature(jwk, data, signature) {
  const { alg, ...keyJwk } = jwk;
  const key = crypto.createPublicKey({ key: keyJwk, format: 'jwk' });
  if (alg === 'ES256') return crypto.verify('sha256', data, { key, dsaEncoding: 'der' }, signature);
  if (alg === 'EdDSA') return crypto.verify(null, data, key, signature);
  if (alg === 'RS256') return crypto.verify('sha256', data, key, signature);
  return false;
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

/**
 * The browser's client data (§5.8.1), checked: type, challenge and origin. The
 * relying party is the page's own host, so its hash is what the authenticator
 * signed over.
 */
function checkClientData(clientDataJSON, type, challenge, allowedOrigin) {
  let data;
  try { data = JSON.parse(clientDataJSON.toString('utf8')); } catch { throw new Error('client data is not JSON'); }
  if (data.type !== type) throw new Error(`client data type is not ${type}`);
  if (data.challenge !== challenge) throw new Error('challenge does not match');
  if (typeof data.origin !== 'string' || !allowedOrigin(data.origin)) throw new Error('origin not allowed');
  if (data.crossOrigin === true) throw new Error('cross-origin request');
  return new URL(data.origin).hostname;
}

/**
 * Registration (§7.1). `credential` is the JSON form of a PublicKeyCredential
 * from navigator.credentials.create (base64url fields). Returns the passkey to
 * store: { id, jwk, signCount, transports }.
 */
export function verifyRegistration(credential, { challenge, allowedOrigin }) {
  const response = credential?.response || {};
  const clientDataJSON = b64url.decode(response.clientDataJSON);
  const attestationObject = b64url.decode(response.attestationObject);
  const rawId = b64url.decode(credential?.id);
  if (!clientDataJSON || !attestationObject || !rawId || credential.type !== 'public-key') throw new Error('malformed credential');
  const rpId = checkClientData(clientDataJSON, 'webauthn.create', challenge, allowedOrigin);
  const att = cborDecode(attestationObject).value;
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw new Error('malformed attestation object');
  const auth = parseAuthData(att.get('authData'));
  if (!auth.rpIdHash.equals(sha256(rpId))) throw new Error('relying party does not match');
  if (!auth.userPresent) throw new Error('user not present');
  if (!auth.credentialId || !auth.credentialId.equals(rawId)) throw new Error('credential id does not match');
  const jwk = coseToJwk(auth.coseKey);
  if (!jwk) throw new Error('unsupported public key');
  const transports = Array.isArray(response.transports) ? response.transports.filter((t) => typeof t === 'string').slice(0, 8) : [];
  return { id: b64url.encode(rawId), jwk, signCount: auth.signCount, transports };
}

/**
 * Authentication (§7.2) against a stored passkey { jwk, signCount }. Returns the
 * new sign count. A count that does not move forward (when either is non-zero)
 * means the passkey may have been cloned, and is refused.
 */
export function verifyAssertion(credential, stored, { challenge, allowedOrigin }) {
  const response = credential?.response || {};
  const clientDataJSON = b64url.decode(response.clientDataJSON);
  const authenticatorData = b64url.decode(response.authenticatorData);
  const signature = b64url.decode(response.signature);
  if (!clientDataJSON || !authenticatorData || !signature || credential.type !== 'public-key') throw new Error('malformed credential');
  const rpId = checkClientData(clientDataJSON, 'webauthn.get', challenge, allowedOrigin);
  const auth = parseAuthData(authenticatorData);
  if (!auth.rpIdHash.equals(sha256(rpId))) throw new Error('relying party does not match');
  if (!auth.userPresent) throw new Error('user not present');
  const signed = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
  if (!verifySignature(stored.jwk, signed, signature)) throw new Error('signature does not verify');
  if ((auth.signCount || stored.signCount) && auth.signCount <= stored.signCount) throw new Error('sign count did not advance');
  return { signCount: auth.signCount };
}
