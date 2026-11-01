// The chat server (server/chat.mjs) with real WebSocket clients on a real
// listener and a clock the test drives. Each check is one rule of the design:
// chatting needs an account and the account's name is the name in the chat
// (accounts are stubbed here: the token "acct:Ann" is the account Ann; the
// real lookup is server/accounts.mjs); there is one channel, which every
// session joins on hello and which never closes; the server sets every
// author; a message can mention games with achievements; unlocks and new bests are announced;
// members vote a member out for an hour, counted by address; limits hold;
// bans act on the client address behind the trusted proxy; the log keeps
// every message with its IP address for the retention period; and the admin
// console needs its passkey, its cookie and its own origin.

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatLog } from '../../server/log.mjs';
import { createNotifier } from '../../server/notify.mjs';
import { createChatServer, DEFAULTS } from '../../server/chat.mjs';
import { clientAddress, addressKey } from '../../server/address.mjs';
import { PROTOCOL, cleanText, cleanName, cleanMentions, mentions } from '../../server/protocol.mjs';
import { openDatabase } from '../../server/db.mjs';
import { createAdminPasskeys } from '../../server/admin-passkeys.mjs';
import { newSetupKey, setupKeyHash } from '../../server/admin.mjs';
import { authenticator } from './_authenticator.js';

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

let clock = 1_700_000_000_000;
const notified = [];
const SETUP_KEY = newSetupKey();
const adminPasskeys = createAdminPasskeys({ db: openDatabase(':memory:') });
const signedOut = new Set();   // account tokens signed out since they said hello
const accountIds = new Map();
const accountId = (name) => { if (!accountIds.has(name)) accountIds.set(name, accountIds.size + 1); return accountIds.get(name); };
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c64chat-log-'));
const chatLog = createChatLog({ dir: logDir, now: () => clock });
const readLog = (dir = logDir) => fs.readdirSync(dir).sort().flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const chat = createChatServer({
  chatLog,
  origins: ['https://c64ready.com'],
  trustProxy: 1,
  admin: { passkeys: adminPasskeys, setupKeySha256: setupKeyHash(SETUP_KEY), keyUsed: adminPasskeys.keyUsed, useKey: adminPasskeys.useKey },
  notify: (t) => notified.push(t),
  blockedWords: ['frak'],
  authenticate: (token) => (/^acct:\w+$/.test(token) && !signedOut.has(token) ? { id: accountId(token.slice(5)), name: token.slice(5) } : null),
  // The games with achievements a message may mention.
  findGame: (id) => ({ uridium: { id: 'uridium', title: 'Uridium' }, 'bomb-jack': { id: 'bomb-jack', title: 'Bomb Jack' } })[id] ?? null,
  now: () => clock,
  manualClock: true,
});
const server = http.createServer((req, res) => { if (!chat.handleRequest(req, res)) res.writeHead(404).end(); });
server.on('upgrade', (req, sock, head) => { if (!chat.handleUpgrade(req, sock, head)) sock.destroy(); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const advance = (ms) => { clock += ms; chat.tick(); };

let ipNo = 1;
const freshIp = () => `203.0.113.${ipNo++}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client({ path = '/chat', ip = freshIp(), headers = {} } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`, { headers: { 'x-forwarded-for': `198.51.100.9, ${ip}`, ...headers } });
  const c = { ws, ip, events: [], waiters: [], nextId: 1, closeCode: null };
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    const w = c.waiters.findIndex((x) => x.pred(m));
    if (w >= 0) { const [x] = c.waiters.splice(w, 1); x.resolve(m); } else c.events.push(m);
  });
  c.closed = new Promise((r) => ws.addEventListener('close', (e) => { c.closeCode = e.code; r(e.code); }));
  c.opened = new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.next = (pred, ms = 1000) => {
    const i = c.events.findIndex(pred);
    if (i >= 0) return Promise.resolve(c.events.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const x = { pred, resolve };
      c.waiters.push(x);
      setTimeout(() => { const at = c.waiters.indexOf(x); if (at >= 0) { c.waiters.splice(at, 1); reject(new Error('timed out waiting for an event')); } }, ms);
    });
  };
  c.req = (t, fields = {}) => { const id = c.nextId++; c.send({ t, id, ...fields }); return c.next((m) => (m.t === 'ok' || m.t === 'err') && m.id === id); };
  c.drop = () => { c.events.length = 0; };
  return c;
}
// A client signed in as the account `as` (a fresh one by default); a chat
// token resumes that session, under the account it belongs to.
let guestNo = 1;
const tokenAccount = new Map();
async function guest(opts = {}) {
  const c = client(opts);
  await c.opened;
  const as = opts.as ?? tokenAccount.get(opts.token) ?? `Guest${guestNo++}`;
  c.send({ t: 'hello', v: PROTOCOL, token: opts.token, account: `acct:${as}` });
  const w = await c.next((m) => m.t === 'welcome');
  c.token = w.token; c.id = w.id; c.welcome = w; c.as = as;
  tokenAccount.set(w.token, as);
  return c;
}
// Each block starts with an empty channel: whoever an earlier block left
// behind is gone once the grace period has passed. Players get names of their
// own, since a vote keeps an account out for an hour.
async function settle() { await sleep(40); advance(DEFAULTS.graceMs); }
let crowd = 0;
async function channelWith(n) {
  await settle();
  const tag = `C${++crowd}p`;
  const all = [];
  for (let i = 0; i < n; i++) all.push(await guest({ as: `${tag}${i}` }));
  for (const c of all) c.drop();
  const [first, ...others] = all;
  return { first, others, all };
}
function upgradeStatus(path, headers) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), ...headers,
    } });
    req.on('upgrade', (res, sock) => { sock.destroy(); resolve(101); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.end();
  });
}
function get(path, headers = {}) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PORT, path, headers: { 'x-forwarded-for': '192.0.2.50', ...headers } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
  });
}
// A WebSocket by hand, to send frames no well-behaved client would.
function maskedFrame(opcode, text, { fin = true, rsv = 0 } = {}) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const head = payload.length < 126 ? Buffer.from([(fin ? 0x80 : 0) | rsv | opcode, 0x80 | payload.length])
    : Buffer.from([(fin ? 0x80 : 0) | rsv | opcode, 0x80 | 126, payload.length >> 8, payload.length & 255]);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}
