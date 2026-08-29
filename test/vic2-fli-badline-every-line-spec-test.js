// FLI primitives spec test — the per-line VIC behaviours an FLI effect
// depends on, asserted cycle-exact against Bauer §3.7.2 / §3.5.
//
// SCOPE NOTE: this tests the VIC's per-cycle fetch machinery in isolation —
// it does NOT reproduce Coma Light 13's exact mechanism. (Investigation
// found Coma is NOT a pure bad-line-every-line FLI: its 44-cycle $5200
// routine plus 8-sprite DMA already fills the line, so the matrix is
// re-fetched via PARTIAL mid-line c-accesses, and the central plasma also
// uses sprite Y-expand crunch.) These
// assertions still matter: they lock in the bad-line primitives every FLI
// builds on, and they isolate the conclusion that Coma's bug is WRITE
// TIMING, not a missing VIC behaviour.
//
// Uses the bare-VIC2 cycle driver with register pokes at exact cycles — the
// same pattern as vic2-badline-ba-aec-boundary-spec-test.js / vic2-midline-register-
// spec-test.js.
//
// What this pins down:
//   • EARLY YSCROLL write (before the cycle-14 bad-line sample) → the line
//     is a bad line: 40 c-accesses, RC reset to 0, and because RC never
//     reaches 7, VCBASE stays frozen. Done every line → the VIC re-fetches
//     the video matrix from that line's $D018/bank region (the FLI base
//     case our VIC handles correctly).
//   • LATE YSCROLL write (cycle ≥ 55, after the c-access window) does NOT
//     turn the line into a 40-column bad line and does NOT make the next
//     line a bad line (the next cycle-14 sample no longer matches). This is
//     SPEC-CORRECT, and demonstrates why a mistimed (late) write — Coma's
//     symptom in our run — fails to lock in.
//
// Reference: Bauer "MOS 6567/6569" §3.7.2 (bad-line c-access / RC / VCBASE),
//            §3.5 (bad-line condition may be produced/cancelled mid-line by
//            writing YSCROLL).

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}
function eq(a, b, msg) { assert(a === b, `${msg} — expected ${b}, got ${a}`); }

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  vic.regs[0x16] = 0x08;   // CSEL=1, XSCROLL=0
  vic.regs[0x15] = 0x00;   // no sprites — isolate bad-line BA/c-access
  vic.displayEnabled = true;
  return vic;
}

// Instrument the real c-access path: record per-raster how many c-accesses
// fired and at which cycles, plus the screen base each one used (so we can
// see the per-line region re-fetch + any mid-line region split).
function instrument(vic) {
  const cByRaster = new Map();   // raster -> [{cycle, screenBase, code}]
  const orig = vic._fetchScreenRowColumn.bind(vic);
  vic._fetchScreenRowColumn = function (col, regs, bank) {
    const r = vic.raster;
    if (!cByRaster.has(r)) cByRaster.set(r, []);
    const screenBase = ((regs[0x18] >> 4) & 0x0F) * 0x0400;
    orig(col, regs, bank);
    cByRaster.get(r).push({ cycle: vic.cycleInLine, col, screenBase, code: vic.rowScreenCodes[col] });
    return undefined;
  };
  return cByRaster;
}

function driveToLineStart(vic, raster) {
  let guard = 0;
  while (!(vic.raster === raster && vic.cycleInLine === 0)) {
    vic.clock(1);
    if (++guard > CYCLES_PER_LINE * 320) throw new Error('driveToLineStart overrun');
  }
}

