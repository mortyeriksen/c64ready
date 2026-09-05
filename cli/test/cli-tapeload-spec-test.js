// Spec test for the rules the loading engine keeps that are not about running a
// machine (cli/tapeload.mjs): which command a turbo loader is offered, which
// formats take no command at all, which files cannot be judged, and what counts
// as a file taking the machine.
import { commandsFor, tailIsBlind, tookOver, selfDriving, loaderTapeNote } from '../tapeload.mjs';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL: ${msg} — expected ${e}, got ${a}`); failures++; }
}

const WEDGE = String.fromCharCode(0x5F) + 'L\r';   // ←L

// The encoding names the family, not the tool that wrote the tape, and the
// tools within a family do not all listen for the same thing. Every format
// gets the wedge somewhere in its list, because most of them answer to it.
{
  eq(commandsFor({ format: 'Turbo Tape 64' }), [WEDGE, 'LOAD\r'],
    'a Turbo Tape 64 tape is offered ←L, then plain LOAD — Turbo Tape 64 itself patches the KERNAL\'s');
  eq(commandsFor({ format: 'GRL-Supertape' }), ['SYS300\r', WEDGE],
    'GRL-Supertape is started with SYS300, the address its own loader lives at');
  eq(commandsFor({ format: 'Some Unknown Turbo' }), [WEDGE],
    'an unrecognised format still gets the wedge, which most tools answer to');
  for (const format of ['Turbo Tape 64', 'GRL-Supertape', 'Whatever']) {
    assert(commandsFor({ format }).includes(WEDGE), `${format} is offered the wedge at some point`);
  }
}

// A turbo file is judged from its own bytes: a sentinel is stamped over the
// tail of the range and the load counts once the tape has overwritten it. That
// only proves anything where the machine would not have written there anyway.
// The tail is what matters, not the whole range: a file may begin in the
// KERNAL's workspace and still end somewhere nobody else touches.
{
  const blind = (start, end) => tailIsBlind({ start, end });

  assert(blind(0x0400, 0x0600), 'a file ending in the screen cannot be judged: the KERNAL prints over it as it loads');
  assert(blind(0x0800, 0x10000), 'nor one ending in the page under the ROM, where a loader parks its own vectors');
  assert(blind(0xE000, 0xFFF0), 'nor one ending just below it');
  assert(blind(0x02A7, 0x0304), 'nor one ending among the KERNAL vectors');

  assert(!blind(0x0801, 0x9FFF), 'an ordinary program ends in plain RAM and can be judged');
  assert(!blind(0x0300, 0x9000), 'and so can one that merely begins in the workspace: the tail decides');
  assert(!blind(0x0801, 0xFEFF), 'the page below the vectors is still plain RAM');
}

// A format read out of the loader the tape carries takes no command per file.
// The reader is installed by the boot block and reads the side in tape order, so
// there is nothing to type and nothing to seek back to. Offering such a file the
// wedge types Left-arrow L at a machine that has no wedge installed, and the
// file is then written off as never finished. Listing a block's address does not
// make it loadable on its own: all three of these name their blocks, and Gremlin
// Type 2 keeps a directory.
{
  for (const format of ['Novaload', 'US Gold / Datasoft', 'Gremlin Type 2',
                        'Ocean / Imagine', 'Freeload', 'Wildload']) {
    assert(selfDriving({ format }),
      `${format} carries its own reader, so its tape drives the load and no command does`);
  }
  assert(!selfDriving({ format: 'Turbo Tape 64' }),
    'Turbo Tape 64 patches the KERNAL\'s LOAD and takes a command per file');
  assert(!selfDriving({ format: 'GRL-Supertape' }),
    'GRL-Supertape is entered at SYS300 per file');
  assert(!selfDriving({ format: 'CBM' }),
    'a KERNAL file is loaded by the KERNAL, not by a loader the tape carries');
}

// A tape read by its own loader yields blocks, not programs, and the report
// must say so: the entry point lives in the loader, and a loader that streams
// the tape as the game plays leaves nothing that stands alone at all.
{
  const f = (format, start, damaged = false) => ({ format, start, damaged });

  assert(loaderTapeNote([f('CBM', 0x0801), f('Turbo Tape 64', 0x0801)]) === null,
    'a turbo tape gets no note: its files are programs');
  assert(loaderTapeNote([f('CBM', 0x02A7), f('Novaload', 0x0800)]) !== null,
    'a tape with a carried reader gets the note');
  const streams = loaderTapeNote([f('CBM', 0x02A7),
    f('US Gold / Datasoft', 0x0800), f('US Gold / Datasoft', 0x4140), f('US Gold / Datasoft', 0x4140)]);
  assert(/as the game plays/.test(streams),
    'blocks landing at one address twice mean the loader streams, and the note says so');
  const single = loaderTapeNote([f('CBM', 0x02A7), f('Novaload', 0x0800), f('Novaload', 0xE000)]);
  assert(/starts the game itself/.test(single),
    'distinct addresses mean one load, and the note blames the missing entry point');
  assert(loaderTapeNote([f('CBM', 0x02A7), f('Novaload', 0x0800, true)]) === null,
    'a damaged block does not make a tape a loader tape by itself');
}

// A file that means to start itself has to write one of the KERNAL's RAM
// vectors over with an address of its own: that is the only way to take the
// machine without a person typing RUN, and it is what an autostarting tape
// loader does. HEMAN on the Masters of the Universe tape moves $0302 (BASIC's
// main loop) from its reset value $A483 to $02A7, its own first byte.
{
  const heman = { start: 0x02A7, end: 0x0304 };
  const reset = [0xE38B, 0xA483, 0xA57C, 0xA71A, 0xA7E4, 0xAE86];   // IERROR … IEVAL

  eq(tookOver(reset, reset, heman), false, 'vectors that have not moved are not a takeover');
  eq(tookOver(reset, [0xE38B, 0x02A7, 0xA57C, 0xA71A, 0xA7E4, 0xAE86], heman), true,
    'a vector moved to point inside the file is the file saying it has arrived and is in charge');
  eq(tookOver(reset, [0xE38B, 0x8000, 0xA57C, 0xA71A, 0xA7E4, 0xAE86], heman), false,
    'a vector moved somewhere else is somebody else\'s business');

  // The trap the rule has to avoid: a file loading under BASIC ROM contains
  // $A483 in its own range from the start, so "points inside" alone would call
  // it loaded before a byte had arrived.
  const underBasic = { start: 0xA000, end: 0xC000 };
  eq(tookOver(reset, reset, underBasic), false,
    'an unchanged vector that happens to fall inside the range is not a takeover');
  eq(tookOver(reset, [0xE38B, 0xA500, 0xA57C, 0xA71A, 0xA7E4, 0xAE86], underBasic), true,
    'the same range with a vector actually moved inside it is one');
}

if (failures) {
  console.error(`\n${failures} tapeload assertion(s) failed`);
  process.exit(1);
}
console.log('cli tapeload spec: PASS');
