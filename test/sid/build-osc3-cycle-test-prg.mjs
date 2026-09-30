// Builds test/osc3-cycle-test.prg — a small 6502 program that visually
// demonstrates the cycle-exact $D41B shadow SID readback.
//
// What it does:
//   1. Sets voice 3 to NOISE with freq=$FFFF (LFSR shifts every ~256 cycles)
//      and gates on with sustain=15 (env ramps to peak).
//   2. Waits ~768 cycles for the envelope to climb past 0.
//   3. Reads $D41B 64 times in a tight loop (14 cycles per read) and
//      stores each byte into screen RAM at $0400.
//
// What you should see on screen (top-left 64 character cells):
//   - With shadow SID (cycle-exact): 3-4 distinct "blocks" of identical
//     characters separated by transitions. The 64 reads complete in
//     ~896 cycles ≈ 0.91 ms, during which the LFSR shifts 3-4 times.
//     Each shift changes the noise byte by ~1 bit, so consecutive
//     reads cluster.
//   - With the old behavior (~3 ms latency via worklet shared buffer):
//     all 64 reads return the same stale byte → 64 identical chars.
//
// Drag this .prg onto the emulator canvas, then watch the top of the screen.

import fs from 'node:fs';
import path from 'node:path';

const code = [
  // BASIC stub @ $0801 — "10 SYS 2061"
  0x0B, 0x08,                       // pointer to next BASIC line ($080B)
  0x0A, 0x00,                       // line number 10
  0x9E,                              // SYS token
  0x32, 0x30, 0x36, 0x31,           // "2061"
  0x00,                              // end of line
  0x00, 0x00,                        // end of program (null next-line pointer)

  // ── Machine code @ $080D ───────────────────────────────────────────
  // SEI — disable interrupts so the read loop is not preempted.
  0x78,

  // Set V3 freq high so LFSR shifts as often as possible.
  0xA9, 0xFF,                        // LDA #$FF
  0x8D, 0x0E, 0xD4,                 // STA $D40E   V3 freq lo
  0x8D, 0x0F, 0xD4,                 // STA $D40F   V3 freq hi

  // V3 envelope: attack=0 (fast ramp), sustain=15.
  0xA9, 0x00,                        // LDA #$00
  0x8D, 0x13, 0xD4,                 // STA $D413   V3 atk/dec
  0xA9, 0xF0,                        // LDA #$F0
  0x8D, 0x14, 0xD4,                 // STA $D414   V3 sus/rel

  // V3 ctrl = NOISE + GATE, then unmute.
  0xA9, 0x81,                        // LDA #$81
  0x8D, 0x12, 0xD4,                 // STA $D412   V3 ctrl (NOISE+GATE)
  0xA9, 0x0F,                        // LDA #$0F
  0x8D, 0x18, 0xD4,                 // STA $D418   vol=15

  // Wait ~768 cycles for the envelope to climb (attack=0 → ~9 cy per step).
  0xA2, 0x80,                        // LDX #$80
  0xCA,                              // DEX
  0xD0, 0xFD,                        // BNE -3   (loop X→0)

  // ── 64-read tight loop: store $D41B into $0400..$043F ─────────────
  // Inner loop body: DEX (2) + LDA $D41B (4) + STA $0400,X (5) + BNE (3)
  // = 14 cycles. 64 iterations ≈ 896 cycles ≈ 0.91 ms.
  0xA2, 0x40,                        // LDX #$40   (64)
  0xCA,                              // DEX
  0xAD, 0x1B, 0xD4,                 // LDA $D41B
  0x9D, 0x00, 0x04,                 // STA $0400,X
  0xD0, 0xF7,                        // BNE -9   (loop while X>0)

  // Halt — leave the result on screen.
  0x4C, 0x3A, 0x08,                 // JMP $083A  (loop on self)
];

const prg = new Uint8Array(2 + code.length);
prg[0] = 0x01;   // load address lo
prg[1] = 0x08;   // load address hi  ($0801)
for (let i = 0; i < code.length; i++) prg[2 + i] = code[i];

const outPath = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  'osc3-cycle-test.prg',
);
fs.writeFileSync(outPath, prg);
console.log(`wrote ${outPath}  (${prg.length} bytes total, ${code.length} after $0801 load)`);
console.log(`load and RUN in the emulator, then read the first 64 character cells (top row + start of second row).`);