function rawSocket(ip = freshIp()) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, '127.0.0.1');
    const r = { sock, texts: [], closeCode: null, ended: false, buf: Buffer.alloc(0) };
    r.done = new Promise((res) => sock.on('close', () => { r.ended = true; res(); }));
    sock.on('error', () => {});
    let upgraded = false;
    sock.on('data', (d) => {
      r.buf = Buffer.concat([r.buf, d]);
      if (!upgraded) {
        const at = r.buf.indexOf('\r\n\r\n');
        if (at < 0) return;
        if (!/^HTTP\/1\.1 101/.test(r.buf.toString('latin1', 0, at))) { reject(new Error('no upgrade')); return; }
        upgraded = true; r.buf = r.buf.subarray(at + 4); resolve(r);
      }
      while (r.buf.length >= 2) {
        let len = r.buf[1] & 0x7f, off = 2;
        if (len === 126) { len = r.buf.readUInt16BE(2); off = 4; }
        if (r.buf.length < off + len) break;
        const op = r.buf[0] & 0x0f, body = r.buf.subarray(off, off + len);
        if (op === 1) r.texts.push(JSON.parse(body.toString('utf8')));
        if (op === 8) r.closeCode = body.length >= 2 ? body.readUInt16BE(0) : 1005;
        r.buf = r.buf.subarray(off + len);
      }
    });
    sock.write(`GET /chat HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nX-Forwarded-For: ${ip}\r\n\r\n`);
  });
}


