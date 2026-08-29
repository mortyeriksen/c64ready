// sprite-display-raster-wrap-spec-test.js
//
// Spec-derived test for sprite cycle-58 display logic across the
// raster 311→0 frame wrap. Does NOT load nine.prg or orbituntold.prg.
//
// Bauer §3.8.1 rules (verbatim, abbreviated for clarity):
//
//   Rule 4. "In the first phase of cycle 58, the MC of every sprite
//     is loaded from its corresponding MCBASE (MCBASE->MC) and the VIC
//     checks if the DMA for the sprite is turned on AND the Y
//     coordinate of the sprite matches the lower 8 bits of RASTER. If
//     this is the case, the display of the sprite is turned on.
//     Otherwise, if the DMA for the sprite is turned off, then its
//     display is also turned off."
//
//   Rule 7. "In the first phase of cycle 16, the VIC checks for each
//     sprite if its advance line flip-flop is set. If so, MCBASE is
//     loaded from its corresponding MC (MC->MCBASE), thus advancing
//     the sprite display to the next line. After that, the VIC checks
//     if MCBASE is equal to 63 and turns off the DMA of the sprite if
//     this is the case."
//
//   §3.8.1 closing paragraph: "Sprites can be 'reused' vertically: If
//     you change the Y coordinate of a sprite to a later raster line
//     during or after its display has completed, so that the
//     comparisons mentioned in rules 1 and 2 will match again, the
//     sprite is displayed again at that Y coordinate".
//
// Spec implications for the user's "garbage and flickering in top
// border" symptom:
//
//   S1. Rule 4 says display turns OFF only when DMA is off. There is
//       NO spec statement that display turns off when DMA is on but
//       the Y match fails. State preservation across no-Y-match cycles
//       is required.
//
//   S2. A sprite mid-display when raster wraps 311→0 must continue
//       displaying (rule 7's MC counter drives row, not Y). The DMA
//       and display state survive the frame boundary (vic2.js comment
//       at L1108-1114 calls this out explicitly).
//
//   S3. Sprite reuse via Y coordinate change: Y change during/after
//       display completion + Y match on a later raster → DMA restarts
//       at cycle 55/56, display starts at cycle 58 (rules 2 + 4).
//
//   S4. With Y near the frame boundary (Y=0..20 or Y=240..255), the
//       21-line display window naturally straddles the wrap. The
//       sprite's MC advances normally through the wrap.
//
// This test asserts S1..S4 with synthetic state — never loading a PRG.

import { VIC2, CYCLES_PER_LINE, LINES_PER_FRAME } from '../src/vic2.js';

let testNo = 0, failing = 0, currentFails = [];

function expect(cond, msg) { if (!cond) currentFails.push(msg); }
function ok(label) {
  testNo++;
  if (currentFails.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    failing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFails) console.log(`     - ${m}`);
    currentFails = [];
  }
}

function makeVic() {
  const v = new VIC2();
  v.ram = new Uint8Array(0x10000);
  v.colorRam = new Uint8Array(0x0400);
  v.charRom = new Uint8Array(0x1000);
  v.currentVicBank = 0;
  return v;
}

function driveToCycle(vic, targetRaster, targetCycle) {
  let safety = LINES_PER_FRAME * CYCLES_PER_LINE * 3;
  while (!(vic.raster === targetRaster && vic.cycleInLine === targetCycle)) {
    vic.clock(1);
    if (--safety <= 0) {
      throw new Error(`drive timeout: at r=${vic.raster} c=${vic.cycleInLine}, want r=${targetRaster} c=${targetCycle}`);
    }
  }
}

