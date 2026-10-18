// The LED board plugin (public/userport/led-board.js), the example device the
// docs walk through, run as an installed plugin would be: imported from its
// source text, checked, and plugged into a machine. CIA2 port B rules from the
// 6526 datasheet: outputs drive the latch, inputs read the pin.

import fs from 'node:fs';
import { C64Machine } from '../../src/machine.js';
import { importDeviceSource, validateDeviceModule } from '../../src/userport/plugins.js';

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

const src = fs.readFileSync(new URL('../../public/userport/led-board.js', import.meta.url), 'utf8');
const mod = await importDeviceSource(src);
const meta = validateDeviceModule(mod);
expect(meta.id === 'example.led-board', `installable as ${meta.id}`);
expect(!/^\s*import\s/m.test(src), 'self-contained: no imports');
ok('the LED board passes the install checks');

const m = new C64Machine();
m.reset();
let statusText = '';
const dev = m.attachUserport(meta.id, (port) => mod.create(port, { status: (t) => { statusText = t; }, onFrame: () => {} }), meta.version);

m.cia2.write(0x03, 0xFF);                        // POKE 56579,255: all outputs
m.cia2.write(0x01, 0xAA);                        // POKE 56577,170
expect(dev.pins === 0xAA, `the board sees $AA on PB, got $${dev.pins.toString(16)}`);
ok('POKE 56577 with PB as outputs drives the LED lines');

m.cia2.write(0x03, 0x00);                        // POKE 56579,0: all inputs
dev.setSwitches(0x81);                           // PB7 and PB0 closed
expect(m.cia2.read(0x01) === 0x7E, `PEEK(56577) reads the switches, got $${m.cia2.read(0x01).toString(16)}`);
m.cia2.write(0x03, 0x01);                        // PB0 output, latch bit 0 = 0 from $AA
expect((m.cia2.read(0x01) & 0x01) === 0, 'an output pin reads its latch, not the switch');
ok('closed switches pull input lines low for PEEK(56577)');

const snap = m.serializeState();
const m2 = new C64Machine();
m2.reset();
const dev2 = m2.attachUserport(meta.id, (port) => mod.create(port, null), meta.version);
m2.restoreState(snap);
m2.cia2.write(0x03, 0x00);
expect(m2.cia2.read(0x01) === 0x7E, 'switch positions come back with a save state');
ok('the switches survive a save state');

{
  const doc = fs.readFileSync(new URL('../../docs/USERPORT-DEVICES.md', import.meta.url), 'utf8');
  const m = /<!-- example: public\/userport\/led-board\.js -->\n```js\n([\s\S]*?)```/.exec(doc);
  expect(m && m[1] === src, 'the docs show the LED board exactly as shipped');
  ok('the example in docs/USERPORT-DEVICES.md is the shipped file');
}

console.log(failing ? `\n${failing} of ${testNo} FAILED` : `\nall ${testNo} passed`);
process.exit(failing ? 1 : 0);