// ── Shared rules ─────────────────────────────────────────────────────────────
{
  expect(cleanText('a\u202eb\u0007c') === 'ab c', 'direction overrides are removed and control characters become spaces');
  expect(cleanText('x'.repeat(281)) === null, 'a message longer than 280 characters is refused');
  expect(cleanText('   ') === null, 'an empty message is refused');
  expect(cleanName('Ni\u200bne  Fan', 16) === 'Nine Fan', 'names lose invisible characters and repeated spaces');
  expect(JSON.stringify(cleanMentions(['uridium', 'uridium', 'Bad Id', 7, 'a', 'b', 'c'])) === '["uridium","a","b"]', 'mentions are game ids, each once, at most three');
  expect(mentions('try @BOMB jack now', 'Bomb Jack') && !mentions('try Bomb Jack', 'Bomb Jack'), 'a mention is @ and the title, in any case');
  ok('text, names and mentions are cleaned the same way on both sides');
}
{
  const req = (xff, own = '10.9.9.9') => ({ socket: { remoteAddress: own }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  expect(clientAddress(req('1.1.1.1, 2.2.2.2'), 1) === '2.2.2.2', 'behind one proxy the rightmost forwarded address is the client');
  expect(clientAddress(req('1.1.1.1, 2.2.2.2'), 0) === '10.9.9.9', 'without a trusted proxy the socket address is the client');
  expect(clientAddress(req('not-an-ip'), 1) === '10.9.9.9', 'a forwarded value that is not an address is ignored');
  expect(addressKey('2001:db8:1:2:3:4:5:6') === addressKey('2001:db8:1:2::9'), 'an IPv6 /64 counts as one address');
  expect(addressKey('::ffff:192.0.2.1') === '192.0.2.1', 'an IPv4-mapped address counts as its IPv4 address');
  ok('the client address comes from the trusted proxy hop, and a /64 is one address');
}

// ── Sessions ─────────────────────────────────────────────────────────────────
{
  const c = await guest();
  expect(typeof c.token === 'string' && c.token.length >= 20, 'welcome carries a session token');
  expect(/^[0-9a-f]{8}$/.test(c.id), 'welcome carries a public member id');
  expect(c.welcome.room?.code === 'CHAT', 'a new session is in the channel');
  c.ws.close();
  for (const account of [undefined, 'acct:', 'nobody']) {
    const x = client();
    await x.opened;
    x.send({ t: 'hello', v: PROTOCOL, account });
    expect((await x.next((m) => m.t === 'err')).code === 'SIGN_IN', `a hello without a known account is told to sign in (${account})`);
    expect(await x.closed === 4004, 'and closed');
  }
  ok('hello needs an account, and gives a session for it');
}
{
  const c = await guest({ as: 'Leaver' });
  const other = await guest({ as: 'Stayer' });
  expect((await c.req('say', { text: 'still here' })).t === 'ok', 'a signed-in member speaks');
  signedOut.add('acct:Leaver');
  expect((await c.req('vote', { member: other.id })).code === 'SIGN_IN', 'once the account signs out, any request is refused, a vote too');
  expect(await c.closed === 4004, 'and the socket is closed');
  other.ws.close();
  ok('a socket whose account signed out can do nothing more');
}
{
  const c = client();
  await c.opened;
  c.send({ t: 'lobby', id: 1 });
  expect(await c.closed === 1008, 'a request before hello closes the socket');
  const d = client();
  await d.opened;
  advance(DEFAULTS.helloTimeoutMs);
  expect(await d.closed === 4002, 'a socket that never says hello is closed after the timeout');
  ok('a socket must say hello first, and in time');
}
{
  const a = await guest();
  const b = await guest({ token: a.token });
  expect(b.id === a.id, 'the same token resumes the same session');
  expect((await a.next((m) => m.t === 'replaced')).t === 'replaced', 'the older socket is told it was replaced');
  expect(await a.closed === 4001, 'and closed');
  b.ws.close();
  ok('one socket per session: a new one fences the old');
}

// ── The channel ──────────────────────────────────────────────────────────────
{
  await settle();
  const a = await guest({ as: 'Ann' });
  expect(a.welcome.room?.code === 'CHAT', 'saying hello puts a session in the channel');
  expect(a.welcome.room.owner === null, 'the channel has no host');
  const b = await guest({ as: 'Ben' });
  const seen = await a.next((m) => m.t === 'room' && m.room.members.some((x) => x.id === b.id));
  const ben = seen.room.members.find((x) => x.id === b.id);
  expect(ben?.nick === 'Ben' && ben.uid === accountId('Ben'), 'members see a newcomer by account name');
  expect(!a.events.some((m) => m.t === 'notice'), 'arriving is not announced in the messages');
  b.ws.close();
  await b.closed;
  expect(!!await a.next((m) => m.t === 'room' && m.room.members.some((x) => x.id === b.id && !x.here)), 'a dropped member shows as away during the grace period');
  const back = await guest({ token: b.token });
  expect(back.id === b.id && back.welcome.room?.code === 'CHAT', 'reconnecting within the grace period resumes the place');
  await back.req('leave');
  expect(!!await a.next((m) => m.t === 'room' && !m.room.members.some((x) => x.id === b.id)), 'leaving takes the member out at once');
  expect((await back.req('join')).t === 'ok', 'and joining puts them back');
  const twin = await guest({ as: 'Ann' });
  expect(twin.welcome.room === null && twin.welcome.elsewhere === true, 'the same account on a second session is kept out, and told why');
  expect((await twin.req('join')).code === 'ELSEWHERE', 'and cannot join');
  for (const c of [a, back, twin]) c.ws.close();
  ok('hello puts every account in the one channel, named by the account');
}
{
  const { first, all } = await channelWith(2);
  await first.req('say', { text: 'still here later' });
  for (const c of all) c.ws.close();
  await settle();
  const late = await guest();
  expect(late.welcome.room?.code === 'CHAT' && late.welcome.room.members.length === 1, 'the channel stays open when everyone has gone');
  expect(late.welcome.room.history.some((m) => m.text === 'still here later'), 'with its recent messages');
  late.ws.close();
  ok('the channel never closes, and keeps its recent messages');
}

// ── Messages ─────────────────────────────────────────────────────────────────
{
  const { first: host, others: [b] } = await channelWith(2);
  const sent = await host.req('say', { text: 'hello\u202e there frak', from: { id: 'x', nick: 'SYSOP' } });
  expect(sent.t === 'ok', 'a member may speak');
  const got = await b.next((m) => m.t === 'msg');
  expect(got.m.from.id === host.id && got.m.from.nick === host.as && got.m.from.uid === accountId(host.as), 'the author is the sender as the server knows them, not what the message claims');
  expect(got.m.text === 'hello there ****', 'direction controls are removed and blocked words starred out');
  expect((await b.req('say', { text: 'y'.repeat(281) })).code === 'TEXT_INVALID', 'an oversized message is refused');
  let limited = false;
  for (let i = 0; i < 6; i++) if ((await b.req('say', { text: `m${i}` })).code === 'RATE_LIMITED') limited = true;
  expect(limited, 'a burst of more than five messages is limited');
  host.ws.close(); b.ws.close();
  ok('the server sets the author, cleans the text and limits the rate');
}
{
  const { first: host, others: [b] } = await channelWith(2);
  const code = 'CHAT';
  // Plain, with a variation selector, with a skin tone, a flag, and a family joined by zero-width joiners.
  const text = 'gg 👍 🕹️ 👍🏽 🇳🇴 👨‍👩‍👧';
  b.drop();
  await host.req('say', { text });
  expect((await b.next((m) => m.t === 'msg')).m.text === text, 'emojis of every kind arrive exactly as sent');
  expect((await host.req('say', { text: '🎉'.repeat(280) })).t === 'ok', 'the limit counts an emoji as one character');
  await chatLog.flush();
  expect(readLog().some((l) => l.ev === 'msg' && l.room === code && l.text === text), 'and are logged exactly');
  host.ws.close(); b.ws.close();
  ok('messages carry emojis untouched');
}
{
  const { first: host, others: [b] } = await channelWith(2);
  await host.req('say', { text: 'try @Uridium, then @bomb jack', games: ['uridium', 'bomb-jack'] });
  const got = await b.next((m) => m.t === 'msg');
  expect(JSON.stringify(got.m.games) === JSON.stringify([{ id: 'uridium', title: 'Uridium' }, { id: 'bomb-jack', title: 'Bomb Jack' }]), 'a message carries the games it mentions, by id and title');
  await host.req('say', { text: 'try @Uridium', games: ['uridium', 'bomb-jack', 'no-such-game'] });
  expect(JSON.stringify((await b.next((m) => m.t === 'msg')).m.games) === '[{"id":"uridium","title":"Uridium"}]', 'only a known game whose @title is in the text counts');
  await host.req('say', { text: 'no games here', games: ['uridium'] });
  expect(!(await b.next((m) => m.t === 'msg')).m.games, 'a message that mentions nothing carries no games');
  const n = chat.announce({ kind: 'unlock', user: { id: 7, name: 'Nova', secret: 1 }, game: { title: 'Uridium', hash: 'h' }, achievement: { title: 'Gold', points: 10 } });
  const told = await b.next((m) => m.t === 'msg' && m.m.n === n);
  expect(told.m.event?.kind === 'unlock' && told.m.event.user.name === 'Nova' && told.m.event.achievement.points === 10 && told.m.event.user.secret === undefined, 'an unlock is announced to everyone, with only what to show');
  expect(told.m.from.id === 'system' && told.m.text === '', 'it has no author and no text');
  chat.announce({ kind: 'score', user: { id: 7, name: 'Nova' }, game: { title: 'Uridium', hash: 'h' }, leaderboard: { title: 'High Score', format: 'SCORE' }, value: 48210 });
  const best = await b.next((m) => m.t === 'msg' && m.m.event?.kind === 'score');
  expect(best.m.event.value === 48210 && best.m.event.leaderboard.format === 'SCORE', 'a new best is announced with its value and format');
  host.ws.close(); b.ws.close();
  ok('a message can mention games, and unlocks and new bests are announced');
}

// ── The log ──────────────────────────────────────────────────────────────────
{
  const { first: host, others: [b, c] } = await channelWith(3);
  const code = 'CHAT';
  await host.req('say', { text: 'meet me frak' });
  await host.req('vote', { member: b.id });
  await c.req('vote', { member: b.id });
  await b.next((m) => m.t === 'kicked');
  await chatLog.flush();
  const lines = readLog();
  const msg = lines.find((l) => l.ev === 'msg' && l.room === code && l.id === host.id);
  expect(msg?.ip === host.ip, `a message is logged with the IP address behind the proxy (saw ${msg?.ip})`);
  expect(msg?.text === 'meet me frak', 'with the words as written, before blocked words are starred out');
  expect(msg?.nick === host.as && msg?.id === host.id && typeof msg?.at === 'string', 'and its author and time');
  expect(lines.some((l) => l.ev === 'join' && l.room === code && l.ip === b.ip), 'joining is logged');
  expect(lines.some((l) => l.ev === 'kick' && l.room === code && l.id === b.id && l.ip === b.ip), 'a kick is logged with who was removed');
  host.ws.close(); b.ws.close(); c.ws.close();
  ok('the log keeps every message, join and removal with the IP address');
}
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c64chat-keep-'));
  const DAY = 24 * 3600_000;
  let t = Date.UTC(2026, 0, 1, 12);
  const keep = createChatLog({ dir, days: 90, now: () => t });
  keep.write({ ev: 'first' }); await keep.flush();
  t += 30 * DAY; keep.write({ ev: 'second' }); await keep.flush();
  expect(fs.readdirSync(dir).length === 2, 'one file per day');
  t += 61 * DAY; keep.write({ ev: 'third' }); await keep.flush();
  const names = fs.readdirSync(dir).sort();
  expect(names.length === 2 && names[0] === 'chat-2026-01-31.jsonl', `a file older than 90 days is deleted, a younger one kept (saw ${names.join(', ')})`);
  await keep.close();
  fs.rmSync(dir, { recursive: true, force: true });
  ok('log files are kept for the retention period and no longer');
}

// ── Injection ────────────────────────────────────────────────────────────────
{
  const c = await guest();
  for (const t of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    expect((await c.req(t)).code === 'BAD_REQUEST', `a request named "${t}" is refused, not looked up on Object`);
  }
  for (const t of ['create', 'kick', 'mute', 'lobby']) expect((await c.req(t)).code === 'BAD_REQUEST', `the rooms' requests are gone ("${t}")`);
  c.ws.send('{"t":"say","id":"pp","text":"proto @Uridium","__proto__":{"polluted":1},'
    + '"games":["uridium",{"id":"uridium","html":"<script>"},"../../etc","__proto__"]}');
  const said = await c.next((m) => m.t === 'msg' && m.m.text === 'proto @Uridium');
  expect(({}).polluted === undefined && Object.prototype.polluted === undefined, 'a "__proto__" key in a request pollutes nothing');
  expect(JSON.stringify(said.m.games) === '[{"id":"uridium","title":"Uridium"}]', 'a mention is only ever a known game id: objects, paths and other keys are dropped');
  await c.req('say', { text: 'red \u001b[31mALERT\u001b[0m bell\u0007 nul\u0000' });
  await chatLog.flush();
  const raw = fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('');
  expect(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(raw), 'no control character, terminal escapes included, reaches the log');
  expect(readLog().some((l) => l.ev === 'msg' && l.text === 'red  [31mALERT [0m bell  nul'), 'control characters are logged as spaces');
  c.ws.close();
  ok('requests cannot pollute prototypes, smuggle fields or write control characters to the log');
}
{
  const sent = [];
  const fake = async (url, opts) => { sent.push(opts); return {}; };
  createNotifier('https://discord.com/api/webhooks/1/abc', { fetch: fake })('a report from room "@everyone [x](http://evil) **hi**"');
  const body = JSON.parse(sent[0].body);
  expect(Array.isArray(body.allowed_mentions?.parse) && body.allowed_mentions.parse.length === 0, 'Discord is told to resolve no mentions');
  expect(!/(?<!\\)[@\[\]()*]/.test(body.content), `Discord markdown and mentions in a room name are escaped (saw ${body.content})`);
  createNotifier('https://ntfy.sh/topic', { fetch: fake })('line\u001b[2Jwith\nbreak');
  expect(sent[1].body === 'line [2Jwith break' && /text\/plain/.test(sent[1].headers['Content-Type']), 'ntfy gets one plain line without control characters');
  ok('report notifications cannot ping a channel or carry markup');
}

// ── Frames ───────────────────────────────────────────────────────────────────
{
  const ok1 = await rawSocket();
  const hello = JSON.stringify({ t: 'hello', v: PROTOCOL, account: 'acct:Fragments' });
  ok1.sock.write(Buffer.concat([maskedFrame(1, hello.slice(0, 5), { fin: false }), maskedFrame(0, hello.slice(5, 12), { fin: false }), maskedFrame(0, hello.slice(12))]));
  await sleep(150);
  expect(ok1.texts.some((m) => m.t === 'welcome'), 'a message in three fragments still arrives whole');
  ok1.sock.destroy();

  const flood = await rawSocket();
  const pieces = [maskedFrame(1, '{', { fin: false })];
  for (let i = 0; i < 20000; i++) pieces.push(maskedFrame(0, '', { fin: false }));
  flood.sock.write(Buffer.concat(pieces));
  await Promise.race([flood.done, sleep(1500)]);
  expect(flood.ended && flood.closeCode === 1009, `a message split into thousands of empty fragments is refused and the socket closed (code ${flood.closeCode})`);

  const rsv = await rawSocket();
  rsv.sock.write(maskedFrame(1, hello, { rsv: 0x40 }));
  await Promise.race([rsv.done, sleep(1000)]);
  expect(rsv.ended && rsv.closeCode === 1002, 'a frame with reserved bits set closes the socket');

  const ctl = await rawSocket();
  ctl.sock.write(maskedFrame(9, 'x', { fin: false }));
  await Promise.race([ctl.done, sleep(1000)]);
  expect(ctl.ended && ctl.closeCode === 1002, 'a fragmented control frame closes the socket');
  ok('fragments are bounded in number and size, and malformed frames are refused');
}

// ── Moderation by members ────────────────────────────────────────────────────
{
  const { first: a, others: [b, c] } = await channelWith(3);
  await b.req('vote', { member: c.id });
  const r = await a.next((m) => m.t === 'room' && m.room.members.find((x) => x.id === c.id)?.votes === 1);
  expect(r.room.members.some((x) => x.id === c.id), 'one vote of the two others present is not a majority');
  await a.req('vote', { member: c.id });
  const kicked = await c.next((m) => m.t === 'kicked');
  expect(kicked.by === 'vote' && kicked.until === clock + DEFAULTS.voteBanMs, 'a majority of the others present removes a member, for an hour');
  expect((await c.req('join')).code === 'BANNED', 'the removed session cannot come back meanwhile');
  const d = await guest({ ip: c.ip });
  expect(d.welcome.room === null && d.welcome.banned === kicked.until, 'nor a new session from the same address, which is told until when');
  const e = await guest({ as: c.as });
  expect(e.welcome.room === null && !!e.welcome.banned, 'nor the same account from another address');
  advance(DEFAULTS.voteBanMs);
  expect((await e.req('join')).t === 'ok', 'after the hour they may come back');
  for (const x of [a, b, c, d, e]) x.ws.close();
  ok('a majority vote removes a member for an hour, by session, account and address');
}
{
  const { first: target } = await channelWith(1);
  const ip = freshIp();
  const x1 = await guest({ ip }), x2 = await guest({ ip }), x3 = await guest({ ip });
  for (const g of [x1, x2, x3]) await g.req('vote', { member: target.id });
  const view = await x1.req('join');
  expect(view.room.members.some((m) => m.id === target.id), 'several sessions from one address cannot vote a member out');
  expect(view.room.members.find((m) => m.id === target.id)?.votes === 1, 'they count as one vote');
  const other = await guest();
  await other.req('vote', { member: target.id });
  expect((await target.next((m) => m.t === 'kicked')).by === 'vote', 'a second address agreeing makes the majority');
  for (const g of [target, x1, x2, x3, other]) g.ws.close();
  ok('votes count addresses, not sessions, and one newcomer alone removes nobody');
}

// ── Lifetime ─────────────────────────────────────────────────────────────────
{
  const { first: host, others: [b] } = await channelWith(2);
  await host.req('say', { text: 'before the reload' });
  b.ws.close();
  await b.closed;
  advance(DEFAULTS.graceMs - 1000);
  const back = await guest({ token: b.token });
  expect(back.welcome.room?.members.some((m) => m.id === b.id), 'reconnecting within the grace period keeps the place');
  expect(back.welcome.room.history.some((m) => m.text === 'before the reload'), 'with the recent messages');
  back.ws.close();
  await back.closed;
  advance(DEFAULTS.graceMs);
  const seen = await host.next((m) => m.t === 'room' && !m.room.members.some((x) => x.id === b.id));
  expect(!!seen, 'gone for the grace period, a member leaves the channel');
  host.ws.close();
  ok('a reload keeps the place, and a long absence ends it');
}

// ── Address limits and bans ──────────────────────────────────────────────────
{
  expect(await upgradeStatus('/chat', { Origin: 'https://evil.example', 'x-forwarded-for': freshIp() }) === 403, 'a page from another site is refused');
  expect(await upgradeStatus('/chat', { Origin: 'https://c64ready.com', 'x-forwarded-for': freshIp() }) === 101, 'the listed site is accepted');
  expect(await upgradeStatus('/chat', { Origin: 'http://localhost:5174', 'x-forwarded-for': freshIp() }) === 403, 'a page on this computer is refused, unless the server allows it');
  const local = createChatServer({ origins: ['https://c64ready.com'], allowLoopback: true, trustProxy: 1, manualClock: true });
  const localServer = http.createServer((req, res) => res.writeHead(404).end());
  localServer.on('upgrade', (req, sock, head) => { if (!local.handleUpgrade(req, sock, head)) sock.destroy(); });
  await new Promise((r) => localServer.listen(0, '127.0.0.1', r));
  const localStatus = (origin) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: localServer.address().port, path: '/chat', headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), Origin: origin, 'x-forwarded-for': freshIp(),
    } });
    req.on('upgrade', (res, sock) => { sock.destroy(); resolve(101); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.end();
  });
  expect(await localStatus('http://localhost:5174') === 101, 'with allowLoopback (the dev server), a page on this computer is accepted');
  expect(await localStatus('http://[::1]:5173') === 101, 'so is one on the IPv6 loopback address');
  local.close(); localServer.close();
  for (const o of ['https://127.attacker.example', 'http://localhost.attacker.example', 'https://evil.localhost']) {
    expect(await upgradeStatus('/chat', { Origin: o, 'x-forwarded-for': freshIp() }) === 403, `a domain that only looks local is refused (${o})`);
  }
  const ip = freshIp();
  let refused = false;
  for (let i = 0; i < 12; i++) if (await upgradeStatus('/chat', { 'x-forwarded-for': ip }) === 429) refused = true;
  expect(refused, 'more than ten connections at once from one address are refused');
  ok('origins and per-address admission are checked before the handshake');
}

