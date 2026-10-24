// A UP9600 driver talking to the Modem at 9600 baud through the CIA shift
// registers, the way Daniel Dallmann's UP9600 (used by CCGMS and Novaterm)
// does it:
//  - Sending: CIA1 Timer A at half the bit time clocks the SDR out on SP1,
//    which the UP9600 bridges to TXD. A byte goes as two SDR bytes, MSB first:
//    the start bit and data bits 0-6, then bit 7 and seven stop bits.
//  - Receiving: the start bit's falling edge on FLAG2 interrupts (NMI) and
//    starts CIA2 Timer B at the bit time, pulsing PB7, bridged to CNT2. Each
//    pulse shifts RXD (bridged to SP2) into CIA2's SDR, and the eighth raises
//    another NMI that reads the byte and waits for the next start bit.
// Timer values are the PAL ones UP9600 uses for 9600 baud: 51 and 102.

import { C64Machine } from '../../src/machine.js';
import { readAsset, missingNote } from '../external-assets.js';
import { plugDevice } from '../../cli/userport.mjs';
import { type, screen } from '../../cli/tapeload.mjs';

const kernal = readAsset('kernal'), basic = readAsset('basic'), charRom = readAsset('chargen');
if (!kernal || !basic || !charRom) {
  console.log(`# SKIP ${missingNote(kernal ? (basic ? 'chargen' : 'basic') : 'kernal')}`);
  process.exit(0);
}

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

// A few lines of 6502 with labels: numbers are bytes, 'name:' defines a label,
// ['abs', 'name'] / ['lo', 'name'] / ['hi', 'name'] / ['rel', 'name'] refer to one.
function assemble(org, code) {
  const labels = {}, out = [];
  for (let pass = 0; pass < 2; pass++) {
    out.length = 0;
    for (const item of code) {
      if (typeof item === 'string') { labels[item.slice(0, -1)] = org + out.length; continue; }
      if (typeof item === 'number') { out.push(item); continue; }
      const [kind, name] = item;
      const at = labels[name] ?? 0;
      if (kind === 'abs') out.push(at & 0xFF, at >> 8);
      else if (kind === 'lo') out.push(at & 0xFF);
      else if (kind === 'hi') out.push(at >> 8);
      else if (kind === 'rel') out.push((at - (org + out.length + 1)) & 0xFF);
    }
  }
  return out;
}

const ORG = 0xC000, BUF = 0xC800, REV = 0xCA00, PTR = 0xFB, XSAVE = 0xFC;

