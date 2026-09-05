// Spec test for the tape writer's pure parts (cli/tapewrite.mjs): the names a
// SAVE can carry, and the window the KERNAL's SAVE can reach. The window's
// numbers are the machine's own: below $0800 sit the pages the machine uses to
// do the saving, from $D000 up sit the I/O registers and the ROM the SAVE runs
// from — unreachable on a real machine too. The save itself boots an emulator
// and is checked by hand, like run and loadtest.
import { tapeName, saveName, unsaveable } from '../tapewrite.mjs';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  if (actual !== expected) { console.error(`FAIL: ${msg} — expected ${expected}, got ${actual}`); failures++; }
}

// A filename becomes a tape name: extension shed, PETSCII-shaped, 16 kept.
eq(tapeName('Bomb_Jack.tap'), 'BOMB JACK', 'a filename sheds its extension and its underscores');
eq(tapeName('x.prg'), 'X', 'a short name stays short');
eq(tapeName('???.prg'), 'PROGRAM', 'a name with nothing typable left gets one anyone can type');

// An archive entry's name already is a tape name: nothing to shed.
eq(saveName('CHOPPER DEMO/TSW'), 'CHOPPER DEMO/TSW', 'a full 16-character name survives whole');
eq(saveName('V2.0'), 'V2.0', 'a dot in an entry name is not an extension');
eq(saveName('A"B'), 'A B', 'a quote cannot break out of the SAVE the stub is given');

// The window. Cybernoid II+ ends at $A6EE — past the top of BASIC memory,
// which the banked SAVE reaches; past $D000 nothing can.
eq(unsaveable(0x0801, 0xA6EE), null, 'a file under BASIC ROM is saveable');
eq(unsaveable(0xCC49, 0xCCF9), null, 'so is one in the high RAM at $C000');
assert(/working space/.test(unsaveable(0x0400, 0x0500)), 'the screen and system pages are not');
assert(/\$D000/.test(unsaveable(0xE000, 0xFFF0)), 'nor is anything past $D000');
assert(/\$D000/.test(unsaveable(0x0800, 0x10000)), 'a file filling memory to the top names the same wall');

if (failures) {
  console.error(`\n${failures} tapewrite assertion(s) failed`);
  process.exit(1);
}
console.log('cli tapewrite spec: PASS');
