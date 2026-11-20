// The server's entry (server/main.mjs) run as it is deployed, as a child process on 127.0.0.1
// with its database in a temporary folder: no request ends the process. A target the URL parser
// refuses, such as `//`, is answered 400. A WebSocket upgrade it refuses is answered, and its
// socket is closed by the server even when the peer never closes its side, and survives the
// peer resetting it.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let testNo = 0, failing = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (!current.length) console.log(`ok  - test ${testNo}: ${label}`);
  else { failing++; console.log(`FAIL test ${testNo}: ${label}`); for (const m of current) console.log(`     - ${m}`); current = []; }
}
const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../server/main.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c64srv-'));
// The console is on, so its paths are served: an admin passkey store needs only the setup key's hash.
const child = spawn(process.execPath, [MAIN], {
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CHAT_DATA_DIR: dir, CHAT_TRUST_PROXY: '2', CHAT_ADMIN_SETUP_KEY_SHA256: crypto.createHash('sha256').update('k').digest('hex') },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let err = '';
child.stderr.on('data', (d) => { err += d; });
let exited = null;
child.on('exit', (code, signal) => { exited = { code, signal }; });
const alive = () => exited === null;

/**
 * One raw request: the status line of the answer, and whether the server's socket is gone. The
 * peer keeps its own side open, so after the server's FIN it writes again: a socket the server
 * still holds takes the bytes, one it has closed answers with a reset.
 */
function raw(text, { reset = false, wait = 3000 } = {}) {
  return new Promise((resolve) => {
    let status = null, ended = false, gone = false;
    const s = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true }, () => s.write(text));
    s.on('error', () => { gone = true; });
    s.on('end', () => { ended = true; });
    s.on('data', (d) => {
      if (status != null) return;
      status = String(d).split('\r\n')[0];
      if (reset) { s.resetAndDestroy(); resolve({ status, closed: true }); }
    });
    // A server that is gone answers nothing.
    if (reset) { setTimeout(() => { s.destroy(); resolve({ status, closed: true }); }, wait); return; }
    if (wait >= 1000) {
      setTimeout(() => { if (!s.destroyed) s.write('more'); }, wait - 600);
      setTimeout(() => { if (!s.destroyed) s.write('more'); }, wait - 300);
    }
    setTimeout(() => { s.destroy(); resolve({ status, closed: ended && gone }); }, wait);
  });
}
const upgrade = (target, extra = '') => `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n${extra}\r\n`;

try {
  let up = false;
  for (let i = 0; i < 100 && !up && alive(); i++) { await sleep(100); up = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false); }
  expect(up, `the server starts (${err.trim().split('\n').at(-1) ?? ''})`);
  ok('the server starts');

  for (const target of ['//', '//x:99999/', '/\\[', 'http://[/']) {
    const r = await raw(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`, { wait: 500 });
    expect(/ 400 /.test(r.status ?? ''), `GET ${target} is answered 400 (${r.status})`);
  }
  const head = await raw('HEAD // HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n', { wait: 500 });
  expect(/ 400 /.test(head.status ?? ''), `HEAD // is answered 400 (${head.status})`);
  await sleep(200);
  expect(alive(), `and the process keeps running (${JSON.stringify(exited)})`);
  ok('a target the URL parser refuses is a bad request, not a crash');

  const refused = [
    ['a chat upgrade from another site', upgrade('/chat', 'Origin: https://elsewhere.example\r\n')],
    ['a console upgrade without its cookie', upgrade('/admin/live')],
    ['an upgrade that is not a WebSocket', 'GET /chat HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'],
  ];
  for (const [label, text] of refused) {
    const r = await raw(text, { wait: 3000 });
    expect(/ 40\d /.test(r.status ?? ''), `${label} is refused (${r.status})`);
    expect(r.closed, `${label}: the server closes its socket though the peer keeps its side open`);
  }
  ok('a refused upgrade is answered and its socket closed by the server');

  for (const [label, text] of refused) {
    const r = await raw(text, { reset: true });
    expect(/ 40\d /.test(r.status ?? ''), `${label} is refused (${r.status})`);
    await sleep(300);
    expect(alive(), `${label}, then reset by the peer: the process keeps running (${JSON.stringify(exited)} ${/Error: [^\n]*/.exec(err)?.[0] ?? ''})`);
  }
  expect(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false), 'and still answers');
  ok('a peer resetting a refused upgrade does not end the process');
} finally {
  child.kill();
  await new Promise((r) => (exited ? r() : child.on('exit', r)));
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failing) { console.log(`\n${failing} of ${testNo} failed`); process.exit(1); }
console.log(`\nok - the server survives bad requests: ${testNo} checks`);