// ════════════════════════════════════════════════════════════════════════
// PART A — EARLY YSCROLL write: bad line on EVERY line (canonical FLI)
// ════════════════════════════════════════════════════════════════════════
{
  const vic = makeVic();
  // Distinct matrix bytes in two screen regions so a per-line region change
  // produces visibly different fetched codes.
  vic.regs[0x18] = 0x14;                 // screen base nibble 1 → $0400
  for (let i = 0; i < 0x4000; i++) vic.ram[i] = (i * 13 + 7) & 0xFF;
  vic.regs[0x11] = 0x1B;                 // DEN, RSEL, mode=text, YSCROLL=3

  const cByRaster = instrument(vic);
  driveToLineStart(vic, 60);

  // Drive lines 60..71. Each line: poke YSCROLL = raster&7 at cycle 10 (well
  // before the cycle-14 bad-line sample) AND alternate the screen base each
  // line so we can confirm the matrix is re-fetched from the live region.
  const seen = [];
  for (let line = 60; line <= 71; line++) {
    let rc14 = null, vc14 = null, vcb14 = null, rc58 = null, dispLine = false;
    for (let c = 1; c <= CYCLES_PER_LINE; c++) {
      vic.clock(1);
      const cyc = vic._thisCycleInLine;
      if (cyc === 10) {
        // force this line into a bad line, and select a per-line region:
        // even line → screen base $0400 (nibble 1), odd → $1000 (nibble 4)
        const nib = (line & 1) ? 4 : 1;
        vic.regs[0x18] = (vic.regs[0x18] & 0x0F) | (nib << 4);
        vic.regs[0x11] = 0x18 | (vic.raster & 7);
      }
      if (cyc === 14) { rc14 = vic.rc; vc14 = vic.vc; vcb14 = vic.vcBase; dispLine = vic.displayActive; }
      if (cyc === 58) rc58 = vic.rc;
    }
    const recs = cByRaster.get(line) || [];
    seen.push({ line, n: recs.length, rc14, vc14, vcb14, rc58, disp: dispLine,
      cycles: recs.map(r => r.cycle), bases: [...new Set(recs.map(r => r.screenBase))],
      codes0: recs.length ? recs[0].code : null });
  }

  console.log('PART A — bad line every line (early YSCROLL write)');
  console.log('line  c-acc  cyc-range  rc@14 vcBase@14 rc@58  screenBase  code[0]');
  for (const s of seen) {
    console.log(`  ${s.line}   ${String(s.n).padStart(2)}    ${s.cycles[0]}..${s.cycles[s.cycles.length - 1]}   ` +
      `${s.rc14}     ${String(s.vcb14).padStart(4)}     ${s.rc58}    $${s.bases[0].toString(16)}      $${(s.codes0 ?? 0).toString(16)}`);
  }
  console.log('');

  // Skip the first couple of lines (state settling from the natural YSCROLL=3
  // boundary); assert from line 62 onward where the forced FLI is locked.
  for (const s of seen.filter(x => x.line >= 62)) {
    eq(s.n, 40, `A line ${s.line}: 40 c-accesses (matrix re-fetched, bad line)`);
    eq(s.cycles[0], 15, `A line ${s.line}: first c-access at cycle 15`);
    eq(s.cycles[s.cycles.length - 1], 54, `A line ${s.line}: last c-access at cycle 54`);
    eq(s.rc14, 0, `A line ${s.line}: RC reset to 0 at cy14 (bad line every line)`);
    eq(s.rc58, 0, `A line ${s.line}: RC stays 0 (reset every line, never reaches 7)`);
    assert(s.disp, `A line ${s.line}: display state active`);
    eq(s.bases.length, 1, `A line ${s.line}: single screen base (no mid-line change here)`);
  }
  // VCBASE frozen across the whole FLI run (RC never hits 7 → no VCBASE<-VC).
  const vcbVals = new Set(seen.filter(x => x.line >= 62).map(x => x.vcb14));
  eq(vcbVals.size, 1, 'A: VCBASE frozen across FLI (RC never reaches 7)');
  // Per-line region re-fetch: even/odd lines read from different screen bases
  // → different code[0]. Proves the matrix is re-fetched from the LIVE region
  // every line (this is what makes the plasma).
  const evenBase = seen.find(x => x.line === 62).bases[0];
  const oddBase = seen.find(x => x.line === 63).bases[0];
  assert(evenBase !== oddBase, 'A: alternating lines fetch from different screen bases (per-line region re-fetch)');
  const evenCode = seen.find(x => x.line === 62).codes0;
  const oddCode = seen.find(x => x.line === 63).codes0;
  assert(evenCode !== oddCode, 'A: per-line region change yields different fetched codes (FLI plasma source)');
}