// ─── S1: rule 4 — display turns ON at cycle 58 phi1 (Bauer §3.8.1 r4) ────
//
// Spec rule 4 verbatim: "In the first phase of cycle 58, the MC of
// every sprite is loaded from its corresponding MCBASE (MCBASE->MC)
// and the VIC checks if the DMA for the sprite is turned on AND the Y
// coordinate of the sprite matches the lower 8 bits of RASTER. If
// this is the case, the display of the sprite is turned on."
//
// This test asserts spec EXACTLY. If our impl turns display on at any
// other cycle (e.g., the row-access cycle 59), the test FAILS — that
// is the signal we want.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x01;        // sp0 enabled
  vic.regs[0x01] = 51;          // Y=51
  vic.displayEnabled = true;

  // L51 c55: rule 2 fires → DMA on, MCBASE=0.
  driveToCycle(vic, 51, 55);
  expect(vic.spriteDmaOn[0] === 1, 'L51.c55: DMA on (rule 2)');
  expect(vic.spriteDisplayOn[0] === 0,
    'pre c58: display still OFF — rule 4 fires AT c58 phi1');

  // L51 c58: rule 4 phi1 — DMA on AND Y match → display ON.
  driveToCycle(vic, 51, 58);
  expect(vic.spriteDisplayOn[0] === 1,
    'S1: L51.c58 phi1 — Bauer rule 4 turns display ON exactly here');
  ok('S1: Bauer rule 4 — display turns ON at cycle 58 phi1 on Y-match line');

  // After display latched ON, must stay ON across no-Y-match lines for
  // the 21-line window (rule 4 has no "turn off on no-Y-match" clause).
  for (let r = 52; r <= 71; r++) {
    driveToCycle(vic, r, 58);
    expect(vic.spriteDmaOn[0] === 1,
      `L${r}.c58: DMA still on (MC=${vic.spriteMC[0]})`);
    expect(vic.spriteDisplayOn[0] === 1,
      `S1b: L${r}.c58 display preserved — rule 4 has no turn-off branch when DMA on`);
  }
  ok('S1b: display preserved across the 21-line span (no spec rule turns it off when DMA on)');
}

// ─── S2: sprite display continues across raster 311→0 wrap ───────────────
//
// Setup: sprite 0 with Y=300 (in $F8..$FF range — a value > 255
// can't be expressed; lower 8 bits 0x2C=44 means it'd Y-match at line
// 44). Use Y=255 instead — DMA starts at raster 255 (lower 8 bits 255).
// 21 lines later DMA stops naturally at raster 255+21=276. Choose a Y
// that puts the display end PAST the raster wrap: Y=300's lower 8 bits
// are 44 → DMA starts at raster 44 of NEXT frame (since raster 300 is
// >= 312? no, max is 311, and 311 & 0xFF = 0x37 = 55).
//
// Simpler: Y=240 (low 8 bits 240). DMA starts at L240 c55, display
// starts L241 c58, lasts 21 lines through L261. That's all within
// frame, no wrap. Use Y=255 (low 8 bits 255). DMA starts at L255 c55
// → display L256..276. No wrap either (276 < 311).
//
// To cross the wrap: Y must be set such that raster_lo (lower 8 bits)
// matches near end-of-frame. raster 290 has low 8 bits = 290-256 = 34.
// raster 295 → 39. raster 311 → 55. Set Y=55 → match at raster 311
// (since 311 & 0xFF == 55) AND at raster 55 (=55).
//
// At raster 311 c55 with Y=55 → DMA starts. Display starts L0 (next
// frame) c58. Lasts 21 lines through L20. The display straddles the
// 311→0 wrap.

{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 55;          // matches raster 55 AND raster 311 (low 8 bits 55)
  vic.displayEnabled = true;

  // Drive past raster 55 first (which would also match) — by the time
  // we reach L311, sp0 will have completed its first 21-line display.
  // To isolate the wrap-straddle path, we must avoid the L55 match.
  // Trick: enable sp0 only RIGHT BEFORE L311 c55.
  vic.regs[0x15] = 0x00;        // disable until L311 c50

  driveToCycle(vic, 311, 50);
  vic.regs[0x15] = 0x01;        // enable sp0 at L311 c50
  expect(vic.spriteDmaOn[0] === 0, 'pre-arm: sp0 DMA off (just enabled)');

  // Walk to L311 c55 — DMA-start check fires at c55 with Y=55,
  // raster=311 (lo 55 → match).
  driveToCycle(vic, 311, 55);
  expect(vic.spriteDmaOn[0] === 1,
    'L311.c55: rule 2 — DMA must turn ON (Y=55, raster lo 55)');

  // Drive across the wrap to L0 c58. Display turns ON at L0 c58
  // (rule 4). Since Y=55 != raster=0, the Y-match branch doesn't fire,
  // BUT spriteStartPending was set at L311's row-access cycle and rule 4
  // honors startPending too.
  driveToCycle(vic, 0, 58);
  expect(vic.spriteDmaOn[0] === 1, 'L0.c58 — DMA persists across raster wrap');
  expect(vic.spriteDisplayOn[0] === 1,
    'S2: L0.c58 — display turns ON at first cycle 58 after DMA-start');

  // Drive 5 more lines to ensure display continues — MC advances by 3
  // per line, so after 5 lines MC=15, well within the 0..62 valid range.
  driveToCycle(vic, 5, 58);
  expect(vic.spriteDisplayOn[0] === 1, 'L5.c58 — display continues 5 lines past wrap');
  expect(vic.spriteDmaOn[0] === 1, 'L5.c58 — DMA still on');
  ok('S2: sprite display continues correctly across raster 311→0 wrap');
}

