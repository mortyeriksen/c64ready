// csel-veto-sprite-rollback-spec-test.js
//
// Spec-derived test for the §3.14.1 cycle-56 hyperscreen veto path —
// specifically that when the right-SET pulse is vetoed (CSEL=1→0 at
// cycle 56 phi2), the sprite render state is correctly rolled back
// and cycles 55..57 re-render with the now-open border.
//
// Does NOT load nine.prg or orbituntold.prg.
//
// Bauer §3.14.1 (the relevant quote):
//   "the change from CSEL=1 to CSEL=0 has to be exactly in cycle 56."
//
// Bauer §3.9 (rules summary):
//   Rule 1: when X reaches the right comparison value, main border FF
//           is SET.
//   Rule 6: when X reaches the left comparison value AND vertical FF
//           is NOT set, main border FF is RESET.
//
// Spec model implemented as the deferred-latch architecture (vic2.js
// L1817-1962):
//   - Cycle 55 phi1: right comparator fires (CSEL=1, right=344 ∈
//     cycle-55 segment). hBorderActive ← true. Pending entry:
//     {kind:'hRightSet', detectCycle:55, latch=detect+2=cycle 57,
//      cselAtFire:1, spriteSnapshot:<snapshot>}.
//   - Cycle 56 phi2: CPU writes $D016=$00 (CSEL=1→0). regs[0x16]
//     reflects the new CSEL by cycle 57 phi1.
//   - Cycle 57 phi1: latch eval. cselAtFire=1, curCsel=0 →
//     §3.14.1 trick fires. Probe segment = cycle 56 (X 352..360).
//     newRight=335 (CSEL=0) NOT in [352,360) → veto fires.
//   - Veto: hBorderActive ← false. lineCycleHBorder[55,56] ← 0.
//     Sprite snapshot restored. Cycles 55..56 re-rendered:
//     graphics with hBorder=0 (border buffer cleared) and sprites
//     re-rendered with the rolled-back state.
//
// User-visible relevance: with sprites at the right edge of the
// display, the trick must reveal them in the open border. Without
// rollback, sprite rendering at cycles 55..57 was gated by the
// closed border (borderBuffer=1), so even after rollback the sprite
// pixels are missing.
//
// Test strategy: drive a synthetic line to cycle 55, fire the right-SET,
// step to cycle 57 with the trick (write $D016=0 between cycles), then
// assert:
//   T1. Pending hRightSet was queued at c55.
//   T2. After veto eval, pending list is drained (no leftover entries).
//   T3. lineCycleHBorder[55..56] is rewritten to 0 (rolled back).
//   T4. hBorderActive is false at cycle 58.
//   T5. With a sprite positioned at canvas X around cycle 55-57, after
//       veto the sprite pixels are visible (borderBuffer=0 in that
//       range, sprite-owner claimed).

import { VIC2, CYCLES_PER_LINE, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

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
  // This test asserts MID-LINE render internals (per-cycle fb32/pipe/reg
  // state), which only the live incremental path exhibits — under the
  // Tier-3 line-batch mode pixels/commits land at line end or on a CPU
  // observer event, both byte-identical at every CPU-observable point.
  // Pin the live path so a LINE_BATCH=1 suite run still tests this contract.
  v.lineBatchRender = false;
  v.ram = new Uint8Array(0x10000);
  v.colorRam = new Uint8Array(0x0400);
  v.charRom = new Uint8Array(0x1000);
  v.currentVicBank = 0;
  return v;
}

function driveTo(vic, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error(`drive timeout (at r=${vic.raster} c=${vic.cycleInLine})`);
  }
}

