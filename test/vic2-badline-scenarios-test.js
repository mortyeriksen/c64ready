// Bad-line scenario tests — focused on the cases nine.prg actually exercises:
//   1. Two consecutive bad-line raster lines (start of a character row).
//   2. DEN cleared mid-frame (the display-disable / border-open trick the
//      demo uses to render sprites only).
//   3. Bad-line BA stacked with sprite BA (the case that originally
//      surfaced the 2026-04-30 sprite-BA-lead-in bug).
//   4. The cycle 54 → 55 transition where lineMatrixFetchCol resets to -1.
//
// Each scenario walks BA / AEC cycle-by-cycle and asserts against the
// Bauer §3.5 / §3.6 reference table.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

// Run `n` master cycles of VIC and snapshot BA/AEC after each one.
function tickAndSample(vic, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    vic.clock(1);
    out.push({
      raster: vic.raster,
      cycle: vic.cycleInLine,
      baLow: !!vic.baLow,
      aecLow: !!vic.aecLow,
    });
  }
  return out;
}

function expect(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

function countStalls(samples, raster) {
  let ba = 0, aec = 0;
  for (const s of samples) {
    if (s.raster !== raster) continue;
    if (s.baLow) ba++;
    if (s.aecLow) aec++;
  }
  return { ba, aec };
}

// ── Scenario 1: two consecutive bad-line rasters ──────────────────────────
// YSCROLL=3 → bad line whenever (raster & 7) === 3 inside 0x30..0xF7.
// Lines 51, 59, 67, ... are bad. Two consecutive bad-lines aren't possible
// with a single YSCROLL value, but a character-row first-line + a sprite-DMA
// row are both BA-active. Test: line 51 (bad-line), then line 52 (NOT bad)
// to make sure BA returns high cleanly between them.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B; // DEN=1, RSEL=1, YSCROLL=3
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x00;
  vic.displayEnabled = true;

  // Skip to start of line 51.
  for (let i = 0; i < CYCLES_PER_LINE * 51; i++) vic.clock(1);

  const line51 = tickAndSample(vic, CYCLES_PER_LINE); // line 51
  const line52 = tickAndSample(vic, CYCLES_PER_LINE); // line 52

  const s51 = countStalls(line51, 51);
  const s52 = countStalls(line52, 52);
  expect(s51.ba === 43, `line 51 (bad): expected 43 BA-low cyc, got ${s51.ba}`);
  expect(s51.aec === 40, `line 51 (bad): expected 40 AEC-low cyc, got ${s51.aec}`);
  expect(s52.ba === 0, `line 52 (NOT bad, no sprites): expected 0 BA-low cyc, got ${s52.ba}`);
  expect(s52.aec === 0, `line 52 (NOT bad, no sprites): expected 0 AEC-low cyc, got ${s52.aec}`);
  console.log('ok  - bad-line raster (51) is followed cleanly by non-bad-line (52)');
}

// ── Scenario 2: DEN cleared mid-frame (open-border trick) ────────────────
// Once DEN goes 0 at cycle <58 of any line, that line's bad-line condition
// at cycle 58 evaluates DEN=0 → not a bad line. Subsequent bad-line rasters
// still get the YSCROLL match but the DEN check fails → no bad line fires
// and no bad-line BA stalls.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B; // start with DEN=1
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x00;
  vic.displayEnabled = true;

  // Skip to start of line 24 (where nine.prg writes $D011=$4B = DEN clear).
  for (let i = 0; i < CYCLES_PER_LINE * 24; i++) vic.clock(1);

  // Tick into line 24 cycle 53 (where the demo writes $D011 in the trace).
  for (let i = 0; i < 53; i++) vic.clock(1);
  expect(vic.raster === 24 && vic.cycleInLine === 53, `pre: should be at L24.c53`);

  // Clear DEN. Real demo writes $D011 = $4B (DEN=0, RSEL=1, ECM=1, YSCROLL=3).
  vic.write(0x11, 0x4B);

  // Run through the rest of line 24 plus the next several rasters covering
  // lines 51, 59 — both YSCROLL-3 bad-line candidates that should NOT fire.
  const samples = tickAndSample(vic, CYCLES_PER_LINE * 40);
  const s51 = countStalls(samples, 51);
  const s59 = countStalls(samples, 59);
  expect(s51.ba === 0, `DEN=0 trick: line 51 should NOT bad-line (BA stays 0), got ${s51.ba}`);
  expect(s59.ba === 0, `DEN=0 trick: line 59 should NOT bad-line, got ${s59.ba}`);
  console.log('ok  - DEN cleared at L24.c53 prevents bad-lines at 51, 59 (open-border trick)');
}