// ─── S3: sprite Y reuse multiplexer ──────────────────────────────────────
//
// Spec: "if you change the Y coordinate of a sprite to a later raster
// line during or after its display has completed, so that the
// comparisons mentioned in rules 1 and 2 will match again, the sprite
// is displayed again at that Y coordinate".
//
// Setup: sp0 Y=60, runs L60..L80. After L80 (display complete), set
// Y=120, expect DMA-restart at L120 c55, display at L121.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 60;
  vic.displayEnabled = true;

  driveToCycle(vic, 60, 55);
  expect(vic.spriteDmaOn[0] === 1, 'L60.c55: first display, DMA on');

  // Run past display end (21 lines later DMA clears at cycle 16 of
  // L60+21=L81 once MCBASE reaches 63).
  driveToCycle(vic, 90, 1);
  expect(vic.spriteDmaOn[0] === 0,
    'L90: first display has completed, DMA off (MC reached 63)');

  // CPU rewrites Y to 120 — multiplexer reuse.
  vic.regs[0x01] = 120;

  // Drive to L120 c55 — DMA must restart per rules 1, 2.
  driveToCycle(vic, 120, 55);
  expect(vic.spriteDmaOn[0] === 1,
    'S3: L120.c55 — DMA must restart on Y match after Y rewrite (multiplexer reuse)');
  driveToCycle(vic, 121, 58);
  expect(vic.spriteDisplayOn[0] === 1,
    'S3: L121.c58 — display turns on at second-instance start');
  ok('S3: sprite Y reuse multiplexer — DMA restarts on Y match after first display ends');
}

// ─── S4: 21-line natural completion (MC=63 turns off DMA at cycle 16) ────
//
// Spec rule 7: at cycle 16, after MCBASE := MC, if MCBASE == 63 then
// DMA turns off. With non-Y-expanded sprite, MC advances 3 per line,
// reaching 63 after 21 lines. So a sprite at Y=51 displays L52..L72,
// DMA off at L72 c16 onwards.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 51;
  vic.regs[0x17] = 0x00;        // MxYE=0 → no Y expansion
  vic.displayEnabled = true;

  // First DMA-start at L51 c55 (Y match).
  driveToCycle(vic, 51, 55);
  expect(vic.spriteDmaOn[0] === 1, 'L51.c55: DMA on');

  // After 21 lines of display, at L72 c16 spec rule 7 turns off DMA.
  driveToCycle(vic, 72, 16);
  expect(vic.spriteDmaOn[0] === 0,
    'S4: L72.c16 — DMA must turn OFF when MCBASE reaches 63 (21-line completion)');

  // No Y match at any later raster (Y=51 fixed) → no DMA restart.
  driveToCycle(vic, 100, 55);
  expect(vic.spriteDmaOn[0] === 0,
    'S4: L100.c55 — no DMA restart without Y rewrite');
  ok('S4: rule 7 — 21-line MC=63 cycle-16 DMA shutoff (no Y expansion)');
}

// ─── Implementation-coverage gap probe: cycle-58 else→endDisplay ─────────
//
// Vic2.js:1669-1671 has `else { _endSpriteDisplayLine(s) }` that fires
// when (display=0 AND startPending=0). This branch fires when DMA is
// on but neither display nor startPending is set — which spec rule 4
// does NOT prescribe ending. Probe whether this branch can clobber
// in-flight shifter state for a sprite whose DMA continues.
//
// Construction: pin DMA on for sp0 with display=0 and startPending=0
// at L100 c57, then advance to c58. The `else` branch will fire and
// call _endSpriteDisplayLine which clears the shifter via
// _clearSpriteRowBytes. That's fine for THIS sprite (display=0 means
// it's not painting), but verifies the branch doesn't leak state.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  // Don't enable sp0 in $D015 — but force DMA on to model a "stuck"
  // state (this is what crunch produces in real demos).
  driveToCycle(vic, 100, 57);
  vic.spriteDmaOn[0] = 1;
  vic.spriteDisplayOn[0] = 0;
  vic.spriteStartPending[0] = 0;
  // Pre-load a non-zero shifter to detect if endDisplayLine clears it.
  vic.spriteShiftReg[0] = 0xABCDEF;
  vic.spriteRowByteMask[0] = 0x07;

  vic.clock(1);    // c58
  expect(vic.cycleInLine === 58, 'advanced to c58');
  // Spec rule 4 path: DMA on + display=0 + startPending=0. Spec doesn't
  // say "turn display off" here, but our impl falls into the `else`
  // branch and clears row bytes. Verify the implementation reliably
  // produces a deterministic state (shifter cleared, mask cleared).
  expect(vic.spriteShiftReg[0] === 0,
    'impl branch: cycle-58 else clears shifter when (display=0 AND startPending=0)');
  expect(vic.spriteRowByteMask[0] === 0,
    'impl branch: cycle-58 else clears row byte mask');
  expect(vic.spriteDmaOn[0] === 1,
    'impl branch: cycle-58 else does NOT clear DMA (DMA stays on)');
  ok('cycle-58 else branch — clears shifter but preserves DMA when display=0+startPending=0');
}

