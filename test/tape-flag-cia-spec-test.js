// The tape's read pin, all the way to the CPU: TAP pulse → FLAG → CIA1 ICR bit 4
// → what a polling loop sees, and when /IRQ follows.
//
// The KERNAL loads from tape on an interrupt, but nearly every turbo loader does
// the opposite: SEI, then poll $DC0D bit 4 in a tight loop and time the gap
// between edges. That path is what this file pins, because it is the one the
// tapes in this project actually use, and because it is a cycle-ordering
// question rather than a datasette question:
//
//   a master cycle runs CIA → CPU → datasette (src/machine.js)
//
// so an edge produced this cycle cannot be seen by a $DC0D read in the same
// cycle — the read has already happened — and must be visible to the next one.
// The datasette's own spec test drives flagCallback directly and never involves
// a CIA; this one runs the real chain.
import { C64Machine } from '../src/machine.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) { console.log(`ok  - test ${testNo}: ${label}`); return; }
  testsFailing++;
  console.log(`FAIL test ${testNo}: ${label}`);
  for (const m of currentFailures) console.log(`     - ${m}`);
  currentFailures = [];
}

const ICR = 0x0D;
const FLAG_BIT = 0x10;

/** A v1 tape: each entry is either a byte (×8 cycles) or an exact cycle count. */
function makeTap(pulses) {
  const body = [];
  for (const p of pulses) {
    if (typeof p === 'number') { body.push(p); continue; }
    body.push(0, p.cycles & 0xFF, (p.cycles >> 8) & 0xFF, (p.cycles >> 16) & 0xFF);
  }
  const tap = new Uint8Array(20 + body.length);
  for (let i = 0; i < 12; i++) tap[i] = 'C64-TAPE-RAW'.charCodeAt(i);
  tap[12] = 1;
  tap[16] = body.length & 0xFF;
  tap[17] = (body.length >> 8) & 0xFF;
  tap.set(body, 20);
  return tap;
}

/**
 * A machine with a tape playing and the motor on, parked on a NOP carpet with
 * I/O in. Everything the CPU sees of the tape arrives through CIA1.
 */
function makeMachine(pulses) {
  const m = new C64Machine();
  m.reset();
  m.mem.ram.fill(0xEA);
  m.mem.write(0x0001, 0x35);                          // RAM + I/O, no ROMs
  m.mem.ram[0xFFFE] = 0x00; m.mem.ram[0xFFFF] = 0x90; // IRQ vector → $9000
  m.loadTap(makeTap(pulses));
  m.setTapeKey('PLAY');
  m.datasette.setMotor(true);
  // Past the 300 ms the capstan takes to settle, so pulse 0 arrives clean.
  const settle = m.datasette._motorStartupRemaining + 8;
  for (let i = 0; i < settle; i++) C64Machine.prototype._runMasterCycle.call(m);
  m.cpu.pc = 0x1000;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
  return m;
}

// The loop every turbo loader runs, at $1000: LDA $DC0D / AND #$10, then round
// again — nine cycles, so no pulse goes unseen. It has to be the CPU doing the
// reading: a read from the test harness happens between master cycles, which is
// the one position no real read occupies.
const POLL_LOOP = [0xAD, 0x0D, 0xDC, 0x29, 0x10, 0x4C, 0x00, 0x10];
const POLL_CYCLES = 9;

/**
 * Run the machine with that loop under the CPU, recording tape edges and the
 * CPU's own $DC0D reads in the order they happen *within* each cycle — which is
 * the whole point: the ordering is invisible from outside a master cycle.
 */
function trace(m, cycles) {
  for (let i = 0; i < POLL_LOOP.length; i++) m.mem.ram[0x1000 + i] = POLL_LOOP[i];
  m.cpu.pc = 0x1000;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;

  const events = [];
  const flag = m.datasette.flagCallback;
  m.datasette.flagCallback = (level) => {
    if (level === 0) events.push({ kind: 'edge', cycle: at });
    flag?.(level);
  };
  const read = m.cia1.read.bind(m.cia1);
  m.cia1.read = (reg) => {
    const value = read(reg);
    if (reg === ICR) events.push({ kind: 'read', cycle: at, flag: (value & FLAG_BIT) !== 0 });
    return value;
  };
  let at = 0;
  for (; at < cycles; at++) C64Machine.prototype._runMasterCycle.call(m);
  m.cia1.read = read;
  m.datasette.flagCallback = flag;
  return events;
}

// ── 1: a tape edge sets CIA1's FLAG bit ──────────────────────────────────────
{
  const m = makeMachine([0x30, 0x30, 0x30]);          // 384-cycle pulses
  let seen = false;
  for (let i = 0; i < 500 && !seen; i++) {
    C64Machine.prototype._runMasterCycle.call(m);
    seen = (m.cia1.icrStatus & FLAG_BIT) !== 0;
  }
  expect(seen, 'no FLAG in ICR after a tape pulse');
  ok('Tape: a pulse from the tape raises CIA1 ICR bit 4');
}

