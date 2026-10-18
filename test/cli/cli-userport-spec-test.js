// User port devices in the CLI (cli/userport.mjs, run --userport): loading a
// device file or a built-in by name with the same checks as the browser, the
// Node host's sockets, a throwing device being caught, and a real run that
// drives a device from a program.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadDevice, createNodeHost, plugDevice } from '../../cli/userport.mjs';
import { run } from '../../cli/run.mjs';
import { UsageError } from '../../cli/args.mjs';
import { setQuiet } from '../../cli/report.mjs';
import { C64Machine } from '../../src/machine.js';
import { readAsset } from '../external-assets.js';

let failures = 0;
function assert(cond, msg) { if (!cond) { console.error(`FAIL: ${msg}`); failures++; } }
const until = (pred, ms = 3000) => new Promise((resolve) => {
  const t0 = Date.now();
  const tick = () => (pred() || Date.now() - t0 > ms ? resolve(pred()) : setTimeout(tick, 10));
  tick();
});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c64rdy-userport-'));
const LED = new URL('../../public/userport/led-board.js', import.meta.url).pathname;

// ── Loading ────────────────────────────────────────────────────────────────
{
  const modem = await loadDevice('wifi-modem');
  assert(modem.meta.id === 'builtin.wifi-modem' && modem.file === null, 'wifi-modem loads the built-in modem by name');
  const led = await loadDevice(LED);
  assert(led.meta.id === 'example.led-board' && typeof led.mod.create === 'function', 'a device file loads by path');
  const bad = path.join(tmp, 'bad.js');
  fs.writeFileSync(bad, "export const meta = { id: 'builtin.mine', name: 'x', version: '1', apiVersion: 1 };\nexport function create() { return {}; }\n");
  let err = null;
  try { await loadDevice(bad); } catch (e) { err = e; }
  assert(err && /reserved/.test(err.message), `a file claiming a builtin id is refused like in the browser: ${err?.message}`);
  err = null;
  try { await loadDevice(path.join(tmp, 'nope.js')); } catch (e) { err = e; }
  assert(err && /no device file/.test(err.message) && /wifi-modem/.test(err.message), 'a missing file names the built-ins');
  err = null;
  try { await loadDevice('constructor'); } catch (e) { err = e; }
  assert(err && /no device file/.test(err.message), `only real built-in names count: ${err?.message}`);
}

// ── The Node host ──────────────────────────────────────────────────────────
{
  const ctl = createNodeHost({ id: 'example.test' });
  ctl.host.storage.set('k', { a: 1 });
  assert(ctl.host.storage.get('k').a === 1 && ctl.host.storage.get('x') === null, 'storage kept in memory');
  assert(ctl.host.panel === null, 'no panel in the CLI');

  const loop = ctl.host.openSocket('echo', 23);
  const got = [];
  loop.onopen = () => loop.send([7, 8]);
  loop.ondata = (b) => got.push(...b);
  await until(() => got.length === 2);
  assert(got.join(',') === '7,8', 'the echo host loops back');

  const echo = net.createServer((s) => s.on('data', (d) => s.write(d)));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const tcp = ctl.host.openSocket('127.0.0.1', echo.address().port);
  const back = [];
  tcp.onopen = () => tcp.send([0x41, 0xff]);
  tcp.ondata = (b) => back.push(...b);
  await until(() => back.length === 2);
  assert(back.join(',') === '65,255', 'sockets connect straight to TCP, no relay');

  const closedPort = await new Promise((r) => { const t = net.createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => r(p)); }); });
  const f = ctl.host.openSocket('127.0.0.1', closedPort);
  let why = null;
  f.onclose = (w) => { why = w; };
  await until(() => why !== null);
  assert(why === 'failed', `a refused connection reports "failed": ${why}`);
  ctl.dispose();
  echo.close();
}

// ── A device that throws is caught ─────────────────────────────────────────
{
  const file = path.join(tmp, 'throws.js');
  fs.writeFileSync(file, "export const meta = { id: 'example.throws', name: 'x', version: '1', apiVersion: 1 };\nexport function create() { return { onPortB() { throw new Error('boom'); } }; }\n");
  const m = new C64Machine();
  m.reset();
  const dev = await plugDevice(m, file);
  m.cia2.write(0x03, 0x01);
  assert(dev.error() && dev.error().message === 'boom', 'the exception is kept for the run to report');
  assert(m.userport.device === null, 'and the device is unplugged');
  dev.dispose();
}

// ── run --userport ─────────────────────────────────────────────────────────
setQuiet(true);
{
  // A real (empty) TAP v1 file, so the run sees a tape.
  const tap = path.join(tmp, 'x.tap');
  const head = Buffer.alloc(20);
  head.write('C64-TAPE-RAW', 0, 'latin1');
  head[12] = 1;
  fs.writeFileSync(tap, head);
  const d64 = path.join(tmp, 'x.d64');
  fs.writeFileSync(d64, Buffer.alloc(174848));
  for (const [argv, why] of [[[tap, '--userport', 'wifi-modem'], 'a tape run'], [[d64, '--all', '--userport', 'wifi-modem'], 'an --all run']]) {
    let threw = null;
    try { await run(argv); } catch (e) { threw = e; }
    assert(threw instanceof UsageError && /--userport/.test(threw.message), `--userport refused with ${why}: ${threw?.message}`);
  }
}

const roms = readAsset('kernal') && readAsset('basic') && readAsset('chargen');
if (!roms) {
  console.log('ok  - run --userport drives a device # SKIP no C64 ROMs');
} else {
  // 10 SYS 2061, then: LDA #$FF / STA $DD03 / LDA #$AA / STA $DD01 / JMP *.
  const prg = path.join(tmp, 'leds.prg');
  fs.writeFileSync(prg, Buffer.from([
    0x01, 0x08,
    0x0b, 0x08, 10, 0, 0x9e, ...Buffer.from('2061'), 0,
    0, 0,
    0xa9, 0xff, 0x8d, 0x03, 0xdd, 0xa9, 0xaa, 0x8d, 0x01, 0xdd, 0x4c, 0x17, 0x08,
  ]));
  const recorder = path.join(tmp, 'recorder.js');
  const seen = path.join(tmp, 'seen.json');
  fs.writeFileSync(recorder, `import fs from 'node:fs';
export const meta = { id: 'example.recorder', name: 'Recorder', version: '1', apiVersion: 1 };
export function create(port) { return { onPortB(pb) { fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify(pb)); } }; }
`);
  const t0 = Date.now();
  await run([prg, '--userport', recorder, '--frames', '25', '-o', path.join(tmp, 'out.png')]);
  const secs = (Date.now() - t0) / 1000;
  const last = fs.existsSync(seen) ? JSON.parse(fs.readFileSync(seen, 'utf8')) : null;
  assert(last === 170, `the program's POKE 56577,170 reached the device: ${last}`);
  assert(secs >= 0.45, `the run kept to real time with a device plugged in (25 frames, ${secs.toFixed(2)} s)`);
  assert(fs.existsSync(path.join(tmp, 'out.png')), 'the screenshot is still written');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} userport assertion(s) failed` : 'cli userport spec: PASS');
process.exit(failures ? 1 : 0);