// ─── End-of-display + Y rewrite mid-line edge case ───────────────────────
//
// User's symptom mentions "garbage and flickering" with multiplexed
// sprites. A common multiplexer pattern: sprite finishes display at
// L72, CPU rewrites Y at L72 c20 to a value that matches L73. Spec
// rules 1 + 2 say DMA restarts at L73 c55. Verify display correctly
// re-starts at L74 c58.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 51;
  vic.displayEnabled = true;

  driveToCycle(vic, 72, 16);
  expect(vic.spriteDmaOn[0] === 0, 'L72.c16: first display ended');

  // Mid-line Y rewrite at L72 c20.
  driveToCycle(vic, 72, 20);
  vic.regs[0x01] = 73;          // match L73

  driveToCycle(vic, 73, 55);
  expect(vic.spriteDmaOn[0] === 1,
    'mid-line Y rewrite: DMA must restart at L73.c55 with new Y match');
  driveToCycle(vic, 74, 58);
  expect(vic.spriteDisplayOn[0] === 1,
    'mid-line Y rewrite: display ON at L74.c58 (start of second instance)');
  ok('mid-line Y rewrite mid-frame — multiplexer re-arm produces clean second display');
}

// ─── S5: multiple sprites simultaneously displaying across the wrap ──────
//
// All 8 sprites enabled with Y values that put their displays straddling
// the raster wrap. Verify each sprite independently sustains DMA + display
// across the boundary — no cross-sprite state leakage in the line-init
// reset logic (`_initRenderRasterLine` clears per-sprite arrays at line
// start).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0xFF;        // all 8 enabled
  // Y=55 lower 8 bits matches both raster 55 and raster 311. To make
  // displays straddle the 311→0 wrap, disable initially and arm only
  // before L311 c55. Sprites 0..7 all share Y=55 for simplicity.
  for (let s = 0; s < 8; s++) vic.regs[s * 2 + 1] = 55;
  vic.regs[0x15] = 0x00;        // armed off
  vic.displayEnabled = true;

  driveToCycle(vic, 311, 50);
  vic.regs[0x15] = 0xFF;        // all 8 armed at L311 c50

  // L311 c55: rule 2 fires → DMA on for all 8.
  driveToCycle(vic, 311, 55);
  for (let s = 0; s < 8; s++) {
    expect(vic.spriteDmaOn[s] === 1,
      `S5: L311.c55 sp${s} DMA must be ON (Y=55 matches raster lo 55)`);
  }

  // Drive across wrap to L0 c58 — display turns on for all.
  driveToCycle(vic, 0, 58);
  for (let s = 0; s < 8; s++) {
    expect(vic.spriteDmaOn[s] === 1, `S5: L0.c58 sp${s} DMA on across wrap`);
    expect(vic.spriteDisplayOn[s] === 1, `S5: L0.c58 sp${s} display on across wrap`);
  }

  // Drive 5 lines past wrap. All still displaying.
  driveToCycle(vic, 5, 58);
  for (let s = 0; s < 8; s++) {
    expect(vic.spriteDisplayOn[s] === 1,
      `S5: L5.c58 sp${s} display continuous (no cross-sprite state leak)`);
  }
  ok('S5: 8 sprites simultaneously straddling raster wrap — no cross-sprite leak');
}

