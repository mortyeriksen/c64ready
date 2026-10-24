// The KERNAL's own RS-232 driver talking to the Modem through the user
// port: BASIC opens device 2, sends commands with PRINT# and collects the
// answer with GET#.
// The control register baud codes are the Programmer's Reference Guide's
// (RS-232 interface, control register map): 0110 = 300, 1000 = 1200. 2400 is
// marked not implemented there, so it is not tested. The modem is plugged in
// through the CLI's Node host (cli/userport.mjs), which this also covers.

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

const BUF = 49152;

async function run(controlCode, lines, seconds) {
  const m = new C64Machine();
  m.loadROMs({ kernal: new Uint8Array(kernal), basic: new Uint8Array(basic), charRom: new Uint8Array(charRom) });
  const dev = await plugDevice(m, 'wifi-modem');
  for (let i = 0; i < 400 && !/READY\./.test(screen(m)); i++) m.runFrame();
  m.mem.ram.fill(0, BUF, BUF + 256);
  type(m, [`10 OPEN 2,2,0,CHR$(${controlCode})`, '15 GET#2,A$', ...lines, 'RUN', ''].join('\r'));
  for (let i = 0; i < 50 * seconds; i++) { m.runFrame(); dev.frame(); }
  let text = '';
  for (let i = 0; i < 256; i++) {
    const b = m.mem.ram[BUF + i];
    if (!b) break;
    text += String.fromCharCode(b);
  }
  const err = dev.error();
  const settings = dev.device.serialize().settings;
  dev.dispose();
  return { text, err, settings };
}

// 300 baud both ways. Echo goes off first: a modem echoes each character
// while the KERNAL is still sending the next one, which the KERNAL's own
// driver does not receive reliably (VICE shows the same).
{
  const { text, err } = await run(6, [
    '20 PRINT#2,"ATE0";CHR$(13);',
    '25 FOR I=1 TO 900:NEXT',
    '26 GET#2,A$:IF A$<>"" THEN 26',
    '27 PRINT#2,"ATI";CHR$(13);',
    `30 GET#2,A$:IF A$<>"" THEN POKE ${BUF}+N,ASC(A$):N=N+1`,
    '40 GOTO 30',
  ], 14);
  expect(!err, `the device ran without error: ${err?.message}`);
  expect(text.startsWith('\r\nC64 READY. MODEM'), `the ATI answer arrived intact, got ${JSON.stringify(text)}`);
  expect(/\r\nOK\r\n$/.test(text), `the answer ends with OK, got ${JSON.stringify(text.slice(-12))}`);
  ok('KERNAL RS-232 at 300 baud (control register 6): ATI out with PRINT#, answer back with GET#');
}

// 1200 baud, C64 to modem: the modem acts on what the KERNAL sends.
{
  const { err, settings } = await run(8, [
    '20 PRINT#2,"ATE0V0";CHR$(13);',
    '30 GOTO 30',
  ], 4);
  expect(!err, `the device ran without error: ${err?.message}`);
  expect(settings.echo === 0 && settings.verbose === 0, `ATE0V0 sent by the KERNAL at 1200 baud took effect: E${settings.echo} V${settings.verbose}`);
  ok('KERNAL RS-232 at 1200 baud (control register 8): the modem understands PRINT#');
}

console.log(failing ? `\n${failing} of ${testNo} FAILED` : `\nall ${testNo} passed`);
process.exit(failing ? 1 : 0);
