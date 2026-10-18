// c64rdy serve (cli/serve.mjs) and its relay (cli/relay.mjs): the app served
// with the cross-origin isolation headers it needs, on loopback only; the
// device endpoints and change events for --device; and the relay as RFC 6455
// describes a server (101 handshake with the derived accept key, binary frames,
// a client frame that is not masked closes the connection).

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { startServe } from '../../cli/serve.mjs';
import { isLocalAddress } from '../../cli/relay.mjs';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c64rdy-serve-'));
fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><title>app</title>');
fs.mkdirSync(path.join(tmp, 'docs'));
fs.writeFileSync(path.join(tmp, 'docs', 'about.html'), 'about');
const deviceFile = path.join(tmp, 'led-board.js');
fs.copyFileSync(new URL('../../public/userport/led-board.js', import.meta.url), deviceFile);

const echo = net.createServer((s) => s.on('data', (d) => s.write(d)));
await new Promise((r) => echo.listen(0, '127.0.0.1', r));
const echoPort = echo.address().port;

// The relay tests below reach a TCP server on this machine, so this one allows local targets.
const srv = await startServe({ port: 0, app: tmp, device: deviceFile, allowLocal: true, log: () => {} });
const base = srv.url.replace(/\/$/, '');
const wsBase = base.replace('http', 'ws');