// ─── S6: MxYE FF state across the raster wrap ────────────────────────────
//
// Bauer rule 3 (cycle 56 phi2): if MxYE=1 AND DMA on, advance-line FF
// is inverted. Rule 7 (cycle 16 phi1): if FF set, MCBASE := MC.
// With MxYE=1, FF alternates 0,1,0,1... per line. Verify FF state
// SURVIVES the raster 311→0 wrap and continues alternating on the
// other side. Setup: arm sp0 at L311 c50 (DMA starts at c55), display
// continues through L0, L1, ... — DMA is on across the wrap.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x00;        // armed off
  vic.regs[0x17] = 0x01;        // MxYE=1 for sp0
  vic.regs[0x01] = 55;          // Y=55 → matches lo bits of raster 311 AND 55
  vic.displayEnabled = true;

  driveToCycle(vic, 311, 50);
  vic.regs[0x15] = 0x01;        // arm right before c55

  driveToCycle(vic, 311, 55);
  expect(vic.spriteDmaOn[0] === 1, 'L311.c55: DMA on (Y=55 matches raster lo 55)');

  // After L311 c56 phi2: rule 3 inverts FF. FF was 1 (set at DMA-start
  // rule 2), now should be 0.
  driveToCycle(vic, 311, 60);   // post-c56 (rule 3 inverts FF)
  const ffAtL311End = vic.spriteYExpandFF[0];

  // Drive across the wrap to L0 c60.
  driveToCycle(vic, 0, 60);
  const ffAtL0End = vic.spriteYExpandFF[0];

  // L0 c56 phi2 inverts FF again (DMA still on). So FF at L0 end must
  // differ from FF at L311 end.
  expect(ffAtL0End !== ffAtL311End,
    `S6: FF alternates across wrap — L311 end=${ffAtL311End}, L0 end=${ffAtL0End}`);

  // L1 end: alternates back. Three samples → strict alternation pattern.
  driveToCycle(vic, 1, 60);
  const ffAtL1End = vic.spriteYExpandFF[0];
  expect(ffAtL1End === ffAtL311End,
    `S6: FF returns to L311-end state at L1 end (alternation, not random)`);
  ok('S6: MxYE advance-line FF alternates across raster 311→0 wrap (DMA continuous)');
}

// ─── S7: $D018 mid-line + sprite raster wrap ─────────────────────────────
//
// Bauer §3.7.2/§3.8.1: sprite p-accesses read from screen base[$3F8+s]
// where the screen base is selected by $D018[7:4]. A mid-frame $D018
// write between p-access cycles changes which pointer table subsequent
// sprites read from. Across the raster wrap, the live $D018 value at
// cycle 58 (sp0 p-access) of L0 should be respected, regardless of
// frame boundary.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0xFF;
  for (let s = 0; s < 8; s++) vic.regs[s * 2 + 1] = 55;
  vic.regs[0x15] = 0x00;
  vic.displayEnabled = true;

  // Bank 0 RAM zones outside the CHAR ROM shadow ($1000-$1FFF):
  //   - $D018=$14: screenBase=$0400 → pointer table at $07F8 (table A).
  //   - $D018=$84: screenBase=$2000 → pointer table at $23F8 (table B).
  // (Avoid $D018 values that put screenBase in $1000-$1FFF — CHAR ROM
  // shadow returns CHAR ROM bytes for VIC reads.)
  for (let s = 0; s < 8; s++) {
    vic.ram[0x07F8 + s] = 0xA0 + s;     // table A
    vic.ram[0x23F8 + s] = 0xB0 + s;     // table B
  }
  vic.regs[0x18] = 0x14;                 // screen base $0400

  driveToCycle(vic, 311, 50);
  vic.regs[0x15] = 0xFF;
  driveToCycle(vic, 311, 58);
  expect(vic.spritePointerValue[0] === 0xA0,
    `pre-wrap: sp0 ptr from table A = $A0, got $${vic.spritePointerValue[0].toString(16)}`);

  // Cross the wrap and rewrite $D018 BEFORE sp0 p-access at L0 c58.
  driveToCycle(vic, 0, 50);
  vic.regs[0x18] = 0x84;                 // screen base $2000 — table B

  driveToCycle(vic, 0, 58);
  expect(vic.spritePointerValue[0] === 0xB0,
    `S7: post-wrap sp0 ptr must reflect new $D018 = $B0, got $${vic.spritePointerValue[0].toString(16)}`);
  ok('S7: $D018 mid-line write across raster wrap redirects sprite p-access correctly');
}

