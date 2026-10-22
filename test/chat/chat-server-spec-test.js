// The chat server (server/chat.mjs) with real WebSocket clients on a real
// listener and a clock the test drives. Each check is one rule of the design:
// every room is listed for anyone, rooms live only in memory and close when
// their members are gone, members
// moderate (host kick and mute, majority vote), the server sets every author,
// limits hold, bans act on the client address behind the trusted proxy, the
// log keeps every message with its IP address for the retention period, and
// the admin console needs basic auth, its cookie and its own origin.

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
import { cleanText, cleanName, isRoomCode, topicKey, cleanTopic, foldTitle } from '../../server/protocol.mjs';

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
const PASSWORD = 'correct horse';
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c64chat-log-'));
const chatLog = createChatLog({ dir: logDir, now: () => clock });
const readLog = (dir = logDir) => fs.readdirSync(dir).sort().flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const chat = createChatServer({
  chatLog,
  origins: ['https://c64ready.com'],
  trustProxy: 1,
  admin: { user: 'sysop', passwordSha256: crypto.createHash('sha256').update(PASSWORD).digest('hex') },
  notify: (t) => notified.push(t),
  blockedWords: ['frak'],
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
async function guest(opts = {}) {
  const c = client(opts);
  await c.opened;
  c.send({ t: 'hello', v: 1, token: opts.token });
  const w = await c.next((m) => m.t === 'welcome');
  c.token = w.token; c.id = w.id; c.welcome = w;
  return c;
}
async function roomWith(n) {
  const host = await guest();
  const made = await host.req('create', { nick: 'Host', name: 'Commando fans', topic: { title: 'Commando', kind: 'disk' } });
  const code = made.room.code;
  const others = [];
  for (let i = 1; i < n; i++) {
    const g = await guest();
    const r = await g.req('join', { nick: `P${i}`, code });
    if (r.t !== 'ok') throw new Error(`join failed: ${r.code}`);
    others.push(g);
  }
  return { host, others, code };
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

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

// ── Shared rules ─────────────────────────────────────────────────────────────
{
  expect(cleanText('a\u202eb\u0007c') === 'ab c', 'direction overrides are removed and control characters become spaces');
  expect(cleanText('x'.repeat(281)) === null, 'a message longer than 280 characters is refused');
  expect(cleanText('   ') === null, 'an empty message is refused');
  expect(cleanName('Ni\u200bne  Fan', 16) === 'Nine Fan', 'names lose invisible characters and repeated spaces');
  expect(foldTitle('Commando (1985)[side a]') === foldTitle('COMMANDO'), 'titles fold to the same topic');
  expect(topicKey(cleanTopic({ title: 'Nine', kind: 'disk', a64: { item: '42', cat: 3, file: '7', name: 'nine.d64' } })) === 'a64:3:42', 'an Assembly64 topic is keyed by its release');
  expect(cleanTopic({ title: 'X', kind: 'floppy' }) === null, 'an unknown topic kind is refused');
  ok('text, names and topics are cleaned the same way on both sides');
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
  expect(c.welcome.room === null, 'a new session is in no room');
  c.ws.close();
  ok('hello gives a guest session without any sign-up');
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

// ── Rooms and the lobby ──────────────────────────────────────────────────────
{
  const watcher = await guest();
  await watcher.req('lobby');
  await watcher.next((m) => m.t === 'lobby');
  const { host, code } = await roomWith(1);
  const view = async () => {
    advance(1000);
    const lobby = await watcher.next((m) => m.t === 'lobby');
    return { ...lobby.rooms.find((r) => r.code === code), online: lobby.online };
  };
  expect(JSON.stringify((await view()).online) === '["Host"]', 'the lobby lists connected room members by nickname only');
  const member = await guest();
  await member.req('join', { code, nick: 'Visitor' });
  expect(JSON.stringify((await view()).online) === '["Host","Visitor"]', 'joining updates the lobby online list');
  member.ws.close();
  await member.closed;
  await host.next((m) => m.t === 'room' && m.room.members.some((x) => x.id === member.id && !x.here));
  const away = await view();
  expect(!away.online.includes('Visitor'), 'disconnected members are excluded from online users during the grace period');
  expect(away.count === 2, 'the room keeps a disconnected member during the grace period');
  const back = await guest({ token: member.token });
  expect(JSON.stringify((await view()).online) === '["Host","Visitor"]', 'reconnecting restores the nickname once in the lobby');
  await back.req('leave');
  expect(JSON.stringify((await view()).online) === '["Host"]', 'leaving removes the nickname from the lobby');
  await back.req('join', { code, nick: 'Returned' });
  await view();
  await host.req('kick', { member: back.id });
  expect(JSON.stringify((await view()).online) === '["Host"]', 'removing a member updates online users');
  host.ws.close();
  await host.closed;
  expect((await view()).online.length === 0, 'a room with only disconnected members has no online users');
  advance(DEFAULTS.graceMs);
  const closed = await watcher.next((m) => m.t === 'lobby');
  expect(!closed.rooms.some((r) => r.code === code), 'closing a room removes its online list');
  watcher.ws.close(); back.ws.close();
  ok('the lobby tracks online nicknames through membership and connection changes');
}
{
  const watcher = await guest();
  const first = await watcher.req('lobby');
  expect(first.t === 'ok', 'subscribing to the lobby is accepted');
  await watcher.next((m) => m.t === 'lobby');
  const { host, code } = await roomWith(1);
  const pub = await guest();
  const made = await pub.req('create', { nick: 'Ann', name: 'Nine', public: false, topic: { title: 'Nine', kind: 'disk' } });
  expect(isRoomCode(code) && isRoomCode(made.room.code), 'room codes are six characters from the code alphabet');
  expect(made.room.owner === pub.id, 'the creator is the host');
  advance(1000);
  const lobby = await watcher.next((m) => m.t === 'lobby');
  expect(lobby.rooms.some((r) => r.code === made.room.code && r.count === 1), 'a room is listed with its member count');
  expect(lobby.rooms.some((r) => r.code === code), 'every room is listed, whatever its creator asked for');
  expect(lobby.rooms.find((r) => r.code === made.room.code)?.key === 't:nine', 'a listed room carries its topic key');
  expect(lobby.online.includes('Host') && lobby.online.includes('Ann'), 'the online list includes nicknames across different rooms');
  await pub.req('leave');
  advance(1000);
  const after = await watcher.next((m) => m.t === 'lobby');
  expect(!after.rooms.some((r) => r.code === made.room.code), 'a room its last member leaves closes and leaves the lobby');
  host.ws.close(); pub.ws.close(); watcher.ws.close();
  ok('every room is listed in the lobby, and an emptied room closes');
}
{
  const { host, others: [b], code } = await roomWith(2);
  const c = await guest();
  expect((await c.req('join', { nick: 'host', code })).code === 'NICK_TAKEN', 'a nickname already in the room is refused, whatever its case');
  expect((await c.req('join', { nick: 'SysOp', code })).code === 'NICK_INVALID', 'the reserved names are refused');
  expect((await c.req('join', { nick: 'Frak', code })).code === 'BLOCKED_WORD', 'a nickname with a blocked word is refused');
  expect((await c.req('join', { nick: 'Zed', code: 'ZZZZZZ' })).code === 'NOT_FOUND', 'an unknown code finds nothing');
  const joined = await c.req('join', { nick: 'Zed', code });
  expect(joined.t === 'ok' && joined.room.members.length === 3, 'anyone may join a listed room');
  const seen = await b.next((m) => m.t === 'room' && m.room.members.length === 3);
  expect(seen.room.members.some((m) => m.nick === 'Zed'), 'members see the new member');
  host.ws.close(); b.ws.close(); c.ws.close();
  ok('joining checks the code, the nickname and the blocked words');
}

// ── Messages ─────────────────────────────────────────────────────────────────
{
  const { host, others: [b] } = await roomWith(2);
  b.drop();
  const sent = await host.req('say', { text: 'hello\u202e there frak', from: { id: 'x', nick: 'SYSOP' } });
  expect(sent.t === 'ok', 'a member may speak');
  const got = await b.next((m) => m.t === 'msg');
  expect(got.m.from.id === host.id && got.m.from.nick === 'Host', 'the author is the sender as the server knows them, not what the message claims');
  expect(got.m.text === 'hello there ****', 'direction controls are removed and blocked words starred out');
  expect((await b.req('say', { text: 'y'.repeat(281) })).code === 'TEXT_INVALID', 'an oversized message is refused');
  let limited = false;
  for (let i = 0; i < 6; i++) if ((await b.req('say', { text: `m${i}` })).code === 'RATE_LIMITED') limited = true;
  expect(limited, 'a burst of more than five messages is limited');
  host.ws.close(); b.ws.close();
  ok('the server sets the author, cleans the text and limits the rate');
}
{
  const { host, others: [b], code } = await roomWith(2);
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

// ── The log ──────────────────────────────────────────────────────────────────
{
  const { host, others: [b], code } = await roomWith(2);
  await host.req('say', { text: 'meet me frak' });
  await host.req('kick', { member: b.id });
  await chatLog.flush();
  const lines = readLog();
  const msg = lines.find((l) => l.ev === 'msg' && l.room === code);
  expect(msg?.ip === host.ip, `a message is logged with the IP address behind the proxy (saw ${msg?.ip})`);
  expect(msg?.text === 'meet me frak', 'with the words as written, before blocked words are starred out');
  expect(msg?.nick === 'Host' && msg?.id === host.id && typeof msg?.at === 'string', 'and its author and time');
  expect(lines.some((l) => l.ev === 'create' && l.room === code && l.ip === host.ip), 'creating a room is logged');
  expect(lines.some((l) => l.ev === 'join' && l.room === code && l.ip === b.ip), 'joining is logged');
  expect(lines.some((l) => l.ev === 'kick' && l.room === code && l.id === b.id && l.ip === b.ip), 'a kick is logged with who was removed');
  host.ws.close(); b.ws.close();
  ok('the log keeps every message, join and kick with the IP address');
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
  c.ws.send('{"t":"create","id":"pp","nick":"Proto","name":"Proto","__proto__":{"polluted":1},'
    + '"topic":{"title":"X","kind":"disk","html":"<script>","__proto__":{"polluted":1},"a64":{"item":"../../etc","cat":1,"file":"7","name":"x.d64"}}}');
  const made = await c.next((m) => m.t === 'ok' && m.id === 'pp');
  expect(({}).polluted === undefined && Object.prototype.polluted === undefined, 'a "__proto__" key in a request pollutes nothing');
  expect(JSON.stringify(Object.keys(made.room.topic)) === '["title","kind"]', 'a topic keeps only its known fields');
  expect(!made.room.topic.a64, 'an Assembly64 reference that looks like a path is dropped');
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
  const hello = JSON.stringify({ t: 'hello', v: 1 });
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
  const { host, others: [b, c], code } = await roomWith(3);
  expect((await b.req('kick', { member: c.id })).code === 'NOT_OWNER', 'only the host may kick');
  expect((await host.req('mute', { member: b.id, on: true })).t === 'ok', 'the host may mute');
  expect((await b.req('say', { text: 'hi' })).code === 'MUTED', 'a muted member cannot speak');
  expect((await host.req('kick', { member: c.id })).t === 'ok', 'the host may kick');
  expect((await c.next((m) => m.t === 'kicked')).by === 'owner', 'the kicked member is told');
  expect((await c.req('join', { nick: 'C2', code })).code === 'BANNED', 'a kicked session cannot come back');
  const d = await guest({ ip: c.ip });
  expect((await d.req('join', { nick: 'C3', code })).code === 'BANNED', 'nor can a new session from the same address');
  host.ws.close(); b.ws.close(); c.ws.close(); d.ws.close();
  ok('the host mutes and kicks, and a kick lasts as long as the room');
}
{
  const { host, others: [b, c] } = await roomWith(3);
  await b.req('vote', { member: c.id });
  const r = await host.next((m) => m.t === 'room' && m.room.members.find((x) => x.id === c.id)?.votes === 1);
  expect(r.room.members.length === 3, 'one vote of the two others present is not a majority');
  await host.req('vote', { member: c.id });
  expect((await c.next((m) => m.t === 'kicked')).by === 'vote', 'a majority of the others present removes a member');
  // The host can be voted out too, and hosting passes on.
  const d = await guest();
  await d.req('join', { nick: 'D', code: r.room.code });
  await b.req('vote', { member: host.id });
  await d.req('vote', { member: host.id });
  await host.next((m) => m.t === 'kicked');
  const after = await b.next((m) => m.t === 'room' && m.room.owner !== host.id);
  expect(after.room.owner === b.id, 'hosting passes to the member who has been there longest');
  host.ws.close(); b.ws.close(); c.ws.close(); d.ws.close();
  ok('a majority vote removes anyone, the host included');
}
{
  const { host, code } = await roomWith(1);
  const ip = freshIp();
  const x1 = await guest({ ip }), x2 = await guest({ ip }), x3 = await guest({ ip });
  for (const [g, n] of [[x1, 'X1'], [x2, 'X2'], [x3, 'X3']]) await g.req('join', { nick: n, code });
  for (const g of [x1, x2, x3]) await g.req('vote', { member: host.id });
  const view = await x1.req('join', { nick: 'X1', code });
  expect(view.room.members.some((m) => m.id === host.id) && view.room.owner === host.id, 'several sessions from one address cannot vote the host out');
  expect(view.room.members.find((m) => m.id === host.id)?.votes === 1, 'they count as one vote');
  const other = await guest();
  await other.req('join', { nick: 'Other', code });
  await other.req('vote', { member: host.id });
  expect((await host.next((m) => m.t === 'kicked')).by === 'vote', 'a second address agreeing makes the majority');
  for (const g of [host, x1, x2, x3, other]) g.ws.close();
  ok('votes count addresses, not sessions, and one newcomer alone removes nobody');
}
{
  const { host, others: [b], code } = await roomWith(2);
  await host.req('mute', { member: b.id, on: true });
  await b.req('leave');
  await b.req('join', { nick: 'P1', code });
  expect((await b.req('say', { text: 'back again' })).code === 'MUTED', 'leaving and rejoining keeps a mute');
  await b.req('leave');
  const b2 = await guest({ ip: b.ip });
  await b2.req('join', { nick: 'P1b', code });
  expect((await b2.req('say', { text: 'new me' })).code === 'MUTED', 'so does a new session from the same address');
  await host.req('mute', { member: b2.id, on: false });
  expect((await b2.req('say', { text: 'thanks' })).t === 'ok', 'unmuting lifts it');
  host.ws.close(); b.ws.close(); b2.ws.close();
  ok('a mute lasts for the room, whoever leaves and comes back');
}

// ── Lifetime ─────────────────────────────────────────────────────────────────
{
  const { host, others: [b], code } = await roomWith(2);
  await host.req('say', { text: 'before the reload' });
  b.ws.close();
  await b.closed;
  const gone = await host.next((m) => m.t === 'room' && m.room.members.some((x) => x.id === b.id && !x.here));
  expect(gone.room.members.length === 2, 'a dropped member stays in the room during the grace period');
  advance(DEFAULTS.graceMs - 1000);
  const back = await guest({ token: b.token });
  expect(back.welcome.room?.code === code, 'reconnecting within the grace period lands back in the room');
  expect(back.welcome.room.history.some((m) => m.text === 'before the reload'), 'with the recent messages');
  host.ws.close(); back.ws.close();
  await host.closed; await back.closed;
  advance(DEFAULTS.graceMs);
  const late = await guest({ token: host.token });
  expect(late.welcome.room === null, 'once everyone has been gone for the grace period the room is gone');
  expect((await late.req('join', { nick: 'Again', code })).code === 'NOT_FOUND', 'and its code no longer works');
  late.ws.close();
  ok('a room survives a reload and closes when everyone has been gone for the grace period');
}
{
  const { host, others: [b] } = await roomWith(2);
  advance(DEFAULTS.idleRoomMs);
  expect((await b.next((m) => m.t === 'closed')).reason === 'idle', 'a room with no messages for four hours closes');
  host.ws.close(); b.ws.close();
  ok('an idle room closes even with members in it');
}

// ── Address limits and bans ──────────────────────────────────────────────────
{
  expect(await upgradeStatus('/chat', { Origin: 'https://evil.example', 'x-forwarded-for': freshIp() }) === 403, 'a page from another site is refused');
  expect(await upgradeStatus('/chat', { Origin: 'https://c64ready.com', 'x-forwarded-for': freshIp() }) === 101, 'the listed site is accepted');
  expect(await upgradeStatus('/chat', { Origin: 'http://localhost:5174', 'x-forwarded-for': freshIp() }) === 101, 'a page on this computer is accepted');
  expect(await upgradeStatus('/chat', { Origin: 'http://[::1]:5173', 'x-forwarded-for': freshIp() }) === 101, 'so is one on the IPv6 loopback address');
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
{
  const none = await get('/admin');
  expect(none.status === 401 && /^Basic /.test(none.headers['www-authenticate'] || ''), 'the console asks for basic auth');
  expect((await get('/admin', { authorization: basic('sysop', 'wrong') })).status === 401, 'a wrong password is refused');
  const good = await get('/admin', { authorization: basic('sysop', PASSWORD) });
  expect(good.status === 200 && good.body.includes('SYSOP'), 'the right password opens the console');
  const set = String(good.headers['set-cookie'] || '');
  expect(/HttpOnly/.test(set) && /SameSite=Strict/.test(set) && /Path=\/admin/.test(set), 'the console cookie is HttpOnly, SameSite=Strict and scoped to /admin');
  expect(/default-src 'none'/.test(good.headers['content-security-policy'] || ''), 'the console is served with a strict content security policy');
  cookie = set.split(';')[0];
  let limited = false;
  for (let i = 0; i < 6; i++) if ((await get('/admin', { authorization: basic('sysop', 'nope'), 'x-forwarded-for': '192.0.2.77' })).status === 429) limited = true;
  expect(limited, 'repeated failures from one address are locked out');
  const logs = await get('/admin/logs', { authorization: basic('sysop', PASSWORD) });
  const name = /chat-\d{4}-\d{2}-\d{2}\.jsonl/.exec(logs.body)?.[0];
  expect(logs.status === 200 && name, 'the console lists the log files');
  expect((await get(`/admin/logs/${name}`)).status === 401, 'a log file needs the password');
  await chatLog.flush();
  const file = await get(`/admin/logs/${name}`, { authorization: basic('sysop', PASSWORD) });
  expect(file.status === 200 && file.body === fs.readFileSync(path.join(logDir, name), 'utf8') && /attachment/.test(file.headers['content-disposition'] || ''), 'and downloads it whole, as an attachment');
  expect((await get('/admin/logs/..%2F..%2Fetc%2Fpasswd', { authorization: basic('sysop', PASSWORD) })).status === 404, 'nothing but the log files can be downloaded');
  ok('the console needs basic auth, sets a narrow cookie and hands out the logs');
}
{
  const host = `127.0.0.1:${PORT}`;
  expect(await upgradeStatus('/admin/live', { Origin: `http://${host}` }) === 401, 'the live socket needs the console cookie');
  expect(await upgradeStatus('/admin/live', { Origin: 'https://evil.example', Cookie: cookie }) === 403, 'and a page from the console itself');
  const { host: owner, others: [b], code } = await roomWith(2);
  await owner.req('say', { text: 'secret plans' });
  const admin = client({ path: '/admin/live', headers: { origin: `http://${host}`, cookie } });
  await admin.opened;
  const snap = await admin.next((m) => m.t === 'snapshot');
  const room = snap.rooms.find((r) => r.code === code);
  expect(room, 'the admin sees every room');
  expect(room?.history.some((m) => m.text === 'secret plans'), 'with their recent messages');
  expect(room?.members.every((m) => /^[0-9a-f]{12}$/.test(m.addr)), 'and an address hash per member, never the address');
  await b.req('say', { text: 'live line' });
  const live = await admin.next((m) => m.t === 'msg' && m.m.text === 'live line');
  admin.send({ t: 'delete', room: code, n: live.m.n, id: 1 });
  expect((await owner.next((m) => m.t === 'del')).n === live.m.n, 'a message the admin deletes disappears for the room');
  admin.send({ t: 'say', room: code, text: 'Be nice.', id: 2 });
  const said = await owner.next((m) => m.t === 'msg' && m.m.sysop);
  expect(said.m.from.nick === 'SYSOP', 'the admin speaks as SYSOP');
  await owner.req('report', { member: b.id });
  const rep = await admin.next((m) => m.t === 'report');
  expect(rep.report.target?.id === b.id && rep.report.messages.length > 0, 'a report reaches the admin with the room\'s recent messages');
  expect(notified.length === 1 && !notified[0].includes('live line'), 'the notification says a report came in, without its messages');
  admin.send({ t: 'ban', addr: room.members.find((m) => m.id === b.id).addr, hours: 24, id: 3 });
  expect((await b.next((m) => m.t === 'banned')).t === 'banned', 'a banned member is told');
  expect(await b.closed === 4003, 'and disconnected');
  expect(await upgradeStatus('/chat', { 'x-forwarded-for': b.ip }) === 403, 'their address cannot connect while the ban lasts');
  admin.send({ t: 'close', room: code, id: 4 });
  expect((await owner.next((m) => m.t === 'closed')).reason === 'sysop', 'the admin can close a room');
  advance(24 * 3600_000);
  expect(await upgradeStatus('/chat', { 'x-forwarded-for': b.ip }) === 101, 'a ban expires');
  owner.ws.close(); admin.ws.close();
  ok('the admin follows every room live, deletes, speaks, reads reports and bans');
}

chat.close();
server.close();
await chatLog.close();
fs.rmSync(logDir, { recursive: true, force: true });
await sleep(50);
if (failing) { console.log(`\n${failing} of ${testNo} failed`); process.exit(1); }
console.log(`\nall ${testNo} passed`);