// ── Admin console ────────────────────────────────────────────────────────────
let cookie = '';
const adminAuth = authenticator('p256');
let adminCredId = null;
{
  const none = await get('/admin');
  expect(none.status === 302 && none.headers.location === '/admin/login', 'signed out, the console sends you to its passkey sign-in');
  // The console's passkey, set up with the setup key from the console's own page.
  const own = `http://127.0.0.1:${PORT}`;
  const post = (url, body) => fetch(own + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: own }, body: JSON.stringify(body) });
  const o = await (await post('/admin/auth/options', { mode: 'setup', key: SETUP_KEY })).json();
  const made = adminAuth.create(o.publicKey, { origin: own });
  adminCredId = made.id;
  const v = await post('/admin/auth/verify', { challengeId: o.challengeId, credential: made.cred });
  const set = v.headers.get('set-cookie') || '';
  expect(v.status === 200 && /HttpOnly/.test(set) && /SameSite=Strict/.test(set) && /Path=\/admin/.test(set), 'the console cookie is HttpOnly, SameSite=Strict and scoped to /admin');
  cookie = set.split(';')[0];
  const good = await get('/admin', { cookie });
  expect(good.status === 200 && good.body.includes('admin'), 'signed in, the console opens');
  expect(/default-src 'none'/.test(good.headers['content-security-policy'] || ''), 'the console is served with a strict content security policy');
  const logs = await get('/admin/logs', { cookie });
  const name = /chat-\d{4}-\d{2}-\d{2}\.jsonl/.exec(logs.body)?.[0];
  expect(logs.status === 200 && name, 'the console lists the log files');
  expect((await get(`/admin/logs/${name}`)).status === 302, 'a log file needs a signed-in console');
  await chatLog.flush();
  const file = await get(`/admin/logs/${name}`, { cookie });
  expect(file.status === 200 && file.body === fs.readFileSync(path.join(logDir, name), 'utf8') && /attachment/.test(file.headers['content-disposition'] || ''), 'and downloads it whole, as an attachment');
  expect((await get('/admin/logs/..%2F..%2Fetc%2Fpasswd', { cookie })).status === 404, 'nothing but the log files can be downloaded');
  ok('the console needs its passkey, sets a narrow cookie and hands out the logs');
}
{
  const host = `127.0.0.1:${PORT}`;
  const shared = freshIp();
  const target = await guest({ ip: shared });
  const neighbour = await guest({ ip: shared });
  const admin = client({ path: '/admin/live', headers: { origin: `http://${host}`, cookie } });
  await admin.opened;
  const snap = await admin.next((m) => m.t === 'snapshot');
  const addr = snap.rooms.find((r) => r.code === 'CHAT').members.find((m) => m.id === target.id).addr;
  admin.send({ t: 'mute', room: 'CHAT', member: target.id, on: true, id: 1 });
  await target.next((m) => m.t === 'room' && m.room.members.find((x) => x.id === target.id)?.muted);
  expect((await target.req('say', { text: 'hello?' })).code === 'MUTED', 'the admin mutes the member');
  expect((await neighbour.req('say', { text: 'still talking' })).t === 'ok', 'but not another account at the same address');
  admin.send({ t: 'kick', room: 'CHAT', member: target.id, id: 2 });
  await target.next((m) => m.t === 'kicked');
  expect((await target.req('join')).code === 'BANNED', 'a member the admin removes stays out');
  const third = await guest({ ip: shared });
  expect(third.welcome.room?.code === 'CHAT', 'while another account from the same address still gets in');
  for (const c of [target, neighbour, third]) c.ws.close();
  await Promise.all([target.closed, neighbour.closed, third.closed]);
  advance(DEFAULTS.graceMs + DEFAULTS.unusedSessionMs);
  admin.send({ t: 'ban', addr, hours: 1, reason: 'from a report', id: 3 });
  expect((await admin.next((m) => (m.t === 'ok' || m.t === 'err') && m.id === 3)).t === 'ok', 'a ban from a report works after its member has gone');
  expect(await upgradeStatus('/chat', { 'x-forwarded-for': shared }) === 403, 'and keeps the address out');
  advance(3600_000);
  admin.ws.close();
  ok('the admin mutes and removes an account, not its address; a ban still finds an address that has gone');
}
{
  const host = `127.0.0.1:${PORT}`;
  expect(await upgradeStatus('/admin/live', { Origin: `http://${host}` }) === 401, 'the live socket needs the console cookie');
  expect(await upgradeStatus('/admin/live', { Origin: 'https://evil.example', Cookie: cookie }) === 403, 'and a page from the console itself');
  const { first: owner, others: [b] } = await channelWith(2);
  const code = 'CHAT';
  await owner.req('say', { text: 'secret plans' });
  const admin = client({ path: '/admin/live', headers: { origin: `http://${host}`, cookie } });
  await admin.opened;
  const snap = await admin.next((m) => m.t === 'snapshot');
  const room = snap.rooms.find((r) => r.code === code);
  expect(room, 'the admin sees the channel');
  expect(room?.history.some((m) => m.text === 'secret plans'), 'with their recent messages');
  expect(room?.members.every((m) => /^[0-9a-f]{12}$/.test(m.addr)), 'and an address hash per member, never the address');
  await b.req('say', { text: 'live line' });
  const live = await admin.next((m) => m.t === 'msg' && m.m.text === 'live line');
  admin.send({ t: 'delete', room: code, n: live.m.n, id: 1 });
  expect((await owner.next((m) => m.t === 'del')).n === live.m.n, 'a message the admin deletes disappears for everyone');
  admin.send({ t: 'mute', room: code, member: owner.id, on: true, id: 5 });
  await owner.next((m) => m.t === 'room' && m.room.members.find((x) => x.id === owner.id)?.muted);
  expect((await owner.req('say', { text: 'muted?' })).code === 'MUTED', 'a member the admin mutes cannot speak');
  await owner.req('leave');
  await owner.req('join');
  expect((await owner.req('say', { text: 'back again' })).code === 'MUTED', 'leaving and coming back keeps the mute');
  admin.send({ t: 'mute', room: code, member: owner.id, on: false, id: 6 });
  await owner.next((m) => m.t === 'room' && !m.room.members.find((x) => x.id === owner.id)?.muted);
  expect((await owner.req('say', { text: 'thanks' })).t === 'ok', 'unmuting lifts it');
  admin.send({ t: 'say', room: code, text: 'Be nice.', id: 2 });
  const said = await owner.next((m) => m.t === 'msg' && m.m.sysop);
  expect(said.m.from.nick === 'SYSOP', 'the admin speaks as SYSOP');
  await owner.req('report', { member: b.id });
  const rep = await admin.next((m) => m.t === 'report');
  expect(rep.report.target?.id === b.id && rep.report.messages.length > 0, 'a report reaches the admin with the recent messages');
  expect(notified.length === 1 && !notified[0].includes('live line'), 'the notification says a report came in, without its messages');
  const bAddr = room.members.find((m) => m.id === b.id).addr;
  admin.send({ t: 'ban', addr: bAddr, hours: 24, id: 7 });
  expect((await admin.next((m) => m.t === 'err' && m.id === 7)).code === 'REASON', 'a ban needs a reason');
  admin.send({ t: 'ban', addr: bAddr, hours: 24, reason: 'spam', id: 3 });
  expect((await b.next((m) => m.t === 'banned')).t === 'banned', 'a banned member is told');
  expect(await b.closed === 4003, 'and disconnected');
  expect(await upgradeStatus('/chat', { 'x-forwarded-for': b.ip }) === 403, 'their address cannot connect while the ban lasts');
  advance(24 * 3600_000);
  expect(await upgradeStatus('/chat', { 'x-forwarded-for': b.ip }) === 101, 'a ban expires');
  owner.ws.close(); admin.ws.close();
  ok('the admin follows the channel live, deletes, mutes, speaks, reads reports and bans');
}