// ─── T1: right-SET pending entry queued at cycle 55 phi1 ─────────────────
//
// Spec: rule 1 fires when X reaches right comparator value (344 for
// CSEL=1) — that's cycle 55's segment (X=336..344). Verify a pending
// entry of kind 'hRightSet' exists after the cycle-55 phi1 tick, with
// detectCycle=55, cselAtFire=1, and a spriteSnapshot attached.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;        // DEN=1, RSEL=1, YSCROLL=3
  vic.regs[0x16] = 0x08;        // CSEL=1
  vic.displayEnabled = true;

  // Drive into the visible range. Use raster 100 (mid-display, vBorder=0).
  driveTo(vic, 100, 1);
  expect(vic.vBorderActive === false, 'pre: vBorder=0 mid-display');

  // Walk to cycle 55 — right-SET should fire at phi1 of c55.
  driveTo(vic, 100, 55);
  const pendingAtC55 = vic._pendingFFTransitions.filter(p => p.kind === 'hRightSet');
  expect(pendingAtC55.length === 1, `T1: exactly one hRightSet pending at c55, got ${pendingAtC55.length}`);
  if (pendingAtC55.length > 0) {
    const p = pendingAtC55[0];
    expect(p.detectCycle === 55, `T1: pending.detectCycle == 55, got ${p.detectCycle}`);
    expect(p.cselAtFire === 1, `T1: pending.cselAtFire == 1 (CSEL=1 at fire), got ${p.cselAtFire}`);
    expect(!!p.spriteSnapshot,
      'T1: pending must carry spriteSnapshot for veto-time rollback');
  }
  expect(vic.hBorderActive === true,
    'T1: hBorderActive set true at cycle 55 (immediate flip on detect)');
  ok('T1: right-SET pending queued at cycle 55 with sprite snapshot');
}

// ─── T2: trick fires — pending drained after cycle-57 latch eval ─────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  driveTo(vic, 100, 55);
  expect(vic.hBorderActive === true, 'pre c56: border closed by c55 SET');
  expect(vic._pendingFFTransitions.some(p => p.kind === 'hRightSet'),
    'pre c56: hRightSet pending exists');

  // Cycle 56 phi1: VIC tick. (CPU phi2 runs after via vic.clock or test
  // controls — but the deferred-latch model just needs regs[0x16] to
  // reflect new CSEL by phi1 of cycle 57. We write directly here, mimicking
  // a CPU phi2 write that lands inside the trick window.)
  vic.clock(1);
  expect(vic.cycleInLine === 56, 'c56 reached');
  // Simulate STA $D016 #$00 — clears CSEL.
  vic.write(0x16, 0x00);        // CSEL=0

  // Cycle 57 phi1: latch eval reads regs[0x16] = CSEL=0. cselAtFire=1,
  // curCsel=0. Probe = cycle 56 segment X=352..360. newRight=335 NOT
  // in segment → veto fires.
  vic.clock(1);
  expect(vic.cycleInLine === 57, 'c57 reached');

  // After veto: pending list drained for hRightSet. (Other vBorder
  // pendings may exist independently; we only care about the hRightSet.)
  const remaining = vic._pendingFFTransitions.filter(p => p.kind === 'hRightSet');
  expect(remaining.length === 0,
    `T2: hRightSet drained after c57 latch eval, got ${remaining.length} leftover`);
  expect(vic.hBorderActive === false,
    'T2: veto restored hBorderActive=false (border now open)');
  ok('T2: cycle-57 latch eval drains pending and restores hBorder=false');
}

// ─── T3: lineCycleHBorder[55..56] is rewritten to 0 by veto rollback ─────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  driveTo(vic, 100, 55);
  // At c55 the capture function runs at end of cycle, so
  // lineCycleHBorder[55] = 1 (border closed).
  expect(vic.lineCycleHBorder[55] === 1,
    'pre veto: lineCycleHBorder[55] = 1 (closed)');
  vic.clock(1);                   // c56
  expect(vic.lineCycleHBorder[56] === 1,
    'pre veto (c56 captured): lineCycleHBorder[56] = 1');
  vic.write(0x16, 0x00);          // STA $D016 mid-c56
  vic.clock(1);                   // c57 — veto fires here
  // Rollback: lineCycleHBorder[55, 56] rewritten to 0.
  expect(vic.lineCycleHBorder[55] === 0,
    `T3: lineCycleHBorder[55] rewritten to 0 by veto, got ${vic.lineCycleHBorder[55]}`);
  expect(vic.lineCycleHBorder[56] === 0,
    `T3: lineCycleHBorder[56] rewritten to 0 by veto, got ${vic.lineCycleHBorder[56]}`);
  ok('T3: veto rewrites lineCycleHBorder[55..56] to 0');
}

