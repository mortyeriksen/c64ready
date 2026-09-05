// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/loader.mjs — what loader is on this tape, and how does it read a bit?
//
// A tape whose format nothing here knows still carries the program that reads
// it: the KERNAL block it boots from is that loader, or fetches it. So the way
// to learn an unknown format is to take the loader out and read it, and the
// three commercial formats in `../src/tap-turbo-formats.js` were all
// got that way. Every one of them cost hours of the same handwork, which is
// what this does instead:
//
//   the pulse widths the tape actually holds, which name the symbols
//   the KERNAL blocks, loaded through the ROM and disassembled
//   the machine run until the loader takes it, and where it then executes
//   the CIA registers it touched, and the bit threshold they imply
//   the whole of memory, on request, for reading elsewhere
//
// It answers nothing on its own. It puts in one place the five things that
// were needed each time, so the reading is the work rather than the digging.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, numberFlag, UsageError } from './args.mjs';
import { say, columns, mss } from './report.mjs';
import { resolveRoms } from './roms.mjs';
import { loadMachine, PAL_CPU_HZ } from './core.mjs';
import { disasm } from './disasm6502.mjs';
import { readTape, pressGo, type, tookOver } from './tapeload.mjs';

// Where a loader parks its reader. The tape buffer is the usual choice, since
// the KERNAL has finished with it by then.
const VECTORS = { 0x0314: 'IRQ', 0x0318: 'NMI', 0xFFFA: 'NMI (under ROM)', 0xFFFE: 'IRQ (under ROM)' };
// The two under the ROM are read out of RAM deliberately, since that is what a
// loader writes there, but the CPU only takes them when the ROM is banked out.
// Until then whatever they hold is whatever was never written, so they are not
// worth calling moved.
const UNDER_ROM = new Set([0xFFFA, 0xFFFE]);
const DISASM_LINES = 48;
const SECOND_CLUSTER_SHARE = 0.05;      // of the busiest, for the other to be real
const SYMBOL_GAP = 0.25;                // how far apart two widths must sit to be two symbols
const PULSE_FLOOR = 100, PULSE_CEIL = 1200;   // outside this is not a data pulse
const MIN_RUN = 1000;                   // in-band pulses, below which a stretch says nothing
const RUNS_SHOWN = 3;
const FRAMES_PER_SECOND = 50;
const LOAD_LIMIT = 120;                 // seconds of tape to give one block
// The KERNAL keeps its own account of a load: STATUS clear, and the end pointer
// a file's length past the start it used.
const STATUS = 0x90, LOAD_START = 0xC3, LOAD_END = 0xAE;

export async function run(argv) {
  const { flags, args } = parseArgs(argv, {
    roms: { value: true }, dump: { value: true }, seconds: { value: true },
  });
  if (args.length !== 1) throw new UsageError('Usage: c64rdy loader <tape.tap> [--dump mem.bin]');
  const seconds = numberFlag(flags, 'seconds') ?? 60;
  const tape = readTape(args[0]);

  say(`\n${path.basename(args[0])}`);
  symbols(tape);
  const boots = tape.files.filter(f => f.format === 'CBM' && !f.damaged);
  if (!boots.length) {
    say('\nNo KERNAL block on this tape, so there is nothing here that names its loader.');
    return 1;
  }
  const roms = resolveRoms({ dir: flags.roms });
  const m = await bootBlocks(tape, boots, roms, seconds);
  if (m && flags.dump) {
    fs.writeFileSync(flags.dump, Buffer.from(m.mem.ram));
    say(`\nMemory written to ${flags.dump} (64 KB, address 0 at offset 0).`);
  }
  return m ? 0 : 1;
}

/**
 * The stretches of tape no format here accounts for, and the pulse widths in
 * each. This is where every reading of an unknown loader started.
 *
 * Measured per stretch and never pooled. A tape's leader, and the pilot tone
 * between its blocks, are stretches nothing accounts for too, and each is one
 * width. Pooling them mixes the lead-ins of two different formats into one
 * histogram with two humps, and invents an alphabet that is not there: a Novaload
 * tape pools the KERNAL's 376 cycle leader with its own 304 cycle pilot and comes
 * out looking like a format with two symbols, on a tape that reads perfectly.
 *
 * Widths are taken over the stretch rather than the whole tape for the reason
 * the stretch is worth finding at all: a loader's widths and the KERNAL's
 * collide. A turbo loader writes 512 cycles where the KERNAL's medium pulse is
 * 528, so which belong to which cannot be had from the numbers. The listing already
 * knows what pulses each file covers, so what is left over is the answer.
 */