{
  // An open live socket lasts only as long as the sign-in that opened it.
  const host = `127.0.0.1:${PORT}`;
  const own = `http://${host}`;
  const post = (url, body, extra = {}) => fetch(own + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: own, ...extra }, body: JSON.stringify(body) });
  const signIn = async () => {
    const o = await (await post('/admin/auth/options', { mode: 'login' })).json();
    const v = await post('/admin/auth/verify', { challengeId: o.challengeId, credential: adminAuth.get(adminCredId, o.publicKey, { origin: own }) });
    return (v.headers.get('set-cookie') || '').split(';')[0];
  };
  const first = await signIn();
  const live = client({ path: '/admin/live', headers: { origin: own, cookie: first } });
  await live.opened;
  await post('/admin/auth/logout', {}, { Cookie: first });
  expect(await live.closed === 4001, 'signing out closes the console\'s open live socket at once');
  const second = await signIn();
  const later = client({ path: '/admin/live', headers: { origin: own, cookie: second } });
  await later.opened;
  advance(13 * 3600_000);
  expect(await later.closed === 4001, 'and so does the sign-in running out, after 12 hours');
  ok('a console socket lasts only as long as its sign-in');
}

chat.close();
server.close();
await chatLog.close();
fs.rmSync(logDir, { recursive: true, force: true });
await sleep(50);
if (failing) { console.log(`\n${failing} of ${testNo} failed`); process.exit(1); }
console.log(`\nall ${testNo} passed`);