// ─── T4: cycle 58 sees hBorderActive=false (border stays open) ───────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  driveTo(vic, 100, 56);
  vic.write(0x16, 0x00);          // trick write at c56 phi2
  vic.clock(1);                   // c57 — veto
  vic.clock(1);                   // c58
  expect(vic.cycleInLine === 58, 'c58 reached');
  expect(vic.hBorderActive === false,
    'T4: border stays open at c58 after the cycle-56 veto');
  ok('T4: post-veto, border stays open through cycle 58 (right edge open)');
}

// ─── T5: sprite at right edge — pixels visible after veto ────────────────
//
// Spec: with main-FF reset (open border) and sprite display on at
// cycle 55-57's canvas X range, the sprite's pixels must be painted
// (the §3.8.2 priority multiplexer puts sprite over background). The
// veto path's spriteSnapshot rollback is what allows this — without
// it, the sprite render at cycle 55 was gated by borderBuffer=1 and
// no pixels were drawn.
//
// Synthesis: place sprite 0 at X≈340 (canvas X=348, near the right
// border). Drive to cycle 55 of a vBorder=0 display line, run the
// trick, then verify sprite pixels are visible at canvas X 352..359
// (cycle 56's segment).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  // Sprite 0: enabled, single-color, opaque pixels in row data.
  vic.regs[0x15] = 0x01;
  vic.regs[0x27] = 0x07;          // sprite 0 color = yellow
  vic.regs[0x00] = 0x4C;          // X low: 0x4C = 76 → X = 76 (no MSB)
  // Wait — we want the sprite at the right edge. X=340. low=340-256=84,
  // MSB bit 0 set in $D010.
  vic.regs[0x00] = 84;
  vic.regs[0x10] = 0x01;          // sp0 X MSB set → X = 256+84 = 340
  vic.regs[0x01] = 100;           // Y = 100, will match raster 100
  vic.regs[0x21] = 0x06;          // bg = blue
  vic.regs[0x20] = 0x0E;          // border = lt blue

  // Place sprite data — opaque "all 1s" in first row at sprite block 0x80
  // (256 bytes per sprite block? actually 64 bytes/block at $80*64 = $2000).
  // Easier: put pointer 0x80 → data at $80*64 = 0x2000.
  for (let i = 0; i < 63; i++) vic.ram[0x2000 + i] = 0xFF;
  vic.ram[0x07F8] = 0x80;         // sp0 pointer

  // Drive to L100 c55 — DMA already started at L99 c55 (Y=100 matches
  // L100, but DMA-start check fires when raster equals Y, so at L100 c55).
  // Actually rule 2 says check at c55: Y matches lower 8 bits of raster.
  // At L100 c55 → Y=100 matches → DMA on, MCBASE=0. At L100 c58 (rule 4)
  // display turns on (impl: c59 row-access). So sprite displays from L101.
  // To get display ON at L100, we need Y to have matched at L99. So Y=99.
  vic.regs[0x01] = 99;

  driveTo(vic, 100, 55);
  expect(vic.spriteDisplayOn[0] === 1,
    'pre c55: sp0 display on (Y=99 matched at L99, display latched)');

  // Cycle 56 phi2 trick:
  vic.clock(1);                   // c56
  vic.write(0x16, 0x00);          // CSEL=0 — STA $D016 #$00
  vic.clock(1);                   // c57 — veto fires, sprite re-render
  vic.clock(1);                   // c58

  const canvasY = 100 - 15;       // 85
  const ro = canvasY * CANVAS_W;
  // Cycle 56 canvas X start = (56-12)*8 + 8 = 360. End = 368.
  // Sprite at canvas X = 340+8 = 348 → spans 348..371 (24px).
  // Cycle 55 canvas X = (55-12)*8 + 8 = 352. So sprite covers cycles
  // 55, 56, 57 entirely.
  //
  // After veto rollback:
  //   - borderBuffer at canvas X 352..367 (cycles 55, 56) rewritten to 0
  //     (border open).
  //   - sprite snapshot restored, sprite re-painted in those cycles.
  //   - Pixels at canvas X 348..367 should be sprite-yellow (or border
  //     color where the sprite hasn't reached yet).
  //
  // The sprite starts at canvas X=348 (X=340 + 8 offset). Cycle 55 is
  // canvas X 352..359. So sprite pixels 4..11 land in cycle 55. After
  // veto these should be painted YELLOW.

  let yellowCount = 0;
  const yellowRGBA = paletteRGBA(0x07);
  for (let x = 352; x < 360; x++) {
    if (vic.fb32[ro + x] === yellowRGBA) yellowCount++;
  }
  expect(yellowCount > 0,
    `T5: sprite must paint at least one yellow pixel in cycle-55 segment (X 352..359), got ${yellowCount}`);

  // Border buffer at cycle 55..57 segments must show "open" (=0).
  let openCount = 0;
  for (let x = 352; x < 376; x++) {
    if (vic.borderBuffer[x] === 0) openCount++;
  }
  expect(openCount === 24,
    `T5: borderBuffer at canvas X 352..375 must be 0 (open) for all 24 px, got ${openCount}`);

  // Sprite ownership claimed at the painted pixels.
  let ownedCount = 0;
  for (let x = 348; x < 368; x++) {
    if (vic.spriteOwnerBuffer[x] === 0) ownedCount++;
  }
  expect(ownedCount > 0,
    `T5: spriteOwnerBuffer must record sp0 ownership for at least one px, got ${ownedCount}`);

  ok('T5: sprite at right edge re-paints after veto rollback (pixels visible in opened border)');
}

