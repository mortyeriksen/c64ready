// test/chat/_authenticator.js — a software passkey authenticator for the
// server specs: discoverable credentials, made and used as a browser would,
// with knobs to break each rule the server checks.
import crypto from 'node:crypto';

// ── A minimal CBOR encoder (RFC 8949, canonical lengths) for the authenticator ──
export function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: unsupported');
}
const b64 = (b) => Buffer.from(b).toString('base64url');
const sha256 = (d) => crypto.createHash('sha256').update(d).digest();

/** A software authenticator holding discoverable credentials. */
export function authenticator(kind = 'p256') {
  const creds = new Map();
  return {
    create(options, { origin, rpId = new URL(origin).hostname, up = true, idOverride, type = 'webauthn.create', challenge } = {}) {
      const pair = kind === 'ed25519' ? crypto.generateKeyPairSync('ed25519') : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const jwk = pair.publicKey.export({ format: 'jwk' });
      const cose = kind === 'ed25519'
        ? new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x, 'base64url')]])
        : new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
      const credId = crypto.randomBytes(16);
      const flags = (up ? 0x01 : 0) | 0x04 | 0x40;
      const authData = Buffer.concat([sha256(rpId), Buffer.from([flags]), Buffer.from([0, 0, 0, 0]), Buffer.alloc(16), Buffer.from([0, credId.length]), credId, cbor(cose)]);
      const clientData = Buffer.from(JSON.stringify({ type, challenge: challenge ?? options.challenge, origin, crossOrigin: false }));
      const id = b64(idOverride ?? credId);
      creds.set(b64(credId), { pair, kind, count: 0, userHandle: options.user.id });
      return { id: b64(credId), cred: { id, rawId: id, type: 'public-key', response: { clientDataJSON: b64(clientData), attestationObject: b64(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))), transports: ['internal'] } } };
    },
    get(credId, options, { origin, rpId = new URL(origin).hostname, up = true, count, tamper = false, userHandle, type = 'webauthn.get' } = {}) {
      const c = creds.get(credId);
      c.count = count ?? c.count + 1;
      const counter = Buffer.alloc(4); counter.writeUInt32BE(c.count);
      const authData = Buffer.concat([sha256(rpId), Buffer.from([(up ? 0x01 : 0) | 0x04]), counter]);
      const clientData = Buffer.from(JSON.stringify({ type, challenge: options.challenge, origin, crossOrigin: false }));
      const signed = Buffer.concat([authData, sha256(clientData)]);
      let sig = c.kind === 'ed25519' ? crypto.sign(null, signed, c.pair.privateKey) : crypto.sign('sha256', signed, c.pair.privateKey);
      if (tamper) sig = Buffer.from(sig.map((x, i) => (i === sig.length - 1 ? x ^ 1 : x)));
      return { id: credId, rawId: credId, type: 'public-key', response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(sig), userHandle: userHandle ?? c.userHandle } };
    },
  };
}