// ── 2: not to a read in the same cycle, but to the next one ──────────────────
{
  const m = makeMachine([0x30, 0x30, 0x30, 0x30]);
  const events = trace(m, 900);
  const edge = events.find(e => e.kind === 'edge');
  expect(edge, 'the tape produced no edge at all');
  if (edge) {
    // A read in the edge's own cycle happened before the datasette ran: the CPU
    // cannot know about a pulse the tape has not produced yet.
    const sameCycle = events.filter(e => e.kind === 'read' && e.cycle === edge.cycle && e.flag);
    expect(sameCycle.length === 0,
      `a $DC0D read in the edge's own cycle saw FLAG (${sameCycle.length} reads)`);
    const after = events.find(e => e.kind === 'read' && e.cycle > edge.cycle);
    expect(after && after.flag,
      `the first read after the edge (cycle ${after?.cycle}, edge ${edge.cycle}) did not see FLAG`);
  }
  ok('Tape: a polled $DC0D sees the edge from the next cycle on, never its own');
}

// ── 3: reading $DC0D clears it, so a poll sees one hit per pulse ─────────────
{
  const m = makeMachine([0x30, 0x30, 0x30, 0x30, 0x30]);
  const events = trace(m, 384 * 4 + 100);
  const edges = events.filter(e => e.kind === 'edge').length;
  const hits = events.filter(e => e.kind === 'read' && e.flag).length;
  expect(edges >= 3, `expected several pulses, got ${edges}`);
  expect(hits === edges, `a polling loop saw ${hits} hits for ${edges} pulses`);
  ok('Tape: each pulse is seen once — the ICR read clears the latch');
}

// ── 4: the gap between hits is the pulse width the tape holds ────────────────
{
  const m = makeMachine([0x30, 0x30, 0x30, 0x30]);    // 0x30 × 8 = 384 cycles
  const events = trace(m, 384 * 4 + 100);
  const edges = events.filter(e => e.kind === 'edge').map(e => e.cycle);
  const hits = events.filter(e => e.kind === 'read' && e.flag).map(e => e.cycle);
  expect(edges.length >= 3, `expected at least three pulses, got ${edges.length}`);
  for (let i = 1; i < edges.length; i++) {
    expect(edges[i] - edges[i - 1] === 384, `pulse ${i} lasted ${edges[i] - edges[i - 1]} cycles, not 384`);
  }
  // What the loader itself measures: the same widths, to within how often it
  // gets to look. A real one is in the same position.
  expect(hits.length >= 3, `expected at least three hits, got ${hits.length}`);
  for (let i = 1; i < hits.length; i++) {
    const gap = hits[i] - hits[i - 1];
    expect(Math.abs(gap - 384) <= POLL_CYCLES, `poll ${i} measured ${gap} cycles, not 384 ± ${POLL_CYCLES}`);
  }
  ok('Tape: a polled loader measures the pulse widths the .tap holds');
}

// ── 5: a v1 long-form pulse carries all 24 bits of its count ─────────────────
{
  const CYCLES = 0x0123AB;                            // 74,667 — no byte holds it
  const m = makeMachine([0x30, { cycles: CYCLES }, 0x30]);
  const events = trace(m, CYCLES + 2000);
  const hits = events.filter(e => e.kind === 'read' && e.flag).map(e => e.cycle);
  expect(hits.length >= 3, `expected three edges, got ${hits.length}`);
  if (hits.length >= 3) {
    const gap = hits[1] - hits[0];          // the long one sits between these two
    expect(Math.abs(gap - CYCLES) <= POLL_CYCLES, `the long pulse measured ${gap}, not ${CYCLES}`);
  }
  ok('Tape: a v1 long-form pulse is honoured to all 24 bits');
}

// ── 6: with FLAG enabled in the ICR mask, /IRQ follows the edge ──────────────
{
  const m = makeMachine([0x30, 0x30, 0x30]);
  m.cpu.I = 0;
  m.cia1.write(ICR, 0x80 | FLAG_BIT);                 // enable the FLAG interrupt
  let edgeAt = -1, acceptedAt = -1, at = 0;
  const flag = m.datasette.flagCallback;
  m.datasette.flagCallback = (level) => { if (level === 0 && edgeAt < 0) edgeAt = at; flag?.(level); };
  m.cpu.onInterruptAccept = (kind) => { if (kind === 'irq' && acceptedAt < 0) acceptedAt = at; };
  for (; at < 1200 && acceptedAt < 0; at++) C64Machine.prototype._runMasterCycle.call(m);
  expect(edgeAt >= 0, 'the tape produced no edge');
  expect(acceptedAt > edgeAt, `IRQ was accepted at ${acceptedAt}, edge at ${edgeAt}`);
  // Measured: five cycles. The CIA presents its interrupt one clock after the
  // latch, the CPU samples the line a cycle later, and it can only act at an
  // instruction boundary — which a two-cycle NOP carpet quantises. The range,
  // not the exact number, is the spec: anything outside it means the chain is
  // broken rather than merely re-phased.
  const took = acceptedAt - edgeAt;
  expect(took >= 3 && took <= 6, `IRQ took ${took} cycles to be accepted, expected 3-6`);
  ok('Tape: a FLAG interrupt reaches the CPU on the boundary after the edge');
}

if (testsFailing) {
  console.error(`\n${testsFailing} tape FLAG test(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${testNo} tape FLAG tests passed`);