function symbols({ data, version, files }) {
  const { pulses, cyclesAt } = decodePulses(data, version);
  const measured = unaccountedRuns(pulses.length, files)
    .map(([from, to]) => ({ from, to, ...histogram(pulses, from, to) }))
    .filter(r => r.counted >= MIN_RUN)
    .sort((a, b) => b.counted - a.counted);

  say('\nStretches no format here accounts for');
  if (!measured.length) {
    say('  None worth measuring. Every stretch of this tape long enough to carry a'
      + '\n  program is accounted for by a format that reads it.');
    return;
  }
  const seconds = p => cyclesAt[p] / PAL_CPU_HZ;
  for (const r of measured.slice(0, RUNS_SHOWN)) {
    const span = `${mss(seconds(r.from))}-${mss(seconds(r.to))}`;
    const two = twoSymbols(r.busiest);
    if (!two) {
      say(`\n  ${span}, ${r.counted} pulses, one width around ${r.busiest[0][0]} cycles.`
        + '\n  Lead-in or pilot tone rather than a format: one width carries no bits.');
      continue;
    }
    say(`\n  ${span}, ${r.counted} pulses:`);
    say(columns([['    CYCLES', 'PULSES'],
      ...r.busiest.map(([w, n]) => [`    ${w}`, String(n)])], ['r', 'r']).join('\n'));
    say(`\n  Two symbols, then: ${two[0]} and ${two[1]} cycles, midpoint `
      + `${Math.round((two[0] + two[1]) / 2)}.\n  What the loader below compares against is`
      + ' usually not that midpoint.');
  }
}

/** Every pulse in cycles, and the cycle each one starts at, for naming a time. */
function decodePulses(data, version) {
  const pulses = [];
  const cyclesAt = [];
  let cycles = 0;
  for (let p = 0; p < data.length;) {
    cyclesAt.push(cycles);
    const b = data[p++];
    let c;
    if (b !== 0) c = b * 8;
    else if (version === 0) c = 2048;
    else c = data[p++] | (data[p++] << 8) | (data[p++] << 16);
    pulses.push(c);
    cycles += c;
  }
  return { pulses, cyclesAt };
}

/**
 * The runs of pulses no file covers, as [from, to] pairs. Contiguous runs and
 * not one pooled set: a tape's leader, its inter-block pilot and its trailer are
 * three different stretches, and on a tape read by two formats they carry two
 * different lead-in widths.
 */
export function unaccountedRuns(total, files) {
  const spans = files
    .map(f => [f.leadPulse ?? f.atPulse, Math.max(f.endPulse ?? f.atPulse, f.atPulse)])
    .sort((a, b) => a[0] - b[0]);
  const runs = [];
  let at = 0;
  for (const [from, to] of spans) {
    if (from > at) runs.push([at, from - 1]);
    at = Math.max(at, to + 1);
  }
  if (at < total) runs.push([at, total - 1]);
  return runs;
}

/** The pulse widths over one run, bucketed at the .tap's own 8 cycle step. */
function histogram(pulses, from, to) {
  const buckets = new Map();
  let counted = 0;
  for (let p = from; p <= to; p++) {
    const c = pulses[p];
    if (c < PULSE_FLOOR || c > PULSE_CEIL) continue;
    const k = Math.round(c / 8) * 8;
    buckets.set(k, (buckets.get(k) || 0) + 1);
    counted++;
  }
  const busiest = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  return { counted, busiest };
}

/**
 * The two symbol widths of a run, or null where there is only one.
 *
 * A format writes two widths well apart: the closest pair among the formats read
 * so far is Turbo Tape 64's 216 and 328, half as far again as the quarter asked
 * for here. A lead-in, or the tail of a block the listing stopped just short of,
 * is a single cluster three buckets wide, and calling its edges two symbols would
 * be an invention. The other cluster must be populated as well as far away: a
 * stray pulse at some other width is a mis-timed edge, not half an alphabet.
 */