// ── Scenario 3: bad-line + sprite BA stacking ────────────────────────────
// 7 sprites enabled (the nine.prg wizard region). Bad-line BA and sprite BA
// overlap — neither should over-count the other. AEC = BA(c) && BA(c-3).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0xFE; // sprites 1..7 enabled
  vic.displayEnabled = true;
  // Set Y so each sprite naturally starts DMA at L40 (Y match) and is still
  // alive at L51 (40+21=61). Rule 2 sets FF=1 at DMA start; rule 1 keeps it
  // there with MxYE=0; MCBASE advances 3/line so it's at 33 by L51 — well
  // under 63, so DMA is still on.
  for (let s = 1; s < 8; s++) vic.regs[s * 2 + 1] = 40;

  for (let i = 0; i < CYCLES_PER_LINE * 51; i++) vic.clock(1);
  const line51 = tickAndSample(vic, CYCLES_PER_LINE);
  const s = countStalls(line51, 51);

  // Bad-line BA: cycles 12..54 = 43 cycles.
  // Sprite BA (sp1..sp7): each sprite has p-access at cycles 60+2s (sp1=62,
  // sp2=0(wrap),sp3=2,...). The BA-low window for each sprite is 3 cycles
  // before p-access through 1 cycle after s-access: 5 cycles per sprite.
  // Spans wrap around line boundaries; some overlap with bad-line BA.
  // Rather than compute the exact union here, we just assert:
  //   - BA-low count > bad-line-only (43) (sprites add stalls)
  //   - AEC-low count > bad-line-only (40) (sprite AEC stacks too)
  //   - Both ≤ 63 (max one full line)
  expect(s.ba > 43, `bad+sprite: BA stalls (${s.ba}) should exceed bad-only (43)`);
  expect(s.ba <= 63, `bad+sprite: BA stalls (${s.ba}) cannot exceed 63 (full line)`);
  expect(s.aec > 40, `bad+sprite: AEC stalls (${s.aec}) should exceed bad-only (40)`);
  expect(s.aec <= 63, `bad+sprite: AEC stalls (${s.aec}) cannot exceed 63`);
  console.log(`ok  - bad-line + 7 sprites stacks: BA=${s.ba} AEC=${s.aec} (both > bad-only baseline)`);
}

// ── Scenario 4: cycle 54 → 55 transition ─────────────────────────────────
// At cycle 54 the last c-access fetches col 39, then lineMatrixFetchCol
// resets to -1 inside _runTextPhase2Access. baLow at cycle 54 is sampled
// at the START of the cycle (before the reset), so it should be 1. At
// cycle 55 it must be 0 (no bad-line BA, no sprite BA). Catches off-by-one
// at the matrix-fetch boundary.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x00;
  vic.displayEnabled = true;
  for (let i = 0; i < CYCLES_PER_LINE * 51; i++) vic.clock(1);
  const line51 = tickAndSample(vic, CYCLES_PER_LINE);
  const c54 = line51.find(s => s.cycle === 54);
  const c55 = line51.find(s => s.cycle === 55);
  expect(c54 && c54.baLow === true, `cycle 54: BA must be low (last c-access)`);
  expect(c54 && c54.aecLow === true, `cycle 54: AEC must be low`);
  expect(c55 && c55.baLow === false, `cycle 55: BA must release (first cycle CPU resumes)`);
  expect(c55 && c55.aecLow === false, `cycle 55: AEC must release`);
  console.log('ok  - cycle 54→55 transition: BA/AEC release correctly after last c-access');
}

// ── Scenario 5: DEN re-enable LATE in same frame stays "off" ─────────────
// Bauer §3.5: the displayEnabled latch is set/cleared at raster $30 (line
// 48). The demo's L24 DEN-clear ensures displayEnabled is false at L48
// → no bad-lines fire for the rest of the frame, even if DEN is restored
// at L267. The L267 write only re-arms the latch for the NEXT frame's L48.
// nine.prg relies on this: the entire frame after L24 has zero bad-lines,
// keeping the CPU's stable-raster cycle budget predictable.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x5B; // DEN=1 at frame start
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x00;

  // Skip to L24 and clear DEN (mimic the demo).
  for (let i = 0; i < CYCLES_PER_LINE * 24; i++) vic.clock(1);
  vic.write(0x11, 0x4B); // DEN=0

  // Run past L48 (the latch line) to L267 and re-enable DEN.
  for (let i = 0; i < CYCLES_PER_LINE * (267 - 24); i++) vic.clock(1);
  vic.write(0x11, 0x5B);

  // Run to L275 (next YSCROLL-3 candidate) and verify NO bad-line fires.
  const samples = tickAndSample(vic, CYCLES_PER_LINE * 12);
  const s275 = countStalls(samples, 275);
  expect(s275.ba === 0, `DEN re-enabled at L267 should NOT re-arm bad-lines this frame, got BA=${s275.ba}`);
  expect(s275.aec === 0, `L275 in same frame: AEC must stay 0, got ${s275.aec}`);

  // Run forward into the NEXT frame: L48 of next frame latches DEN=1 →
  // bad-lines should resume at L51 of next frame.
  const nextFrame = tickAndSample(vic, CYCLES_PER_LINE * 312);
  // Find any raster in 51..58 with BA-low cycles (i.e., bad-line fires).
  const r51 = countStalls(nextFrame, 51);
  expect(r51.ba === 43, `next frame L51 should bad-line normally, got BA=${r51.ba}`);
  console.log('ok  - DEN re-enable late in frame stays "off" until next frame\'s L48 latch');
}

console.log('\nall bad-line scenarios pass');