// ─── S8: pinned crunch — DMA stays on across the frame boundary ──────────
//
// Real demos (Nine.prg) use the MxYE crunch (§3.14.7) to keep MCBASE
// from ever reaching 63, holding DMA on indefinitely. Spec-equivalent
// model: force `spriteDmaOn[s]=1` at every line; verify that no
// per-line / per-frame init code wipes it.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 51;
  vic.displayEnabled = true;
  driveToCycle(vic, 51, 55);
  expect(vic.spriteDmaOn[0] === 1, 'pre: DMA on');

  // For 5 frames, every cycle pin DMA on. Verify it stays on at the
  // raster-wrap boundary specifically.
  for (let frame = 0; frame < 3; frame++) {
    let safety = LINES_PER_FRAME * CYCLES_PER_LINE * 2;
    while (safety-- > 0) {
      vic.spriteDmaOn[0] = 1;    // pin
      vic.clock(1);
      // Specifically check at cycle 1 of raster 0 (just-wrapped).
      if (vic.raster === 0 && vic.cycleInLine === 1) break;
    }
    expect(vic.spriteDmaOn[0] === 1,
      `S8 frame ${frame}: DMA pinned must survive raster wrap`);
  }
  ok('S8: pinned DMA survives 3 successive frame wraps without being wiped');
}

// ─── S9: $D015 disable mid-display does NOT immediately stop DMA ─────────
//
// Bauer §3.8.1: the MxE bit (sprite enable) is checked at cycle 55/56
// for DMA-START only (rule 2). It is NOT checked for DMA-stop. Spec
// rule 7 says DMA stops only when MCBASE reaches 63. So clearing MxE
// mid-display must NOT halt the in-flight sprite — the current 21-line
// display continues.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 51;
  vic.displayEnabled = true;
  driveToCycle(vic, 55, 1);
  expect(vic.spriteDmaOn[0] === 1, 'pre: DMA on, mid-display');

  // Clear MxE mid-display.
  vic.regs[0x15] = 0x00;
  driveToCycle(vic, 60, 1);
  expect(vic.spriteDmaOn[0] === 1,
    'S9: mid-display MxE clear must NOT halt DMA — only MCBASE=63 stops');

  // After the natural 21-line completion, DMA stops.
  driveToCycle(vic, 72, 17);
  expect(vic.spriteDmaOn[0] === 0,
    'S9: natural completion (MC=63 at cycle 16) stops DMA even with MxE=0');

  // No restart on subsequent Y match (because MxE=0).
  driveToCycle(vic, 80, 1);
  vic.regs[0x01] = 80;          // Y match next frame
  driveToCycle(vic, 80, 55);
  expect(vic.spriteDmaOn[0] === 0,
    'S9: with MxE=0 at cycle 55, no DMA restart even on Y match');
  ok('S9: MxE clear mid-display preserves in-flight DMA, only MCBASE=63 stops it');
}

// ─── S10: cycle 58 dataRow update — DMA on, display ON, MC valid ─────────
//
// Bauer rule 4: at cycle 58 phi1, MC := MCBASE. Then if (DMA + display +
// row valid) → set dataRow; else if (startPending + DMA + row valid) →
// set dataRow; else → end display. Verify dataRow advances correctly
// per line during continuous display.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x00;        // no Y expand: row = MC/3
  vic.regs[0x01] = 51;
  vic.displayEnabled = true;
  // Sample dataRow at cycle 58 of each display line.
  const observed = [];
  driveToCycle(vic, 51, 58);     // first line — display starts here
  for (let r = 51; r <= 71; r++) {
    driveToCycle(vic, r, 58);
    observed.push({ raster: r, dataRow: vic.spriteLineDataRow[0], mc: vic.spriteMC[0] });
  }
  // Rule: dataRow advances by 1 each line (3 s-accesses → MC += 3 →
  // _spriteDisplayRowFromMc(MC) increments by 1). Spec sequence: row 0
  // at first display line, row 1 at second, ..., row 20 at 21st line.
  // Our impl turns on display at the row-access cycle (sp0 c59), but
  // dataRow at cycle 58 reflects the row about to be displayed.
  for (let i = 0; i < observed.length; i++) {
    const expected = i;          // row i at line 51+i
    expect(observed[i].dataRow === expected,
      `S10: line ${observed[i].raster} dataRow want ${expected} got ${observed[i].dataRow} (MC=${observed[i].mc})`);
  }
  ok('S10: cycle-58 dataRow advances 0..20 across the 21-line display window');
}

console.log(`\n${testNo} sprite display raster-wrap spec tests; ${failing} fail`);
if (failing) process.exit(1);