export function twoSymbols(busiest) {
  if (!busiest.length) return null;
  const [first, most] = busiest[0];
  const other = busiest.find(([w, n]) => Math.abs(w - first) > first * SYMBOL_GAP
    && n > most * SECOND_CLUSTER_SHARE);
  return other ? [first, other[0]].sort((a, b) => a - b) : null;
}

/**
 * Each KERNAL block loaded for real, disassembled where it landed, and then the
 * machine let go so its loader can take over.
 *
 * The load is driven here rather than through `loadtest`'s engine, which wants
 * something different: that engine plays a self-driving side to the end, and by
 * the time it hands the machine back the loader has written over the very bytes
 * this wants to read. What is wanted is the moment after the block arrives and
 * before it runs. A block that decrypts itself says nothing at that moment,
 * which is why the machine is then let go and read again.
 */
async function bootBlocks(tape, boots, roms, seconds) {
  const { C64Machine } = await loadMachine();
  let last = null;
  for (const f of boots) {
    say(`\n${'─'.repeat(70)}\n${f.name.trim() || '(no name)'}  `
      + `$${hex(f.start)}-$${hex(f.end)}, ${f.size} bytes`);
    const m = new C64Machine();
    m.loadROMs(roms);
    for (let i = 0; i < 150; i++) m.runFrame();
    // The vectors as the machine boots, which is the only honest baseline: the
    // KERNAL moves some of them itself while it reads a tape and puts them back
    // afterwards, and a vector compared against its mid-load value reads as
    // moved when all it did was return to what it always was.
    const atBoot = new Map(Object.keys(VECTORS).map(a => [Number(a), word(m, Number(a))]));
    m.loadTap(tape.tap);
    m.seekTapeSeconds(f.startSeconds);
    m.setTapeKey('PLAY');
    // Knowing when the block has arrived is the whole difficulty. A mark left in
    // its range proves nothing: these blocks land in the tape buffer or the
    // screen, which the machine writes over for its own reasons. The KERNAL's
    // own account is not enough either, since its start and end pointers are
    // filled from the header when the file is FOUND, before a byte of it has
    // come. So the account, and then the tape stopping or the file taking the
    // machine, which is what a self-starting block does as it lands. An unnamed
    // LOAD also waits at FOUND for a key, so press one.
    const vectors = vectorsNow(m);
    type(m, 'LOAD\r');
    let ran = false, prods = 0, arrived = false;
    for (let s = 0; s < LOAD_LIMIT && !arrived; s++) {
      for (let k = 0; k < FRAMES_PER_SECOND; k++) m.runFrame();
      const accounted = m.mem.ram[STATUS] === 0
        && word(m, LOAD_END) - word(m, LOAD_START) === f.size;
      arrived = accounted
        && (!m.datasette.motorOn || tookOver(vectors, vectorsNow(m), f));
      if (m.datasette.motorOn) { ran = true; continue; }
      if (ran && prods < 4) { pressGo(m); prods++; }
    }
    if (!arrived) {
      say('\n  It did not load within the time allowed. Nothing to read.');
      continue;
    }
    say(`\n  as loaded, at $${hex(f.start)}:`);
    say(indent(disasm(seeing(m), f.start, DISASM_LINES)));
    watchIt(m, seconds, atBoot);
    last = m;
  }
  return last;
}

/**
 * Where the loader is, once it is running. Three questions, and between them
 * they found every reader read so far: which pages it executes from, which
 * interrupt vector it moved, and what it left in the CIA timer latches.
 */