// ════════════════════════════════════════════════════════════════════════
// PART B — LATE YSCROLL write: does NOT lock in (Coma's failure mode)
// ════════════════════════════════════════════════════════════════════════
// Writing YSCROLL to match raster&7 only at cycle 55 (after the c-access
// window) cannot turn that line into a 40-column bad line, and the *next*
// line is not a bad line either (its cy14 sample sees the now-stale value).
// This is exactly what our headless Coma trace shows, and it is SPEC-CORRECT
// — so the demo's writes must be landing late (CPU/stable-raster entry
// timing), which is the real bug. This part pins that conclusion.
{
  const vic = makeVic();
  vic.regs[0x18] = 0x14;
  for (let i = 0; i < 0x4000; i++) vic.ram[i] = (i * 13 + 7) & 0xFF;
  vic.regs[0x11] = 0x1A;                 // DEN, RSEL, YSCROLL=2 (no natural bad line in window below)

  const cByRaster = instrument(vic);
  driveToLineStart(vic, 60);

  // Lines 60..67 (60&7=4..): none are natural bad lines for YSCROLL=2 except
  // raster 66 (66&7=2). On every line, write YSCROLL=raster&7 but LATE — at
  // cycle 55, after the c-access window has closed.
  const seen = [];
  for (let line = 60; line <= 65; line++) {   // avoid 66 (natural bad line)
    for (let c = 1; c <= CYCLES_PER_LINE; c++) {
      vic.clock(1);
      if (vic._thisCycleInLine === 55) vic.regs[0x11] = 0x18 | (vic.raster & 7);
    }
    seen.push({ line, n: (cByRaster.get(line) || []).length });
  }
  console.log('PART B — late YSCROLL write (cycle 55) does not lock in FLI');
  for (const s of seen) console.log(`  line ${s.line}: ${s.n} c-accesses`);
  console.log('');

  // No line gets a full 40-column refetch from a cy55 write: the c-access
  // window (15..54) is already past. The matrix line buffer therefore freezes
  // — precisely the Coma symptom.
  for (const s of seen) {
    assert(s.n < 40, `B line ${s.line}: late (cy55) YSCROLL write does NOT produce a 40-column bad line (got ${s.n})`);
  }
}

// ════════════════════════════════════════════════════════════════════════
// PART C — mid-line $D018 screen-base change splits the c-access (Coma uses
// a mid-line $D018 write each FLI line; the left/right columns must fetch
// from different regions). Bauer §3.7.4 / §3.6.3: $D018 is sampled live.
// ════════════════════════════════════════════════════════════════════════
{
  const vic = makeVic();
  vic.regs[0x18] = 0x14;                 // start: screen base $0400
  for (let i = 0; i < 0x4000; i++) vic.ram[i] = (i * 13 + 7) & 0xFF;
  vic.regs[0x11] = 0x1B;                 // bad line at raster&7==3

  const cByRaster = instrument(vic);
  driveToLineStart(vic, 59);             // 59&7==3 → bad line
  // Run the bad line; switch screen base to nibble 4 ($1000) at cycle 34
  // (c-access for column 19 is at cycle 34; columns ≥ that index use new base).
  for (let c = 1; c <= CYCLES_PER_LINE; c++) {
    vic.clock(1);
    if (vic._thisCycleInLine === 34) vic.regs[0x18] = (vic.regs[0x18] & 0x0F) | (4 << 4);
  }
  const recs = cByRaster.get(59) || [];
  eq(recs.length, 40, 'C: bad line still does 40 c-accesses with a mid-line $D018 write');
  const bases = recs.map(r => r.screenBase);
  const distinct = [...new Set(bases)];
  eq(distinct.length, 2, 'C: c-accesses split across exactly two screen bases (mid-line $D018 live-sampled)');
  // Early columns use the original base, later columns the new one.
  eq(bases[0], 0x0400, 'C: first columns fetch from the original screen base $0400');
  eq(bases[bases.length - 1], 0x1000, 'C: last columns fetch from the new screen base $1000');
  console.log('PART C — mid-line $D018 split: bases used =', distinct.map(b => '$' + b.toString(16)).join(', '));
  console.log('');
}

if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1); }
console.log('PASS — FLI bad-line-every-line core + mid-line $D018 split match spec; ' +
  'late-write failure mode reproduced (Coma bug is write TIMING, not VIC rendering)');