// ─── T6: NO trick fired — pending hRightSet commits, border stays closed ─
//
// Negative control: at cycle 56 phi2, do NOT write $D016. Then at
// cycle 57 latch eval, cselAtFire=1 and curCsel=1 — no veto. Border
// stays closed (hBorderActive=true).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  driveTo(vic, 100, 55);
  vic.clock(1); // c56
  // No $D016 write.
  vic.clock(1); // c57 — latch eval, no veto
  expect(vic.hBorderActive === true,
    'T6: no veto → border stays closed at c57');
  expect(vic.lineCycleHBorder[55] === 1,
    'T6: lineCycleHBorder[55] stays 1 (no rollback)');
  expect(vic.lineCycleHBorder[56] === 1,
    'T6: lineCycleHBorder[56] stays 1 (no rollback)');
  ok('T6: control case — no $D016 write at c56 → no veto, border closed normally');
}

// ─── T7: cycle-56 right-prevent trick on a vBorder=1 line CANNOT open ────
//
// Bauer §3.9: the right-edge pulse only SETS the main border FF. The
// §3.14.1 cycle-56 trick VETOES that SET — i.e. it undoes the set,
// restoring the FF to whatever it was BEFORE. On a vBorder=1 line the main
// FF is ALREADY set (rule 6 left-RESET is gated by "vBorder NOT set", so it
// never reset this line), so the SET is redundant and the veto restores the
// FF to SET → the border stays CLOSED. The trick can only open the bottom
// border if it was started on an EARLIER line (before vBorder went 1), so
// the FF was already reset and carried across. This is the border-250 (the
// trick starts at line 250, opens) vs border-251/252 (starts on the bottom-
// compare line itself, stays closed) distinction from the VICE references.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  // Drive into the bottom border (raster 260 > bottom-compare 251 → vBorder
  // set naturally; rule 6 never reset the main FF this line → hBorder=1).
  driveTo(vic, 260, 55);
  expect(vic.vBorderActive === true, 'pre: raster 260 is in the bottom border (vBorder=1)');
  expect(vic.hBorderActive === true, 'pre: main FF already SET on a vBorder=1 line (rule 6 blocked)');
  vic.clock(1);                   // c56
  vic.write(0x16, 0x00);          // CSEL=1→0 at c56 phi2 — the right-prevent trick
  vic.clock(1);                   // c57 — veto eval
  while (vic.cycleInLine !== 0) vic.clock(1);   // settle to next line
  // The veto restores the PRE-SET value (1), NOT a forced open. Border
  // stays closed: the trick is one line too late.
  expect(vic.hBorderActive === true,
    'T7: cycle-56 veto restores the pre-SET (closed) FF on a vBorder=1 line — border stays closed');
  ok('T7: right-prevent trick on a vBorder=1 line keeps the border closed (border-251 invariant)');
}