try {
  {
    const r = await fetch(`${base}/`);
    expect(r.status === 200 && (await r.text()).includes('<title>app</title>'), 'the app index is served');
    expect(r.headers.get('cross-origin-opener-policy') === 'same-origin', 'COOP same-origin');
    expect(r.headers.get('cross-origin-embedder-policy') === 'require-corp', 'COEP require-corp');
    const d = await fetch(`${base}/docs/about`);
    expect(d.status === 200 && (await d.text()) === 'about', '/docs/about serves about.html like the site');
    const t = await fetch(`${base}/../../etc/passwd`);
    expect(t.status !== 200 || !(await t.text()).includes('root:'), 'no path outside the app');
    expect(srv.server.address().address === '127.0.0.1', `listens on loopback only, got ${srv.server.address().address}`);
    ok('the app is served with cross-origin isolation, on 127.0.0.1 only');
  }

  {
    const info = await (await fetch(`${base}/__c64rdy/info`)).json();
    expect(info.relay === '/relay' && info.device && info.events, `info names the relay, device and events: ${JSON.stringify(info)}`);
    const src = await (await fetch(`${base}${info.device}`)).text();
    expect(src === fs.readFileSync(deviceFile, 'utf8'), 'the --device file is served as it is on disk');
    ok('--device: the app finds the device through /__c64rdy/info');
  }

  {
    const res = await fetch(`${base}/__c64rdy/events`);
    const reader = res.body.getReader();
    await reader.read();                                   // the opening comment
    setTimeout(() => fs.appendFileSync(deviceFile, '\n// edited\n'), 50);
    const got = await Promise.race([
      reader.read().then(({ value }) => new TextDecoder().decode(value)),
      new Promise((r) => setTimeout(() => r(''), 3000)),
    ]);
    expect(got.includes('event: device'), `a change to the file sends a device event, got ${JSON.stringify(got)}`);
    reader.cancel();
    ok('--device: editing the file tells the app to reload it');
  }

  {
    const ws = new WebSocket(`${wsBase}/relay/127.0.0.1/${echoPort}`, ['binary']);
    ws.binaryType = 'arraybuffer';
    const back = await new Promise((resolve, reject) => {
      ws.onopen = () => ws.send(Uint8Array.from([0x41, 0x54, 0x0d, 0xff, 0x00]));
      ws.onmessage = (e) => resolve(new Uint8Array(e.data));
      ws.onerror = () => reject(new Error('relay error'));
      setTimeout(() => reject(new Error('timeout')), 3000);
    }).catch((e) => e);
    expect(back instanceof Uint8Array && Array.from(back).join(',') === '65,84,13,255,0', `bytes come back unchanged: ${back}`);
    expect(ws.protocol === 'binary', `the binary subprotocol is chosen, got ${JSON.stringify(ws.protocol)}`);
    ws.close();
    ok('relay: a WebSocket client reaches a TCP server and gets its bytes back');
  }

  {
    const closedPort = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    const ws = new WebSocket(`${wsBase}/relay/127.0.0.1/${closedPort}`, ['binary']);
    const opened = await new Promise((r) => { ws.onopen = () => r(true); ws.onerror = () => r(false); ws.onclose = () => r(false); setTimeout(() => r('timeout'), 3000); });
    expect(opened === false, `a refused TCP connection fails the WebSocket open, got ${opened}`);
    ok('relay: a target that refuses the connection never opens');
  }

  {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(srv.server.address().port, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    sock.write(`GET /relay/127.0.0.1/${echoPort} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    const head = await new Promise((r) => sock.once('data', (d) => r(d.toString('latin1'))));
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    expect(head.startsWith('HTTP/1.1 101'), `101 Switching Protocols, got ${head.split('\r\n')[0]}`);
    expect(head.includes(`Sec-WebSocket-Accept: ${accept}`), 'Sec-WebSocket-Accept is the SHA-1 of key + GUID (RFC 6455 §4.2.2)');
    sock.write(Buffer.from([0x82, 0x01, 0x41]));          // a binary frame with no mask
    const closed = await new Promise((r) => { sock.once('close', () => r(true)); setTimeout(() => r(false), 2000); });
    expect(closed, 'an unmasked client frame closes the connection (RFC 6455 §5.1)');
    ok('relay: RFC 6455 handshake, and unmasked client frames are refused');
  }

  {
    // Who may use the relay: the app's own pages, not any web page the user has open.
    const port = srv.server.address().port;
    const handshake = (host, origin) => new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1');
      sock.on('connect', () => sock.write(`GET /relay/127.0.0.1/${echoPort} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n`
        + (origin ? `Origin: ${origin}\r\n` : '') + '\r\n'));
      sock.once('data', (d) => { resolve(d.toString('latin1').split('\r\n')[0]); sock.destroy(); });
      sock.on('error', () => resolve('error'));
    });
    const own = `127.0.0.1:${port}`;
    expect((await handshake(own, `http://${own}`)).includes('101'), 'the app\'s own page may connect');
    expect((await handshake(`localhost:${port}`, `http://localhost:${port}`)).includes('101'), 'so may the app on localhost');
    expect((await handshake(own, 'https://evil.example')).includes('403'), 'another site is refused');
    expect((await handshake(`evil.example:${port}`, `http://evil.example:${port}`)).includes('403'), 'a DNS name rebound to this machine is refused');
    ok('relay: only the app this server serves may open connections');
  }

  {
    // By default the relay stays off this computer and its network (RFC 1918
    // private, RFC 6598 shared, RFC 3927/4291 link-local, RFC 1122 loopback,
    // RFC 4193 unique local), names included, as browsers keep web pages away.
    const local = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1',
      '169.254.1.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:192.168.1.1', 'not-an-address'];
    const remote = ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'];
    for (const a of local) expect(isLocalAddress(a), `${a} is local`);
    for (const a of remote) expect(!isLocalAddress(a), `${a} is not local`);
    const strict = await startServe({ port: 0, app: tmp, log: () => {} });
    try {
      const port = strict.server.address().port;
      const own = `127.0.0.1:${port}`;
      const status = (target) => new Promise((resolve) => {
        const sock = net.connect(port, '127.0.0.1');
        sock.on('connect', () => sock.write(`GET /relay/${target}/${echoPort} HTTP/1.1\r\nHost: ${own}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
          + `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://${own}\r\n\r\n`));
        sock.once('data', (d) => { resolve(d.toString('latin1').split('\r\n')[0]); sock.destroy(); });
        sock.on('error', () => resolve('error'));
      });
      expect((await status('127.0.0.1')).includes('403'), 'an address on this computer is refused');
      expect((await status('localhost')).includes('403'), 'so is a name that resolves to it');
    } finally {
      await strict.close();
    }
    ok('relay: by default it refuses targets on this computer and its network');
  }

  {
    // Saving by writing a new file and renaming it over the old one still reloads.
    const res = await fetch(`${base}/__c64rdy/events`);
    const reader = res.body.getReader();
    await reader.read();
    setTimeout(() => {
      const tmpFile = path.join(tmp, '.led-board.js.swp');
      fs.writeFileSync(tmpFile, fs.readFileSync(deviceFile, 'utf8') + '\n// saved by rename\n');
      fs.renameSync(tmpFile, deviceFile);
    }, 50);
    const first = await Promise.race([reader.read().then(({ value }) => new TextDecoder().decode(value)), new Promise((r) => setTimeout(() => r(''), 3000))]);
    setTimeout(() => {
      const tmpFile = path.join(tmp, '.led-board.js.swp');
      fs.writeFileSync(tmpFile, fs.readFileSync(deviceFile, 'utf8') + '\n// again\n');
      fs.renameSync(tmpFile, deviceFile);
    }, 300);
    const second = await Promise.race([reader.read().then(({ value }) => new TextDecoder().decode(value)), new Promise((r) => setTimeout(() => r(''), 3000))]);
    expect(first.includes('event: device') && second.includes('event: device'), `every rename-save reloads: ${JSON.stringify([first, second])}`);
    reader.cancel();
    ok('--device: saves that rename a new file over the old one keep reloading');
  }
  {
    // No --app: the app comes from the site, is cached, and the cache answers
    // when the site is unreachable.
    const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c64rdy-cache-'));
    process.env.XDG_CACHE_HOME = cacheHome;
    const site = http.createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>site</title>'); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => site.listen(0, '127.0.0.1', r));
    const siteUrl = `http://127.0.0.1:${site.address().port}`;
    const proxy = await startServe({ port: 0, site: siteUrl, log: () => {} });
    const purl = proxy.url.replace(/\/$/, '');
    const online = await fetch(`${purl}/`);
    const onlineText = await online.text();
    expect(online.status === 200 && onlineText.includes('<title>site</title>'), 'the app is fetched from the site');
    expect(online.headers.get('cross-origin-embedder-policy') === 'require-corp', 'with the isolation headers added');
    expect((await fetch(`${purl}/missing.js`)).status === 404, 'a 404 on the site stays a 404');
    const other = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.server.address().port, path: `//127.0.0.1:${site.address().port}/index.html` }, (res) => { res.resume(); resolve(res.statusCode); });
      req.end();
    });
    expect(other === 403, `a //host/ path cannot fetch from another host: ${other}`);
    await new Promise((r) => site.close(r));
    const offline = await fetch(`${purl}/`);
    expect(offline.status === 200 && (await offline.text()).includes('<title>site</title>'), 'with the site gone, the cached copy answers');
    expect((await fetch(`${purl}/never-fetched.js`)).status === 502, 'nothing cached and no site: 502');
    await proxy.close();
    delete process.env.XDG_CACHE_HOME;
    fs.rmSync(cacheHome, { recursive: true, force: true });
    ok('without --app: the site is proxied, cached, and served from the cache offline');
  }
} finally {
  await srv.close();
  echo.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failing ? `\n${failing} of ${testNo} FAILED` : `\nall ${testNo} passed`);
process.exit(failing ? 1 : 0);