function driver(message) {
  return assemble(ORG, [
    0x78,                               // SEI
    0xA9, 0x7F, 0x8D, 0x0D, 0xDC,       // LDA #$7F, STA $DC0D: no CIA1 IRQs
    0x8D, 0x0D, 0xDD,                   // STA $DD0D: no CIA2 NMIs
    0xAD, 0x0D, 0xDC, 0xAD, 0x0D, 0xDD, // LDA $DC0D, LDA $DD0D: clear both
    0xA9, 0x00, 0x85, PTR,              // receive buffer empty
    0xA9, ['lo', 'nmi'], 0x8D, 0x18, 0x03,
    0xA9, ['hi', 'nmi'], 0x8D, 0x19, 0x03,
    0xA9, 51, 0x8D, 0x04, 0xDC, 0xA9, 0x00, 0x8D, 0x05, 0xDC,
    0xA9, 0x51, 0x8D, 0x0E, 0xDC,       // CIA1 CRA: SP out, load, start
    0xA9, 102, 0x8D, 0x06, 0xDD, 0xA9, 0x00, 0x8D, 0x07, 0xDD,
    0xA9, 0x92, 0x8D, 0x0F, 0xDD,       // CIA2 CRB: PB7 on, load, stopped
    0xA9, 0xFF, 0x8D, 0x01, 0xDD,       // PB all high
    0xA9, 0x02, 0x8D, 0x03, 0xDD,       // RTS is the only output
    0xAD, 0x00, 0xDD, 0x09, 0x04, 0x8D, 0x00, 0xDD,   // PA2 (TXD) high
    0xA9, 0x98, 0x8D, 0x0D, 0xDD,       // NMI on FLAG and SDR
    0xA9, 0xFF, 0x8D, 0x0C, 0xDC,       // SP1 idles high
    0x20, ['abs', 'waitsp'],
    0xA2, 0x00,                         // LDX #0
    'send:',
    0xBD, ['abs', 'msg'],               // LDA msg,X
    0xF0, ['rel', 'done'],
    0x20, ['abs', 'put'],
    0xE8, 0xD0, ['rel', 'send'],        // INX, BNE send
    'done:',
    0x4C, ['abs', 'done'],
    'put:',
    0x86, XSAVE, 0xAA,                  // STX, TAX
    0xBD, REV & 0xFF, REV >> 8,         // LDA rev,X: bit order reversed
    0x4A, 0x8D, 0x0C, 0xDC,             // LSR: start bit in, STA $DC0C
    0x6A, 0x09, 0x7F, 0x8D, 0x0C, 0xDC, // ROR, ORA #$7F: bit 7 and stop bits
    0x20, ['abs', 'waitsp'], 0x20, ['abs', 'waitsp'],
    0xA6, XSAVE, 0x60,
    'waitsp:',
    0xAD, 0x0D, 0xDC, 0x29, 0x08, 0xF0, ['rel', 'waitsp'], 0x60,
    'nmi:',
    0x48, 0x8A, 0x48,                   // PHA, TXA, PHA
    0xAD, 0x0D, 0xDD, 0x29, 0x08,       // LDA $DD0D, AND #$08
    0xD0, ['rel', 'byte'],
    0xA9, 0x13, 0x8D, 0x0F, 0xDD,       // start bit: Timer B on, pulses on PB7
    0x8D, 0x0D, 0xDD,                   // only the SDR NMI now
    0x4C, ['abs', 'out'],
    'byte:',
    0xA9, 0x92, 0x8D, 0x0F, 0xDD,       // Timer B off
    0xA9, 0x90, 0x8D, 0x0D, 0xDD,       // FLAG NMI back on
    0xAE, 0x0C, 0xDD,                   // LDX $DD0C
    0xBD, REV & 0xFF, REV >> 8,         // LDA rev,X
    0xA6, PTR, 0x9D, BUF & 0xFF, BUF >> 8, 0xE6, PTR,
    'out:',
    0x68, 0xAA, 0x68, 0x40,             // PLA, TAX, PLA, RTI
    'msg:',
    ...[...message].map((c) => c.charCodeAt(0)), 0,
  ]);
}

async function run(message, seconds) {
  const m = new C64Machine();
  m.loadROMs({ kernal: new Uint8Array(kernal), basic: new Uint8Array(basic), charRom: new Uint8Array(charRom) });
  const dev = await plugDevice(m, 'wifi-modem');
  for (let i = 0; i < 400 && !/READY\./.test(screen(m)); i++) m.runFrame();
  driver(message).forEach((b, i) => { m.mem.ram[ORG + i] = b; });
  for (let i = 0; i < 256; i++) {
    let r = 0;
    for (let b = 0; b < 8; b++) r |= ((i >> b) & 1) << (7 - b);
    m.mem.ram[REV + i] = r;
  }
  type(m, `SYS${ORG}\r`);
  for (let i = 0; i < 50 * seconds; i++) { m.runFrame(); dev.frame(); }
  const n = m.mem.ram[PTR];
  const text = String.fromCharCode(...m.mem.ram.subarray(BUF, BUF + n));
  const state = dev.device.state;
  const err = dev.error();
  dev.dispose();
  return { text, state, err };
}

{
  const { text, state, err } = await run('AT\r', 1);
  expect(!err, `no device error: ${err}`);
  expect(state.baud === 9600, `the modem found 9600 baud from the first A: ${state.baud}`);
  expect(text === 'AT\r\r\nOK\r\n', `echo and OK come back through CIA2's SDR: ${JSON.stringify(text)}`);
  ok('UP9600 at 9600 baud: a command goes out through CIA1 and the answer comes back through CIA2');
}

{
  const { text } = await run('ATE0I\r', 2);
  const lines = text.split('\r\n').filter(Boolean);
  expect(text.startsWith('ATE0I\r') && lines.includes('OK') && /C64 READY\. MODEM/.test(text),
    `a run of back-to-back bytes arrives whole: ${JSON.stringify(text)}`);
  ok('UP9600 at 9600 baud: a burst of back-to-back bytes arrives without loss');
}

console.log(failing ? `\n${failing} of ${testNo} FAILED` : `\nall ${testNo} passed`);
process.exit(failing ? 1 : 0);