// ─── T8: left-RESET cycle-17 veto (CSEL=0→1 prevents border opening) ────
//
// Bauer §3.14.1: "the horizontal border can be prevented from turning
// off by switching from CSEL=0 to CSEL=1 in cycle 17."
//
// Mechanism: at cycle 15 the left comparator fires (X reaches left
// value, CSEL=0 → left=31 in cycle-15 segment). Pending hLeftReset
// queued, latch at detect+3 = cycle 18. CPU writes $D016 with CSEL=1
// at cycle 17 phi2. Latch eval at cycle 18 phi1 sees curCsel=1,
// cselAtFire=0 → veto. main FF stays SET (border stays closed).
//
// Spec assertion: with CSEL initially 0, walk to cycle 15, verify
// hLeftReset pending fires; write CSEL=1 at cycle 17; cycle 18 latch
// eval vetoes; hBorderActive stays true (border closed across
// would-be display zone).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;                 // DEN=1, RSEL=1
  vic.regs[0x16] = 0x00;                 // CSEL=0 — left=31, fires at c15
  vic.displayEnabled = true;
  driveTo(vic, 100, 1);
  expect(vic.vBorderActive === false, 'pre: vBorder=0 mid-display');

  // At cycle 14 hBorder is still SET from previous line's right SET.
  driveTo(vic, 100, 15);
  // After cycle 15 phi1 the left compare fires → main FF reset →
  // hBorderActive=false (tentatively). Pending hLeftReset queued.
  expect(vic.hBorderActive === false,
    'post c15: left compare reset main FF (border opens for display)');
  const pendingLeft = vic._pendingFFTransitions.filter(p => p.kind === 'hLeftReset');
  expect(pendingLeft.length === 1,
    `T8: hLeftReset pending after c15, got ${pendingLeft.length}`);
  if (pendingLeft.length > 0) {
    expect(pendingLeft[0].cselAtFire === 0,
      'T8: pending.cselAtFire == 0 (CSEL=0 at fire)');
    expect(pendingLeft[0].detectCycle === 15, 'T8: pending.detectCycle == 15');
  }

  // Walk to c16, c17 — at c17 phi2 CPU writes $D016 with CSEL=1.
  vic.clock(1);                           // c16
  vic.clock(1);                           // c17
  vic.write(0x16, 0x08);                  // CSEL=1 (trick write)

  // c18 latch eval — veto fires (cselAtFire=0, curCsel=1).
  vic.clock(1);
  expect(vic.cycleInLine === 18, 'c18 reached');
  const remaining = vic._pendingFFTransitions.filter(p => p.kind === 'hLeftReset');
  expect(remaining.length === 0,
    `T8: hLeftReset drained after c18 latch eval, got ${remaining.length}`);
  expect(vic.hBorderActive === true,
    'T8: veto restored hBorderActive=true (border stays CLOSED, opening prevented)');
  ok('T8: cycle-17 left-RESET veto — CSEL=0→1 keeps main FF set, border stays closed');
}

// ─── T9: trick repeated for many lines (steady-state hyperscreen) ────────
//
// Spec: the §3.14.1 cycle-56 trick is per-line. Each line independently
// fires its own SET pulse and (if CPU writes $D016 in time) its own
// veto. A demo holds the side border open across N lines by repeating
// the trick on every line.
//
// This test scripts the trick across 5 consecutive lines and verifies:
//   - Each line queues a fresh hRightSet pending.
//   - Each line's veto fires (cselAtFire=1, curCsel=0).
//   - Each line ends with hBorderActive=false (border held open).
//   - The pending queue stays bounded (no leaks across lines).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;        // CSEL=1
  vic.displayEnabled = true;
  driveTo(vic, 100, 1);

  for (let i = 0; i < 5; i++) {
    const r = 100 + i;
    driveTo(vic, r, 55);
    expect(vic.hBorderActive === true, `line ${r} c55: SET fired (border closed)`);
    expect(vic._pendingFFTransitions.some(p => p.kind === 'hRightSet'),
      `line ${r} c55: hRightSet pending queued`);

    // Restore CSEL=1 for next line's left-reset compare (so reset can
    // open the border on the next line normally), then trick at c56.
    vic.clock(1);                       // c56
    vic.write(0x16, 0x00);              // CSEL=0 trick write
    vic.clock(1);                       // c57 — veto fires
    expect(vic.hBorderActive === false,
      `line ${r} c57: veto opened border`);
    vic.write(0x16, 0x08);              // restore CSEL=1 for next-line left compare

    // No leftover pending at end of trick window.
    const leftover = vic._pendingFFTransitions.filter(p => p.kind === 'hRightSet');
    expect(leftover.length === 0,
      `line ${r} c57: hRightSet pending drained, got ${leftover.length}`);
  }
  ok('T9: trick fires repeatedly on 5 consecutive lines — no pending queue leak');
}

