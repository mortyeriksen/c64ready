// Spec tests for passkey accounts (server/accounts.mjs, server/webauthn.mjs,
// server/db.mjs). A software authenticator makes real P-256 and Ed25519
// credentials and signs real assertions, so every check below is the
// relying party's duty from WebAuthn Level 2: §7.1 (registration) and §7.2
// (authentication), plus CBOR from RFC 8949 and COSE keys from RFC 9053.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccounts, imageInfo } from '../../server/accounts.mjs';
import { authenticator, cbor } from './_authenticator.js';

const b64 = (b) => Buffer.from(b).toString('base64url');
const sha256 = (d) => crypto.createHash('sha256').update(d).digest();
import { openDatabase, SCHEMA_VERSION } from '../../server/db.mjs';
import { cborDecode, parseAuthData, coseToJwk } from '../../server/webauthn.mjs';

let testNo = 0, failing = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (!current.length) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    failing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of current) console.log(`     - ${m}`);
    current = [];
  }
}

// ── The server under test ──────────────────────────────────────────────────
const ORIGIN = 'https://c64ready.com';
let clock = 1_700_000_000_000;
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c64acct-'));
const dbPath = path.join(dbDir, 'c64ready.db');
let db = openDatabase(dbPath);
// One trusted proxy, so each request's X-Forwarded-For address is the one counted.
let accounts = createAccounts({ db, origins: [ORIGIN], trustProxy: 1, now: () => clock, blockedWords: ['badword'] });
const server = http.createServer((req, res) => { if (!accounts.handleRequest(req, res)) res.writeHead(404).end(); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
let ip = 1;
async function api(method, url, { body, token, origin = ORIGIN, from } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': from ?? `10.0.0.${ip}` };
  if (origin) headers.Origin = origin;
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.status === 204 ? null : await r.json(), headers: r.headers };
}
// Each step from its own address, so the per-address limit only bites where tested.
const fresh = () => { ip++; };

async function register(name, auth, opts = {}) {
  fresh();
  const o = await api('POST', '/api/auth/register/options', { body: { name } });
  if (o.status !== 200) return { options: o };
  const { id, cred } = auth.create(o.body.publicKey, { origin: ORIGIN, ...opts });
  const v = await api('POST', '/api/auth/register/verify', { body: { challengeId: o.body.challengeId, credential: cred } });
  return { options: o, verify: v, credId: id };
}
async function login(auth, credId, opts = {}) {
  fresh();
  const o = await api('POST', '/api/auth/login/options', { body: {} });
  const cred = auth.get(credId, o.body.publicKey, { origin: ORIGIN, ...opts });
  return api('POST', '/api/auth/login/verify', { body: { challengeId: o.body.challengeId, credential: cred } });
}

// 1. CBOR decoding (RFC 8949 Appendix A examples).
{
  const hex = (h) => Buffer.from(h, 'hex');
  expect(cborDecode(hex('00')).value === 0 && cborDecode(hex('17')).value === 23 && cborDecode(hex('1818')).value === 24, 'small unsigned integers');
  expect(cborDecode(hex('1903e8')).value === 1000 && cborDecode(hex('1a000f4240')).value === 1000000, 'two- and four-byte unsigned integers');
  expect(cborDecode(hex('20')).value === -1 && cborDecode(hex('3863')).value === -100, 'negative integers');
  expect(cborDecode(hex('4401020304')).value.equals(hex('01020304')), 'a byte string');
  expect(cborDecode(hex('6449455446')).value === 'IETF', 'a text string');
  expect(JSON.stringify(cborDecode(hex('83010203')).value) === '[1,2,3]', 'an array');
  const m = cborDecode(hex('a201020304')).value;
  expect(m instanceof Map && m.get(1) === 2 && m.get(3) === 4, 'a map');
  expect(cborDecode(hex('f4')).value === false && cborDecode(hex('f5')).value === true && cborDecode(hex('f6')).value === null, 'false, true, null');
  let threw = false; try { cborDecode(hex('5f')); } catch { threw = true; }
  expect(threw, 'indefinite lengths (never sent by authenticators) are refused');
  ok('CBOR: RFC 8949 Appendix A values decode');
}

// 2. Authenticator data and COSE keys (WebAuthn §6.1, RFC 9053).
{
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
  const id = crypto.randomBytes(20);
  const ad = Buffer.concat([sha256('c64ready.com'), Buffer.from([0x45]), Buffer.from([0, 0, 0, 7]), Buffer.alloc(16), Buffer.from([0, 20]), id, cbor(cose)]);
  const p = parseAuthData(ad);
  expect(p.userPresent && p.userVerified && p.signCount === 7, 'flags UP (bit 0), UV (bit 2) and the big-endian sign count');
  expect(p.credentialId.equals(id), 'the credential id follows the AAGUID and its 2-byte length');
  const out = coseToJwk(p.coseKey);
  expect(out && out.kty === 'EC' && out.crv === 'P-256' && out.x === jwk.x && out.y === jwk.y, 'an EC2 P-256 COSE key (kty 2, alg -7, crv 1) becomes its JWK');
  expect(coseToJwk(new Map([[1, 2], [3, -35], [-1, 2]])) === null, 'an algorithm the options never offered (ES384) is not accepted');
  ok('authenticator data and COSE keys parse');
}

// 3. Registration (§7.1).
const alice = authenticator('p256');
const first = await register('Alice', alice);
{
  const pk = first.options.body?.publicKey;
  expect(first.options.status === 200 && typeof pk?.challenge === 'string' && Buffer.from(pk.challenge, 'base64url').length >= 16, 'options carry a random challenge of at least 16 bytes (§13.4.3)');
  expect(pk?.attestation === 'none' && pk?.authenticatorSelection?.residentKey === 'required', 'no attestation asked for, and a discoverable credential (a passkey)');
  expect(pk?.pubKeyCredParams?.map((p) => p.alg).join() === '-7,-8,-257', 'ES256, EdDSA and RS256 offered');
  expect(pk?.rp && !('id' in pk.rp), 'the relying party id is left to the page (its own host)');
  expect(first.verify.status === 200 && typeof first.verify.body.token === 'string' && first.verify.body.user.name === 'Alice', 'a good registration creates the account and signs it in');
  const me = await api('GET', '/api/me', { token: first.verify.body.token });
  expect(me.status === 200 && me.body.user.name === 'Alice', 'the session token identifies the account');
  ok('registration: a passkey creates an account and a session');
}
{
  const ed = authenticator('ed25519');
  const r = await register('Edna', ed);
  expect(r.verify.status === 200, `an Ed25519 passkey registers (got ${r.verify.status} ${r.verify.body?.error})`);
  const l = await login(ed, r.credId);
  expect(l.status === 200 && l.body.user.name === 'Edna', 'and signs in');
  ok('EdDSA passkeys work as well as ES256');
}
{
  const bob = authenticator();
  const cases = [
    ['a challenge it was not given', { challenge: Buffer.alloc(32).toString('base64url') }],
    ['an origin outside the allowed sites', { origin: 'https://evil.example', rpId: 'c64ready.com' }],
    ['a relying-party hash for another domain', { rpId: 'evil.example' }],
    ['the user-present flag clear', { up: false }],
    ['a credential id that does not match the attested one', { idOverride: crypto.randomBytes(16) }],
    ['a get (sign-in) client data type', { type: 'webauthn.get' }],
  ];
  for (const [i, [what, opts]] of cases.entries()) {
    const r = await register(`Bob${i}`, bob, opts);
    expect(r.verify?.status === 400, `refused: ${what} (got ${r.verify?.status ?? `options ${r.options.status}`})`);
  }
  ok('registration refuses every failed §7.1 check');
}
{
  fresh();
  const o = await api('POST', '/api/auth/register/options', { body: { name: 'Carol' } });
  const { cred } = authenticator().create(o.body.publicKey, { origin: ORIGIN });
  const v1 = await api('POST', '/api/auth/register/verify', { body: { challengeId: o.body.challengeId, credential: cred } });
  const v2 = await api('POST', '/api/auth/register/verify', { body: { challengeId: o.body.challengeId, credential: cred } });
  expect(v1.status === 200 && v2.status === 400, 'a challenge is good once');
  fresh();
  const late = await api('POST', '/api/auth/register/options', { body: { name: 'Dave' } });
  clock += 6 * 60_000;
  const { cred: c2 } = authenticator().create(late.body.publicKey, { origin: ORIGIN });
  const v3 = await api('POST', '/api/auth/register/verify', { body: { challengeId: late.body.challengeId, credential: c2 } });
  expect(v3.status === 400, 'and expires after five minutes');
  ok('challenges are single-use and short-lived');
}
{
  fresh();
  const taken = await api('POST', '/api/auth/register/options', { body: { name: 'ALICE' } });
  const reserved = await api('POST', '/api/auth/register/options', { body: { name: 'SysOp' } });
  const blocked = await api('POST', '/api/auth/register/options', { body: { name: 'badword' } });
  const empty = await api('POST', '/api/auth/register/options', { body: { name: '   ' } });
  const long = await api('POST', '/api/auth/register/options', { body: { name: 'x'.repeat(17) } });
  expect(taken.status === 409, 'a name already taken, in any case, is refused');
  expect(reserved.status === 400 && blocked.status === 400, 'reserved and blocked names are refused');
  const wide = await api('POST', '/api/auth/register/options', { body: { name: 'ＳＹＳＯＰ' } });
  expect(wide.status === 400, 'a reserved name in fullwidth letters is reserved too');
  expect(empty.status === 400 && long.status === 400, 'names follow the chat nickname limits (1 to 16)');
  ok('account names: unique ignoring case, never reserved or blocked');
}

// 4. Authentication (§7.2).
{
  const l = await login(alice, first.credId);
  expect(l.status === 200 && l.body.user.name === 'Alice' && typeof l.body.token === 'string', 'a good assertion signs in');
  const bad = await login(alice, first.credId, { tamper: true });
  expect(bad.status === 401, 'a signature that does not verify is refused');
  const clone = await login(alice, first.credId, { count: 1 });
  expect(clone.status === 401, 'a sign count that does not advance (a possible clone, §7.2 step 21) is refused');
  const wrongRp = await login(alice, first.credId, { rpId: 'evil.example' });
  expect(wrongRp.status === 401, 'an assertion for another relying party is refused');
  const noUp = await login(alice, first.credId, { up: false });
  expect(noUp.status === 401, 'an assertion without user presence is refused');
  const wrongType = await login(alice, first.credId, { type: 'webauthn.create' });
  expect(wrongType.status === 401, 'a create client data type is refused');
  const otherHandle = await login(alice, first.credId, { userHandle: Buffer.from('somebody else').toString('base64url') });
  expect(otherHandle.status === 401, 'a user handle that is not the passkey owner\'s is refused (§7.2 step 6)');
  fresh();
  const o = await api('POST', '/api/auth/login/options', { body: {} });
  const unknown = await api('POST', '/api/auth/login/verify', { body: { challengeId: o.body.challengeId, credential: { id: 'nope', type: 'public-key', response: {} } } });
  expect(unknown.status === 401, 'an unregistered passkey is refused');
  expect(o.body.publicKey.allowCredentials.length === 0, 'sign-in asks for any passkey for this site (discoverable)');
  ok('authentication: §7.2 checks, including the clone guard');
}

// 5. Sessions: sign out, expiry, account deletion.
{
  const l = await login(alice, first.credId);
  const token = l.body.token;
  const out = await api('POST', '/api/auth/logout', { token });
  const after = await api('GET', '/api/me', { token });
  expect(out.status === 200 && after.status === 401, 'signing out ends the session');
  const l2 = await login(alice, first.credId);
  clock += 181 * 24 * 3600_000;
  expect((await api('GET', '/api/me', { token: l2.body.token })).status === 401, 'a session ends after 180 days');
  const anon = await api('GET', '/api/me');
  expect(anon.status === 401, 'no token, no account');
  ok('sessions end on sign-out and after 180 days');
}
{
  const l = await login(alice, first.credId);
  const del = await api('DELETE', '/api/me', { token: l.body.token });
  expect(del.status === 200, 'an account can be deleted by its owner');
  expect((await api('GET', '/api/me', { token: l.body.token })).status === 401, 'its sessions go with it');
  expect((await login(alice, first.credId)).status === 401, 'and its passkeys');
  const again = await register('Alice', authenticator());
  expect(again.verify.status === 200, 'the name is free again');
  ok('deleting an account removes its passkeys and sessions');
}

// 6. Origins, CORS and limits.
{
  const evil = await api('GET', '/api/me', { origin: 'https://evil.example' });
  expect(evil.status === 403, 'a page from another site may not call the API');
  const local = await api('POST', '/api/auth/login/options', { origin: 'http://localhost:5173', body: {} });
  expect(local.status === 403, 'nor may a page on this computer, unless the server allows it');
  const dev = createAccounts({ db, origins: [ORIGIN], allowLoopback: true, trustProxy: 1, now: () => clock });
  const devServer = http.createServer((req, res) => { if (!dev.handleRequest(req, res)) res.writeHead(404).end(); });
  await new Promise((r) => devServer.listen(0, '127.0.0.1', r));
  const devAsk = await fetch(`http://127.0.0.1:${devServer.address().port}/api/auth/login/options`, { method: 'POST', headers: { Origin: 'http://localhost:5173', 'X-Forwarded-For': '10.8.8.8', 'Content-Type': 'application/json' }, body: '{}' });
  expect(devAsk.status === 200, 'with allowLoopback (the dev server), a page on this computer may');
  dev.close(); devServer.close();
  const pre = await fetch(`${base}/api/me`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  expect(pre.status === 204 && pre.headers.get('access-control-allow-origin') === ORIGIN && /authorization/i.test(pre.headers.get('access-control-allow-headers') || ''), 'the CORS preflight allows the bearer header for an allowed origin');
  const res = await api('GET', '/api/me');
  expect(res.headers.get('access-control-allow-origin') === ORIGIN && res.headers.get('cache-control') === 'no-store', 'answers name their origin and are never cached');
  let limited = 0;
  for (let i = 0; i < 25; i++) if ((await api('POST', '/api/auth/login/options', { body: {}, from: '10.9.9.9' })).status === 429) limited++;
  expect(limited > 0, 'sign-in attempts from one address are rate limited');
  ok('origins, CORS and rate limits');
}

// 8. More passkeys, and the recovery code.
{
  const CODE = /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/;
  const rita = authenticator('p256');
  const reg = await register('Rita', rita);
  const token = reg.verify.body.token;
  const code1 = reg.verify.body.recoveryCode;
  expect(CODE.test(code1 ?? ''), `signing up hands out a recovery code of 20 base32 characters (got ${code1})`);
  const row = db.prepare("SELECT recovery_hash FROM users WHERE name = 'Rita'").get();
  expect(/^[0-9a-f]{64}$/.test(row.recovery_hash) && !row.recovery_hash.includes(code1.replace(/-/g, '')), 'the server keeps only its hash');
  expect((await api('GET', '/api/me/passkeys')).status === 401, 'the passkey list needs a session');
  const list1 = await api('GET', '/api/me/passkeys', { token });
  expect(list1.body.passkeys.length === 1 && list1.body.passkeys[0].id === reg.credId, 'the account lists its passkey');
  expect((await api('POST', '/api/me/passkeys/delete', { token, body: { id: reg.credId } })).status === 409, 'the last passkey cannot be removed');

  fresh();
  const addOpts = await api('POST', '/api/me/passkeys/options', { token, body: {} });
  expect(addOpts.body.publicKey.excludeCredentials.some((c) => c.id === reg.credId), 'adding a passkey leaves out the ones the account has');
  expect(addOpts.body.publicKey.user.id === reg.options.body.publicKey.user.id, 'and makes it for the same account handle');
  const second = authenticator('ed25519');
  const made = second.create(addOpts.body.publicKey, { origin: ORIGIN });
  const added = await api('POST', '/api/me/passkeys/verify', { token, body: { challengeId: addOpts.body.challengeId, credential: made.cred } });
  expect(added.status === 200 && added.body.passkeys.length === 2, 'a second passkey is added');
  const viaSecond = await login(second, made.id);
  expect(viaSecond.status === 200 && viaSecond.body.user.name === 'Rita', 'and signs in to the same account');
  const removed = await api('POST', '/api/me/passkeys/delete', { token, body: { id: reg.credId } });
  expect(removed.status === 200 && removed.body.passkeys.length === 1, 'with two, one can be removed');
  expect((await login(rita, reg.credId)).status === 401, 'a removed passkey no longer signs in');
  const other = await register('Otto', authenticator('p256'));
  expect((await api('POST', '/api/me/passkeys/delete', { token: other.verify.body.token, body: { id: made.id } })).status === 404, 'nobody removes another account\'s passkey');
  ok('an account can have several passkeys, and keeps at least one');

  const recoverOpts = (name, c) => { fresh(); return api('POST', '/api/auth/recover/options', { body: { name, code: c } }); };
  const wrongName = await recoverOpts('Nobody', code1);
  const wrongCode = await recoverOpts('Rita', 'AAAAA-AAAAA-AAAAA-AAAAA');
  expect(wrongName.status === 401 && wrongCode.status === 401 && wrongName.body.error === wrongCode.body.error, 'a wrong name and a wrong code get the same answer');
  const sloppy = code1.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
  const ro = await recoverOpts('rita', sloppy);
  expect(ro.status === 200, 'the code is read forgiving case, spaces and look-alike letters, and the name its case');
  const third = authenticator('p256');
  const rc = third.create(ro.body.publicKey, { origin: ORIGIN });
  fresh();
  const recovered = await api('POST', '/api/auth/recover/verify', { body: { challengeId: ro.body.challengeId, credential: rc.cred } });
  const code2 = recovered.body.recoveryCode;
  expect(recovered.status === 200 && recovered.body.user.name === 'Rita' && typeof recovered.body.token === 'string', 'the right name and code add a passkey and sign in');
  expect(CODE.test(code2 ?? '') && code2 !== code1, 'and hand out a new code');
  expect((await recoverOpts('Rita', code1)).status === 401, 'the used code no longer works');
  expect((await login(third, rc.id)).status === 200, 'the new passkey signs in');
  ok('a recovery code adds a passkey on a new device, once');

  // Wrong codes lock out the address that sent them, for an hour, with the answer a wrong name gets.
  const fromA = { from: '10.9.9.1' };
  const recoverFrom = (name, c, o) => api('POST', '/api/auth/recover/options', { body: { name, code: c }, ...o });
  for (let i = 0; i < 5; i++) await recoverFrom('Rita', 'BBBBB-BBBBB-BBBBB-BBBBB', fromA);
  const locked = await recoverFrom('Rita', code2, fromA);
  expect(locked.status === 401 && locked.body.error === wrongName.body.error, 'five wrong codes lock that address out, saying no more than a wrong name does');
  expect((await recoverOpts('Rita', code2)).status === 200, 'while the owner, elsewhere, can still recover');
  clock += 3600_000;
  expect((await recoverFrom('Rita', code2, fromA)).status === 200, 'for an hour');
  ok('wrong codes lock out the guesser for an hour, never the owner, and reveal no name');

  // Changing the account needs a passkey's confirmation from the last ten minutes.
  const tok = recovered.body.token;   // confirmed by the recovery, an hour ago now
  for (const [m, u, b] of [['POST', '/api/me/recovery', {}], ['POST', '/api/me/passkeys/options', {}], ['POST', '/api/me/passkeys/delete', { id: 'x' }], ['DELETE', '/api/me', null]]) {
    expect((await api(m, u, { token: tok, body: b })).status === 403, `${m} ${u} needs a recent confirmation, not just the session token`);
  }
  fresh();
  const co = await api('POST', '/api/me/confirm/options', { token: tok, body: {} });
  fresh();
  const confirmedNow = await api('POST', '/api/me/confirm/verify', { token: tok, body: { challengeId: co.body.challengeId, credential: third.get(rc.id, co.body.publicKey, { origin: ORIGIN }) } });
  expect(confirmedNow.status === 200, 'the account\'s passkey confirms the session');
  const fresher = await api('POST', '/api/me/recovery', { token: tok, body: {} });
  expect(CODE.test(fresher.body.recoveryCode ?? '') && fresher.body.recoveryCode !== code2, 'then a signed-in account can make a new code');
  expect((await recoverOpts('Rita', code2)).status === 401 && (await recoverOpts('Rita', fresher.body.recoveryCode)).status === 200, 'which replaces the old one');
  ok('account changes need a recent passkey confirmation');

  // A recovery begun with a code that is then replaced adds no passkey.
  const pending = await recoverOpts('Rita', fresher.body.recoveryCode);
  const newer = await api('POST', '/api/me/recovery', { token: tok, body: {} });
  const late = authenticator('p256').create(pending.body.publicKey, { origin: ORIGIN });
  fresh();
  const lateVerify = await api('POST', '/api/auth/recover/verify', { body: { challengeId: pending.body.challengeId, credential: late.cred } });
  expect(newer.status === 200 && lateVerify.status >= 400 && lateVerify.status < 500, 'a recovery whose code was replaced meanwhile is refused');
  expect((await recoverOpts('Rita', newer.body.recoveryCode)).status === 200, 'and the code the owner saved still works');

  // Two recoveries begun with one code: the first to finish wins, the other adds nothing.
  const one = await recoverOpts('Rita', newer.body.recoveryCode);
  const two = await recoverOpts('Rita', newer.body.recoveryCode);
  const credOne = authenticator('p256').create(one.body.publicKey, { origin: ORIGIN });
  const credTwo = authenticator('p256').create(two.body.publicKey, { origin: ORIGIN });
  fresh();
  const winner = await api('POST', '/api/auth/recover/verify', { body: { challengeId: one.body.challengeId, credential: credOne.cred } });
  fresh();
  const loser = await api('POST', '/api/auth/recover/verify', { body: { challengeId: two.body.challengeId, credential: credTwo.cred } });
  expect(winner.status === 200 && loser.status >= 400 && loser.status < 500, 'of two recoveries with one code, only the first adds a passkey');
  expect((await recoverOpts('Rita', winner.body.recoveryCode)).status === 200 && (await recoverOpts('Rita', newer.body.recoveryCode)).status === 401, 'and only the code it handed out works');
  ok('a replaced recovery code cannot finish a recovery');
}

// 6b. A profile picture: a PNG, JPEG or WebP of at most 256x256, public at its own address.
{
  const png = (w, h) => { const b = Buffer.alloc(64); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
  const jpeg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, ...Array(30).fill(0)]);
  expect(JSON.stringify(imageInfo(png(200, 120))) === '{"type":"image/png","width":200,"height":120}', 'a PNG is read from its header');
  expect(JSON.stringify(imageInfo(jpeg(64, 48))) === '{"type":"image/jpeg","width":64,"height":48}', 'and a JPEG from its frame header');
  expect(imageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>')) === null, 'an SVG, or anything else, is no picture');
  const pic = await register('Pia', authenticator('p256'));
  const tok = pic.verify.body.token;
  expect(pic.verify.body.user.avatar === 0, 'a new account has no picture');
  const put = (b) => api('POST', '/api/me/avatar', { token: tok, body: { data: b.toString('base64') } });
  expect((await put(png(300, 200))).status === 400, 'a picture over 256x256 is refused');
  expect((await put(Buffer.from('not a picture at all, just some text here'))).status === 400, 'so is a file that is not one');
  expect((await put(Buffer.alloc(100 * 1024, 1))).status >= 400, 'and one too large');
  expect((await api('POST', '/api/me/avatar', { body: { data: png(64, 64).toString('base64') } })).status === 401, 'setting one needs an account');
  const set = await put(png(64, 64));
  expect(set.status === 200 && set.body.user.avatar > 0, 'a small PNG is the picture, with a version');
  const got = await fetch(`${base}/api/users/${set.body.user.id}/avatar?v=${set.body.user.avatar}`);
  const bytes = Buffer.from(await got.arrayBuffer());
  expect(got.status === 200 && got.headers.get('content-type') === 'image/png' && bytes.equals(png(64, 64)), 'it is served as itself, with its type');
  expect(got.headers.get('x-content-type-options') === 'nosniff' && /default-src 'none'/.test(got.headers.get('content-security-policy') || ''), 'never sniffed, and never runs anything');
  const again = await put(jpeg(128, 128));
  expect(again.body.user.avatar > set.body.user.avatar, 'a new picture gets a new version, so caches fetch it');
  expect((await api('GET', `/api/me`, { token: tok })).body.user.avatar === again.body.user.avatar, 'the account says which');
  const off = await api('POST', '/api/me/avatar/delete', { token: tok, body: {} });
  expect(off.body.user.avatar === 0 && (await fetch(`${base}/api/users/${set.body.user.id}/avatar`)).status === 404, 'removing it leaves no picture');
  await put(png(32, 32));
  accounts.removePicture(set.body.user.id);
  expect((await fetch(`${base}/api/users/${set.body.user.id}/avatar`)).status === 404, 'and the admin can take one down');
  ok('a profile picture is a small PNG, JPEG or WebP, and nothing else');
}

// 6c. Sign-in challenges are capped per address and never run out for everyone; reads are limited per address.
{
  const tight = createAccounts({ db, origins: [ORIGIN], trustProxy: 1, now: () => clock, limits: { challengesPerAddress: 3, maxChallenges: 6, readRate: 1, readBurst: 3 } });
  const tightServer = http.createServer((req, res) => { if (!tight.handleRequest(req, res)) res.writeHead(404).end(); });
  await new Promise((r) => tightServer.listen(0, '127.0.0.1', r));
  const at = (method, url, from) => fetch(`http://127.0.0.1:${tightServer.address().port}${url}`, { method, headers: { Origin: ORIGIN, 'X-Forwarded-For': from, 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
  const asks = [];
  for (let i = 0; i < 4; i++) asks.push((await at('POST', '/api/auth/login/options', '10.7.0.1')).status);
  expect(asks.join() === '200,200,200,429', `one address holds at most its share of sign-in challenges (got ${asks})`);
  const others = [];
  for (let i = 2; i <= 6; i++) others.push((await at('POST', '/api/auth/login/options', `10.7.0.${i}`)).status);
  expect(others.every((st) => st === 200), `a full store makes room by dropping the oldest, so other addresses still sign in (got ${others})`);
  const reads = [];
  for (let i = 0; i < 4; i++) reads.push((await at('GET', '/api/me', '10.7.1.1')).status);
  expect(reads.slice(0, 3).every((st) => st !== 429) && reads[3] === 429, `reads from one address are rate limited (got ${reads})`);
  expect((await at('GET', '/api/me', '10.7.1.2')).status !== 429, 'and another address is not touched');
  const badges = [];
  for (let i = 0; i < 6; i++) badges.push((await at('GET', '/api/users/1/avatar', '10.7.1.1')).status);
  expect(badges.every((st) => st !== 429), `badges are not counted, since a list shows many at once (got ${badges})`);
  tight.close(); tightServer.close();
  ok('sign-in challenges are capped per address and never run out for everyone; reads are limited per address');
}

// 6d. At most ten new accounts from one address an hour.
{
  const from = '10.6.0.1';
  const signUpFrom = async (name, addr) => {
    const o = await api('POST', '/api/auth/register/options', { body: { name }, from: addr });
    if (o.status !== 200) return o.status;
    const { cred } = authenticator().create(o.body.publicKey, { origin: ORIGIN });
    return (await api('POST', '/api/auth/register/verify', { body: { challengeId: o.body.challengeId, credential: cred }, from: addr })).status;
  };
  const got = [];
  for (let i = 1; i <= 10; i++) { got.push(await signUpFrom(`Cap${i}`, from)); clock += 1000; }
  expect(got.every((st) => st === 200), `ten sign-ups from one address go through (got ${got})`);
  expect(await signUpFrom('Cap11', from) === 429, 'the eleventh within the hour is refused');
  expect(await signUpFrom('Cap12', '10.6.0.2') === 200, 'another address is not touched');
  clock += 3600_000;
  expect(await signUpFrom('Cap13', from) === 200, 'an hour later the address may sign up again');
  ok('at most ten new accounts from one address an hour');
}

// 7. The database keeps accounts across restarts.
{
  accounts.close(); db.close();
  db = openDatabase(dbPath);
  accounts = createAccounts({ db, origins: [ORIGIN], now: () => clock });
  const ver = db.prepare('PRAGMA user_version').get().user_version;
  const names = db.prepare('SELECT name FROM users ORDER BY id').all().map((r) => r.name);
  expect(ver === SCHEMA_VERSION, `the schema version is recorded (got ${ver}, want ${SCHEMA_VERSION})`);
  expect(names.includes('Edna') && names.includes('Alice'), 'accounts survive a restart');
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  expect(!cols.includes('recovery_failures') && !cols.includes('recovery_locked_until') && cols.includes('recovery_hash'), `no unused recovery columns are left (got ${cols})`);
  ok('the database persists and migrates once');
}

accounts.close();
server.close();
db.close();
fs.rmSync(dbDir, { recursive: true, force: true });
if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - accounts: ${testNo} passkey, session and API checks`);
