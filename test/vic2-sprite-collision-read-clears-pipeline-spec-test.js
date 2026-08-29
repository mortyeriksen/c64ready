// Sprite-collision register read clears the in-flight collision, phi-resolved.
//
// Spec source: VICII/spritevssprite (real-6569 reference table). It reads
// $D01E twice back to back per line while sweeping two fully-overlapping
// sprites 1px/frame; the second read's value forms a diagonal collision band.
// Matching that band byte-for-byte pins two facts:
//
//   1. Reading the register clears the collision flip-flops outright — a
//      collision still propagating through the ~2-cycle CPU-visibility
//      pipeline (sibling spec: visible at floor(canvasX/8)+14) does not
//      survive to a second read a few cycles later.
//   2. The clear is resolved to the half-cycle. A read at phi2 of its cycle
//      clears the phi1-half (first 4px, canvas X & 4 == 0) of the in-flight
//      detection but LEAVES the phi2-half (last 4px, canvas X & 4 != 0).
//      Clearing the whole pipeline leaves the catch window 4px too narrow;
//      not clearing it leaves it a cycle too wide.
//
// This test asserts the observable consequence of (2): two colliding pixels
// in the SAME cycle but opposite halves (canvas 104 = phi1, canvas 108 =
// phi2) — read while the collision is in flight — produce opposite outcomes
// on a second read. Everything here is read off $D01E; no internal pipeline
// state is inspected.

import { VIC2 } from '../src/vic2.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { testsFailing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

function makeVic() {
  const vic = new VIC2();
  // This test asserts MID-LINE render internals (per-cycle fb32/pipe/reg
  // state), which only the live incremental path exhibits — under the
  // Tier-3 line-batch mode pixels/commits land at line end or on a CPU
  // observer event, both byte-identical at every CPU-observable point.
  // Pin the live path so a LINE_BATCH=1 suite run still tests this contract.
  vic.lineBatchRender = false;
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

// Two fully-overlapping single-pixel sprites (sp0+sp1) at sprite-X regX, Y=50.
// The colliding pixel lands at canvas column regX+8 (see visibility spec).
function setupCollidingSprites(vic, regX) {
  vic.regs[0x11] = 0x1B;             // text mode, DEN=1
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x03;             // enable sp0 + sp1
  vic.regs[0x00] = regX & 0xFF; vic.regs[0x01] = 50;
  vic.regs[0x02] = regX & 0xFF; vic.regs[0x03] = 50;
  vic.regs[0x27] = 0x01; vic.regs[0x28] = 0x03;
  vic.ram[0x07F8] = 0x3F; vic.ram[0x07F9] = 0x3F;
  for (let i = 0; i < 64; i++) vic.ram[0x0FC0 + i] = 0;
  vic.ram[0x0FC0] = 0x80;            // one pixel, top-left
}

// Machine cycle (clock count from reset) at which $D01E first reads non-zero
// — the observable CPU-visibility point of the collision.
function commitClock(regX) {
  const vic = makeVic();
  setupCollidingSprites(vic, regX);
  for (let n = 0; n < 80 * 63; n++) { vic.clock(1); if (vic.regs[0x1E] !== 0) return n; }
  return -1;
}

// Read $D01E while the collision is in flight (in the cycle it is detected,
// 2 cycles before CPU-visibility), then report whether it later resurfaces on
// the register — i.e. whether a second back-to-back read would catch it.
function inFlightReadResurfaces(regX) {
  const commit = commitClock(regX);
  const readAt = commit - 2;          // detection cycle (pipeline entry)
  const vic = makeVic();
  setupCollidingSprites(vic, regX);
  let earlyVal = -1, resurfaced = false;
  for (let i = 0; i < 80 * 63; i++) {
    vic.clock(1);
    if (i === readAt) earlyVal = vic.read(0x1E);
    else if (i > readAt && i <= commit + 4 && vic.regs[0x1E] !== 0) resurfaced = true;
  }
  return { commit, earlyVal, resurfaced };
}

// ── Control: the setup really does collide (register reaches $03) ──────
{
  const vic = makeVic();
  setupCollidingSprites(vic, 100);
  let committed = 0;
  for (let i = 0; i < 80 * 63; i++) { vic.clock(1); if (vic.regs[0x1E] !== 0) { committed = vic.regs[0x1E]; break; } }
  expect(committed === 0x03, `control: sp0+sp1 must collide and latch $03, got $${committed.toString(16)}`);
  ok('control — overlapping sprites latch $D01E = $03');
}

// ── Same commit cycle, opposite phi-halves ⇒ opposite second-read fate ──
const C1 = commitClock(96), C2 = commitClock(100);
{
  expect(((96 + 8) & 4) === 0, 'setup: canvas 104 must be the phi1-half (X & 4 == 0)');
  expect(((100 + 8) & 4) !== 0, 'setup: canvas 108 must be the phi2-half (X & 4 != 0)');
  expect(C1 === C2 && C1 > 0,
    `setup: canvas 104 and 108 share one cycle ⇒ same commit cycle (got ${C1} vs ${C2})`);
  ok('setup — canvas 104 (phi1) and 108 (phi2) collide in the same cycle');
}

// phi1: the in-flight read clears it; a second read sees nothing.
{
  const r = inFlightReadResurfaces(96);
  expect(r.earlyVal === 0, `in-flight read returns 0 (not yet visible), got $${r.earlyVal.toString(16)}`);
  expect(!r.resurfaced, 'phi1-half collision cleared by the read must NOT resurface on $D01E');
  ok('reading $D01E clears an in-flight phi1-half collision (no second-read catch)');
}

// phi2: the in-flight read leaves it; a second read still catches it.
{
  const r = inFlightReadResurfaces(100);
  expect(r.earlyVal === 0, `in-flight read returns 0 (not yet visible), got $${r.earlyVal.toString(16)}`);
  expect(r.resurfaced, 'phi2-half collision must be RETAINED and caught by a second $D01E read');
  ok('reading $D01E retains an in-flight phi2-half collision (second-read catch)');
}

// ── A read AFTER commit clears normally (guards against over-clearing) ──
{
  const vic = makeVic();
  setupCollidingSprites(vic, 100);
  let firstRead = -1, secondRead = -1;
  for (let i = 0; i < 80 * 63; i++) {
    vic.clock(1);
    if (vic.regs[0x1E] !== 0) {
      firstRead = vic.read(0x1E);
      vic.clock(1);
      secondRead = vic.read(0x1E);
      break;
    }
  }
  expect(firstRead === 0x03, `read of a committed collision returns $03, got $${firstRead.toString(16)}`);
  expect(secondRead === 0x00, `read after clearing returns $00, got $${secondRead.toString(16)}`);
  ok('reading a committed $D01E returns $03 then clears to $00');
}

console.log(`\n${testNo} sprite-collision read-clears-pipeline spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