// ─── T10: trick on a bad-line raster (TRACE 7 collision check) ───────────
//
// Per the screen→top-border BA trace's TRACE 7: on a bad-line raster
// with any sprite enabled, AEC is low at cycles 15..59 inclusive,
// INCLUDING cycle 56. The CPU is HALTED — it cannot execute STA $D016
// at cycle 56 phi2.
//
// Spec consequence: even though the impl's pending/veto mechanism
// would still process an artificial $D016 write (we can simulate it
// in a unit test by writing regs directly), on real hardware the
// trick fundamentally cannot fire on bad-line + sprite rasters.
//
// The MEMORY check here: when the trick IS simulated (we just write
// regs[0x16] regardless of CPU stall), the impl's veto eval still
// produces the correct geometric result — namely, hBorderActive
// rolls back to false. This validates the deferred-latch mechanism
// is independent of CPU bus state. The "demo can't actually fire
// this on bad-line" caveat is documented in TRACE 7.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B | 3;             // DEN=1, YSCROLL=3
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  vic.regs[0x15] = 0x01;                  // sp0 enabled for AEC contribution
  vic.regs[0x01] = 0x33;                  // Y=51 → DMA at L51

  // Drive to L51 (yscroll=3 match → bad line) c55. Both bad-line and
  // sprite contribute to BA-low; at c56 AEC=low.
  driveTo(vic, 0x33, 55);
  expect(vic._isBadLine(0x33, vic.regs) === true, 'pre: L$33 is a bad line');
  expect(vic.hBorderActive === true, 'pre: c55 SET fired');

  vic.clock(1);                           // c56
  // Real CPU would be halted (AEC low). Test simulates the write.
  vic.write(0x16, 0x00);                  // CSEL=0
  vic.clock(1);                           // c57 — veto eval

  // Mechanism still works geometrically. Document the caveat:
  //   On real hardware, no STA $D016 here because CPU halted.
  expect(vic.hBorderActive === false,
    'T10: veto mechanism is independent of CPU bus state — fires geometrically');
  ok('T10: cycle-56 veto mechanism is geometrically correct on bad-line; spec-blocked on real HW (per TRACE 7)');
}

// ─── T11: $D016 write that does NOT change CSEL must NOT trigger veto ────
//
// Spec: rule 1's veto path triggers only when CSEL transitions 1→0
// during the latch window (Bauer §3.14.1 — "the change from CSEL=1 to
// CSEL=0 has to be exactly in cycle 56"). A $D016 write that changes
// only XSCROLL (bits 0-2) or MCM (bit 4) leaves CSEL unchanged and
// MUST NOT trigger the veto.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;        // CSEL=1, XSCROLL=0
  vic.displayEnabled = true;
  driveTo(vic, 100, 56);
  // Write $D016 with CSEL=1 still set, only XSCROLL bits change.
  vic.write(0x16, 0x0B);        // CSEL=1, XSCROLL=3
  vic.clock(1);                  // c57 latch eval — cselAtFire=1, curCsel=1
  expect(vic.hBorderActive === true,
    'T11: XSCROLL-only $D016 write does NOT trigger veto (CSEL unchanged)');
  ok('T11: $D016 write that preserves CSEL must not trigger §3.14.1 veto');
}

// ─── T12: trick with NO sprite (snapshot has nothing to roll back) ───────
//
// Spec: the veto rollback restores sprite state. With no sprites
// enabled, the snapshot captures all-zero state and the rollback is a
// no-op for sprites. The border-buffer rewrite still happens. Verify
// no crash, hBorder rolls back correctly.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x00;                  // no sprites
  vic.displayEnabled = true;
  driveTo(vic, 100, 56);
  vic.write(0x16, 0x00);
  vic.clock(1);                           // c57 — veto fires
  expect(vic.hBorderActive === false,
    'T12: no-sprite veto still rolls back hBorderActive');
  expect(vic.lineCycleHBorder[55] === 0,
    'T12: lineCycleHBorder[55] rewritten by veto (no-sprite path)');
  ok('T12: veto rollback works with no sprites enabled — snapshot/restore harmless');
}