function watchIt(m, seconds, atBoot) {
  const watch = Object.keys(VECTORS).map(Number);
  const pages = new Set();
  const limit = seconds * PAL_CPU_HZ;
  for (let c = 0; c < limit; c++) {
    step(m);
    if ((c % 1009) === 0) pages.add(m.cpu.pc & 0xFF00);
  }
  say(`\n  pages it executes from: `
    + `${[...pages].sort((a, b) => a - b).map(p => '$' + hex(p)).join(' ')}`);
  say(`  tape motor: ${m.datasette.motorOn ? 'still running' : 'stopped'}`
    + `, at pulse byte ${m.datasette.pos} of ${m.datasette.tapData.length}`);
  // What $01 says decides whether $E000 and up is the KERNAL or the loader's own.
  const port = m.mem.cpuPort & 0x07;
  say(`  $01 = $${(m.mem.cpuPort & 0xFF).toString(16).padStart(2, '0')}: `
    + `${(port & 2) ? 'KERNAL ROM in' : 'RAM under $E000'}, `
    + `${(port & 1) ? 'BASIC ROM in' : 'RAM under $A000'}`);
  const live = a => !UNDER_ROM.has(a) || !(m.mem.cpuPort & 0x02);
  say('');
  say(columns([['  VECTOR', 'AT', 'AT BOOT', 'NOW', ''],
    ...watch.map(a => [`  ${VECTORS[a]}`, `$${hex(a)}`, `$${hex(atBoot.get(a))}`,
      `$${hex(word(m, a))}`,
      !live(a) ? 'RAM the CPU is not using yet'
        : word(m, a) === atBoot.get(a) ? 'unchanged' : 'moved'])],
    ['l', 'r', 'r', 'r', 'l']).join('\n'));
  const moved = watch.filter(a => live(a) && word(m, a) !== atBoot.get(a));
  if (!moved.length) {
    say('\n  Nothing moved. Either it polls the tape rather than taking an interrupt,'
      + '\n  or it has not started yet: give it a longer --seconds.');
  }
  for (const a of moved) {
    say(`\n  its ${VECTORS[a]} vector now points at $${hex(word(m, a))}:`);
    say(indent(disasm(seeing(m), word(m, a), DISASM_LINES)));
  }
  threshold(m);
}

/**
 * The bit threshold, from what the loader did to a CIA timer. Every commercial
 * loader read here measures a pulse the same way: arm a timer, and at the next
 * tape edge ask how much of it is left. So the boundary is not a midpoint
 * between the two symbols but wherever that comparison falls, and it can be had
 * from the timer's latch and the constant it is compared against. Measured this
 * way: Novaload 500 cycles, US Gold / Datasoft 363, Gremlin Type 2 592.
 */
function threshold(m) {
  const latches = [[0xDC04, 'CIA1 timer A'], [0xDC06, 'CIA1 timer B'],
                   [0xDD04, 'CIA2 timer A'], [0xDD06, 'CIA2 timer B']];
  const rows = [];
  for (const [lo, name] of latches) {
    const v = m.mem.ram[lo] | (m.mem.ram[lo + 1] << 8);   // the shadow the loader wrote
    if (!v) continue;
    rows.push([`  ${name}`, `$${hex(v)}`, `${v}`,
      `a high byte of N leaves ${v} − N×256 cycles`]);
  }
  if (!rows.length) return;
  say('\n  Timer latches it left behind, which is how it measures a pulse:');
  say(columns([['  TIMER', 'LATCH', 'CYCLES', 'MEANING'], ...rows], ['l', 'r', 'r', 'l']).join('\n'));
  say('  Find the CMP against that timer\'s high byte in the code above: the'
    + ' boundary is\n  the latch less that constant times 256.');
}

// The per-cycle entry point is on the prototype, not the instance.
let stepper = null;
function step(m) {
  if (!stepper) stepper = Object.getPrototypeOf(m)._runMasterCycle;
  stepper.call(m);
}

// The same vectors `tookOver` judges by, in the order it expects them.
function vectorsNow(m) {
  const out = [];
  for (let a = 0x0300; a < 0x030C; a += 2) out.push(word(m, a));
  for (let a = 0x0314; a < 0x0334; a += 2) out.push(word(m, a));
  out.push(word(m, 0xFFFA), word(m, 0xFFFC), word(m, 0xFFFE));
  return out;
}

// Read the way the CPU would, banking and all. Straight off the RAM array a
// loader parked under the KERNAL reads as whatever was never written there, and
// an address that is still ROM disassembles as noise.
const seeing = (m) => (a) => m.mem.peek(a & 0xFFFF);
const hex = (v) => v.toString(16).toUpperCase().padStart(4, '0');
const word = (m, a) => m.mem.ram[a] | (m.mem.ram[a + 1] << 8);
const indent = (text) => text.split('\n').map(l => '    ' + l).join('\n');
