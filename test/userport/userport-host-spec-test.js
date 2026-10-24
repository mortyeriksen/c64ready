// The browser host for user port devices (src/userport/host.js), run in Node:
// relay addresses, the `host` object's storage, frame hooks and status, the
// echo loopback, and TCP connections through the real relay (cli/relay.mjs)
// with Node's own WebSocket client, as a browser would make them.

import http from 'node:http';
import net from 'node:net';
import { relayUrl, defaultRelayBase, createBrowserHost } from '../../src/userport/host.js';
import { attachRelay } from '../../cli/relay.mjs';

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

// A localStorage for Node, so host.storage has somewhere to go.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const meta = { id: 'example.test', name: 'Test', version: '1.0.0', apiVersion: 1 };
const until = (pred, ms = 3000) => new Promise((resolve) => {
  const t0 = Date.now();
  const tick = () => (pred() || Date.now() - t0 > ms ? resolve(pred()) : setTimeout(tick, 10));
  tick();
});

{
  expect(relayUrl('ws://localhost:6464/relay/', 'BBS.example', 6400) === 'ws://localhost:6464/relay/BBS.example/6400', 'host and port appended, one slash');
  expect(defaultRelayBase({ hostname: 'localhost', host: 'localhost:6464', protocol: 'http:' }) === 'ws://localhost:6464/relay', 'localhost: the app\'s own relay');
  expect(defaultRelayBase({ hostname: '127.0.0.1', host: '127.0.0.1:5173', protocol: 'https:' }) === 'wss://127.0.0.1:5173/relay', 'https gives wss');
  expect(defaultRelayBase({ hostname: 'c64ready.com', host: 'c64ready.com', protocol: 'https:' }) === '', 'the public site has no relay of its own');
  ok('relay addresses: the same-origin relay on localhost, none elsewhere');
}

{
  let status = '';
  const ctl = createBrowserHost({ meta, panelHost: null, setStatus: (t) => { status = t; }, relayBase: () => '' });
  const { host } = ctl;
  host.storage.set('settings', { e: 0 });
  expect(JSON.stringify(host.storage.get('settings')) === '{"e":0}', 'storage round trip');
  expect(mem.has('c64emu.userport.dev.example.test.settings'), 'stored under the device id');
  expect(host.storage.get('missing') === null, 'a missing key reads null');
  let frames = 0;
  host.onFrame(() => { frames++; });
  ctl.frame(); ctl.frame();
  host.status('ready');
  expect(frames === 2 && status === 'ready', 'frame hooks and status reach the card');
  expect(host.panel === null, 'no panel without a panel element');
  expect(host.audio() === null, 'audio is optional before the app initializes it');
  expect(host.icons.speakerOn.includes('spk-on') && host.icons.speakerMute.includes('spk-mute'), 'the shared speaker icons are available to panels');
  ctl.dispose();
  ctl.frame();
  expect(frames === 2, 'dispose drops the frame hooks');
  ok('host storage is per device, frame hooks run per frame, dispose stops them');
}

{
  const opts = { meta, panelHost: null, setStatus() {}, relayBase: () => 'ws://local.example/relay' };
  mem.set('c64emu.userport.relay', 'wss://legacy.example/relay');
  const ctl = createBrowserHost(opts);
  expect(ctl.host.relay.get() === 'wss://legacy.example/relay', 'the device inherits the previous relay setting');
  expect(ctl.host.relay.set('wss://device.example/relay'), 'a device saves its own relay');
  expect(!ctl.host.relay.set('https://invalid.example/relay') && ctl.host.relay.get() === 'wss://device.example/relay', 'invalid relay schemes leave the current configuration alone');
  ctl.dispose();
  const again = createBrowserHost(opts);
  expect(again.host.relay.get() === 'wss://device.example/relay', 'the per-device setting survives re-creation');
  again.host.relay.set('');
  expect(again.host.relay.get() === '' && again.host.relay.defaultBase() === 'ws://local.example/relay', 'empty selects the local default rather than reviving the old global setting');
  again.dispose();
  mem.delete('c64emu.userport.relay');
  mem.delete(`c64emu.userport.dev.${meta.id}.relay`);
  ok('device-owned relay controls have validated, persistent settings and a local default');
}

{
  const ctl = createBrowserHost({ meta, panelHost: null, setStatus: () => {}, relayBase: () => '' });
  const s = ctl.host.openSocket('ECHO', 23);
  const got = [];
  let opened = false, closed = null;
  s.onopen = () => { opened = true; s.send([0x41, 0x42]); };
  s.ondata = (b) => got.push(...b);
  s.onclose = (why) => { closed = why; };
  await until(() => got.length === 2);
  expect(opened && got.join(',') === '65,66', `loopback echoes, got ${got}`);
  ctl.dispose();
  await until(() => closed !== null);
  expect(closed === 'closed', 'dispose closes open connections');
  ok('the echo host loops back without a relay');
}

{
  const ctl = createBrowserHost({ meta, panelHost: null, setStatus: () => {}, relayBase: () => '' });
  const s = ctl.host.openSocket('bbs.example', 6400);
  let closed = null;
  s.onclose = (why) => { closed = why; };
  await until(() => closed !== null);
  expect(closed === 'no relay', `no relay set: the connection fails at once, got ${closed}`);
  ok('without a relay, a connection reports "no relay"');
}

{
  const echo = net.createServer((sock) => sock.on('data', (d) => sock.write(d)));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const server = http.createServer();
  attachRelay(server, { allowLocal: true });   // the echo server is on this machine
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `ws://127.0.0.1:${server.address().port}/relay`;
  const ctl = createBrowserHost({ meta, panelHost: null, setStatus: () => {}, relayBase: () => base });

  const s = ctl.host.openSocket('127.0.0.1', echo.address().port);
  const got = [];
  s.onopen = () => { s.send([1, 2]); s.send([3]); };
  s.ondata = (b) => got.push(...b);
  await until(() => got.length === 3);
  expect(got.join(',') === '1,2,3', `bytes sent through the relay come back, got ${got}`);

  const closedPort = await new Promise((r) => { const t = net.createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => r(p)); }); });
  const f = ctl.host.openSocket('127.0.0.1', closedPort);
  let why = null;
  f.onclose = (w) => { why = w; };
  await until(() => why !== null);
  expect(why === 'failed', `a refused connection reports "failed", got ${why}`);

  // The far end hangs up: the device hears "closed" after the data.
  const bye = net.createServer((sock) => sock.end('BYE'));
  await new Promise((r) => bye.listen(0, '127.0.0.1', r));
  const s2 = ctl.host.openSocket('127.0.0.1', bye.address().port);
  const said = [];
  let remote = null;
  s2.ondata = (b) => said.push(...b);
  s2.onclose = (w) => { remote = w; };
  await until(() => remote !== null);
  expect(String.fromCharCode(...said) === 'BYE' && remote === 'closed', `far end hangs up: data then "closed", got ${JSON.stringify(String.fromCharCode(...said))} ${remote}`);
  s.close();
  echo.close();
  bye.close();
  ctl.dispose();
  server.close();
  ok('through the relay: data both ways, refused connections fail, a hang-up reports "closed"');
}

console.log(failing ? `\n${failing} of ${testNo} FAILED` : `\nall ${testNo} passed`);
process.exit(failing ? 1 : 0);