// ─── T13: render output — pixels at cycles 55-57 are NOT border color ────
//
// Spec end-to-end: after the veto, the canvas pixels at cycle 55-57
// (canvas X 352..375) must NOT be the border color $D020. Instead they
// should reflect the open-border content (bg color or idle byte,
// depending on whether the line is a bad line / vBorder zone).
//
// Concrete: vBorder=0, no bad-line, mode=standard text. Open zone
// renders idle byte. With idleByte=0 and bg0=blue, pixels are blue.
// Border color is set to a different color (e.g., red) so we can
// distinguish.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x20] = 0x02;                  // border = red
  vic.regs[0x21] = 0x06;                  // bg0 = blue
  vic.displayEnabled = false;             // no bad lines → idle path
  driveTo(vic, 100, 56);
  vic.write(0x16, 0x00);
  vic.clock(1);                           // c57 veto
  vic.clock(1);                           // c58

  const canvasY = 100 - 15;               // 85
  const ro = canvasY * CANVAS_W;
  const redRGBA = paletteRGBA(0x02);

  // Cycle 55 segment = canvas X 352..359. After veto these pixels
  // must NOT be border color (border was rolled back to OPEN).
  let redCount = 0;
  for (let x = 352; x < 376; x++) {
    if (vic.fb32[ro + x] === redRGBA) redCount++;
  }
  expect(redCount === 0,
    `T13: cycle 55-57 pixels must NOT be border color after veto, got ${redCount} red px`);
  ok('T13: rendered canvas at cycles 55-57 is NOT border color after veto (border opened)');
}

// ─── T14: trick fails — write at cycle 54 phi2 (too early) ───────────────
//
// Bauer §3.14.1 quote: "the change from CSEL=1 to CSEL=0 has to be
// exactly in cycle 56." A cycle-54 write is after the CSEL=0 right
// compare point but before the CSEL=1 right compare point; the emulator
// must not treat that stale implementation gap as a valid open-border
// trick. It should close the border normally and not veto it later.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  driveTo(vic, 100, 54);
  vic.write(0x16, 0x00);                  // CSEL=0 at cycle 54 phi2
  vic.clock(1);                           // c55 phi1 — detect uses live regs
  expect(vic.cycleInLine === 55, 'c55 reached');
  const pending = vic._pendingFFTransitions.filter(p => p.kind === 'hRightSet');
  expect(pending.length === 1,
    `T14: early CSEL=0 still produces a non-vetoable right SET, got ${pending.length} pending`);
  if (pending.length > 0) {
    expect(pending[0].vetoable === false,
      'T14: too-early right SET is marked non-vetoable');
  }
  expect(vic.hBorderActive === true,
    'T14: hBorderActive closes; cycle-54 write is not the hyperscreen trick');
  vic.clock(1);                           // c56
  vic.clock(1);                           // c57 latch eval, no veto
  expect(vic.hBorderActive === true,
    'T14: hBorderActive remains closed after latch eval');
  ok('T14: $D016 write before cycle 56 does not open the right border');
}

// ─── T15: cycle 56 phi2 write hits canonical veto window ────────────────
//
// Edge: the latch model has phi1/phi2 distinct half-cycles. A CPU
// write "at cycle 56" lands at phi2 of cycle 56. Our impl observes
// CSEL by phi1 of c57 (after the c56 phi2 write). Test by walking to
// c56 then writing — typical case. (Already covered by T2/T3, this
// is the explicit phi1/phi2 boundary check.)
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  driveTo(vic, 100, 55);
  expect(vic.hBorderActive === true, 'pre c56: SET fired at c55');

  vic.clock(1);                           // c56 phi1
  expect(vic.cycleInLine === 56, 'c56 phi1');
  vic.write(0x16, 0x00);                  // c56 phi2 write
  vic.clock(1);                           // c57 phi1 — veto eval
  expect(vic.hBorderActive === false,
    'T15: c56 phi2 trick window — veto fires (canonical case)');
  ok('T15: canonical c56 phi2 trick — explicit phi1/phi2 boundary');
}

// ─── helpers ──────────────────────────────────────────────────────────────

function paletteRGBA(idx) {
  const c = C64_PALETTE[idx & 0x0F];
  return (0xFF000000 | ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF)) >>> 0;
}

console.log(`\n${testNo} cycle-56 veto sprite-rollback spec tests; ${failing} fail`);
if (failing) process.exit(1);
