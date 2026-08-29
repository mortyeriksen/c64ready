// Sprite BA / AEC cycle audit — derived from Bauer's "The MOS 6567/6569
// video controller (VIC-II)" §3.6.1 and §3.8.1, NOT from our impl. Each
// test states the spec rule, derives the expected value from the rule's
// inputs, then asserts. If our impl deviates from the cited rule, the test
// fails — that is the point.
//
// This complements the per-scenario tests already in vic2-test.js (the
// `Nine Demo` block citing https://www.linusakesson.net/scene/nine/explanation.php) with full per-cycle BA/AEC
// coverage for every (mask, cycle) combination, derived from spec rules.
// Of particular interest: the flanking-DMA / ghost-slot rule — the demo
// (per DEMO-NINE.md §1) keeps sprites 0, 2, 4, 6 always enabled so that
// in-between slots cost a constant number of CPU cycles regardless of
// whether the gap sprites are displayed. A drift in our BA logic for this
// case is the most likely root cause of the nine.prg multiplexer drift.
//
// Spec citation:
//   Bauer §3.6.1 "Bus access by VIC":
//     1. For each sprite with its DMA flag set, the VIC needs 2 cycles per
//        scanline: one for the p-access (sprite pointer fetch) and one for
//        the s-access (3 bytes of sprite data fetched via 12-bit bus).
//     2. BA goes low 3 cycles before the *first* sprite access of a
//        contiguous block, stays low through the *last* access.
//     3. AEC follows BA after the 3-cycle warning. Formula: AEC(c) =
//        BA(c) AND BA(c-3).
//
//   Bauer §3.6.1 PAL-cycle table for the 8 sprites (1-based):
//     sp0: p=58 s=59,  sp1: p=60 s=61,  sp2: p=62 s=63,
//     sp3: p=1  s=2,   sp4: p=3  s=4,   sp5: p=5  s=6,
//     sp6: p=7  s=8,   sp7: p=9  s=10
//   Sprites 3..7 wrap to the next scanline; sp2's s=63 is contiguous with
//   sp3's p=1 (next line) — the contiguous DMA block straddles the line
//   boundary.
//
//   Bauer §3.8.1 "Sprite DMA":
//     Rule 3 (cycle 55): if sprite enabled and Y matches raster Y, DMA
//                        flag is set and MCBASE := 0.
//     Rule 8 (cycle 16): if MC == 63, DMA flag clears.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

function expect(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// PAL p-access / s-access cycles per Bauer §3.6.1 (1-based, sp3..sp7 wrap).
const SPRITE_P_CYCLE = [58, 60, 62, 1, 3, 5, 7, 9];
const SPRITE_S_CYCLE = [59, 61, 63, 2, 4, 6, 8, 10];

// Rule 2: BA-low region for each sprite is `{p-3, p-2, p-1, p, s}`. With
// line wrap, cycles before 1 wrap to the previous line; per Bauer the
// previous-line-side leads ARE part of the BA window for steady-state
// scanlines (where the sprite was already in DMA on the previous line).
function baRegionForSprite(s) {
  const p = SPRITE_P_CYCLE[s], sCyc = SPRITE_S_CYCLE[s];
  // Lead-in cycles, with wrap-back into the previous line for sp3..sp7.
  const region = [];
  for (let lead = 3; lead >= 1; lead--) {
    let c = p - lead;
    if (c < 1) c += CYCLES_PER_LINE; // wraps onto previous line
    region.push(c);
  }
  region.push(p, sCyc);
  return region.sort((a, b) => a - b);
}

// AEC formula per Bauer rule 3: AEC(c) = BA(c) AND BA(c-3).
function aecFromBa(baLowSet) {
  const aec = new Set();
  for (const c of baLowSet) {
    let prev = c - 3;
    if (prev < 1) prev += CYCLES_PER_LINE;
    if (baLowSet.has(prev)) aec.add(c);
  }
  return aec;
}

// Compute the spec-expected BA-low set for a steady-state scanline where
// sprites in `enabledMask` all have DMA on for both this line AND the
// previous line (so the wrap-back leads contribute too).
function specBaLowForMask(enabledMask) {
  const set = new Set();
  for (let s = 0; s < 8; s++) {
    if (!((enabledMask >> s) & 1)) continue;
    for (const c of baRegionForSprite(s)) set.add(c);
  }
  return set;
}

// Probe BA / AEC at every cycle 1..63 of a line via the impl's helpers
// (pure functions of `spriteDmaOn`). Returns Sets for easy comparison.
function probeImpl(vic) {
  const ba = new Set(), aec = new Set();
  for (let c = 1; c <= CYCLES_PER_LINE; c++) {
    if (vic._spriteBaLow(c)) ba.add(c);
    if (vic._spriteAecLow(c)) aec.add(c);
  }
  return { ba, aec };
}

function setEq(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function setStr(s) {
  return '[' + [...s].sort((a, b) => a - b).join(',') + ']';
}

// ── Per-sprite spec audit ────────────────────────────────────────────────
// For each sprite alone, derive the spec BA-low and AEC-low sets from
// Bauer §3.6.1, then verify our impl matches.
for (let s = 0; s < 8; s++) {
  const vic = makeVic();
  vic.spriteDmaOn.fill(0);
  vic.spriteDmaOn[s] = 1;

  const specBa = specBaLowForMask(1 << s);
  const specAec = aecFromBa(specBa);
  const got = probeImpl(vic);

  expect(setEq(got.ba, specBa),
    `sp${s} alone: spec BA = ${setStr(specBa)} (Bauer §3.6.1), got ${setStr(got.ba)}`);
  expect(setEq(got.aec, specAec),
    `sp${s} alone: spec AEC = ${setStr(specAec)} (Bauer rule 3), got ${setStr(got.aec)}`);
  console.log(`ok  - sp${s} alone: BA=${setStr(specBa)} AEC=${setStr(specAec)} (Bauer §3.6.1)`);
}

// ── Contiguous-pair audit: sp0+sp1, sp1+sp2, sp4+sp5, sp6+sp7 ────────────
// Two adjacent sprites share the 3-cycle lead because the second sprite's
// access starts just after the first's — Bauer rule 2's "contiguous block"
// language. Derive the union from per-sprite regions, assert.
for (const [a, b] of [[0, 1], [1, 2], [4, 5], [6, 7]]) {
  const vic = makeVic();
  vic.spriteDmaOn.fill(0);
  vic.spriteDmaOn[a] = 1;
  vic.spriteDmaOn[b] = 1;

  const specBa = specBaLowForMask((1 << a) | (1 << b));
  const specAec = aecFromBa(specBa);
  const got = probeImpl(vic);

  expect(setEq(got.ba, specBa),
    `sp${a}+sp${b}: spec BA = ${setStr(specBa)}, got ${setStr(got.ba)}`);
  expect(setEq(got.aec, specAec),
    `sp${a}+sp${b}: spec AEC = ${setStr(specAec)}, got ${setStr(got.aec)}`);
  console.log(`ok  - sp${a}+sp${b} contiguous: BA fuses, AEC ${setStr(specAec)}`);
}

// ── Ghost-slot audit: sp0+sp2 with sp1 disabled ──────────────────────────
// sp0 access ends at cycle 59. sp2 lead starts at cycle 59 (=62-3). The
// regions touch — Bauer rule 2 implies BA stays continuously low. AEC at
// sp1's would-be access cycles (60, 61) IS triggered because BA(60..61)
// is covered by sp0's tail + sp2's lead, and BA(c-3) reaches back into
// sp0's BA-low region. This is the "ghost-slot stealing" demos rely on.
{
  const vic = makeVic();
  vic.spriteDmaOn.fill(0);
  vic.spriteDmaOn[0] = 1;
  vic.spriteDmaOn[2] = 1;

  const specBa = specBaLowForMask(0b101);
  const specAec = aecFromBa(specBa);
  const got = probeImpl(vic);

  expect(setEq(got.ba, specBa),
    `sp0+sp2 ghost: spec BA = ${setStr(specBa)}, got ${setStr(got.ba)}`);
  expect(setEq(got.aec, specAec),
    `sp0+sp2 ghost: spec AEC = ${setStr(specAec)} (sp1's cycles 60,61 stolen), got ${setStr(got.aec)}`);
  // Sanity: sp1's "would-be" access cycles 60, 61 must be in AEC.
  expect(specAec.has(60) && specAec.has(61),
    `sp0+sp2 ghost: spec AEC must include sp1's slots 60, 61`);
  expect(got.aec.has(60) && got.aec.has(61),
    `sp0+sp2 ghost: impl AEC missing sp1's stolen slots`);
  console.log('ok  - sp0+sp2 ghost-slot: AEC includes sp1\'s 60,61 (BA continuous)');
}

// ── Gap-too-wide: sp0+sp3 with sp1, sp2 disabled ─────────────────────────
// sp0 BA region ends at cycle 59. sp3 BA region starts at lead = (1-3)+63
// = 61 (wrap). Cycle 60 is BA-high — NOT a contiguous block.
{
  const vic = makeVic();
  vic.spriteDmaOn.fill(0);
  vic.spriteDmaOn[0] = 1;
  vic.spriteDmaOn[3] = 1;

  const specBa = specBaLowForMask(0b1001);
  const specAec = aecFromBa(specBa);
  const got = probeImpl(vic);

  expect(setEq(got.ba, specBa),
    `sp0+sp3 gap: spec BA = ${setStr(specBa)}, got ${setStr(got.ba)}`);
  expect(!got.ba.has(60),
    `sp0+sp3 gap: cycle 60 must be BA-high (gap), got got.ba=${setStr(got.ba)}`);
  expect(setEq(got.aec, specAec),
    `sp0+sp3 gap: spec AEC = ${setStr(specAec)}, got ${setStr(got.aec)}`);
  console.log(`ok  - sp0+sp3 (sp1,sp2 off): cycle 60 BA-high, no fusion`);
}

// ── All-8 contiguous spec audit ──────────────────────────────────────────
// Bauer rule 1: 8 sprites × 2 cycles = 16 access cycles. Plus the single
// 3-cycle lead at the head of the (single) contiguous block. Total BA-low
// per scanline = 19 cycles. AEC = 16 cycles (every access cycle, since the
// lead pre-fills BA(c-3) for each).
{
  const vic = makeVic();
  vic.spriteDmaOn.fill(1);

  const specBa = specBaLowForMask(0xFF);
  const specAec = aecFromBa(specBa);
  const got = probeImpl(vic);

  expect(specBa.size === 19,
    `spec self-check: 8 sprites × 2 + 3 lead = 19 BA-low cyc, derived ${specBa.size}`);
  expect(specAec.size === 16,
    `spec self-check: 8 sprites × 2 = 16 AEC-low cyc, derived ${specAec.size}`);
  expect(setEq(got.ba, specBa),
    `all 8: spec BA = ${setStr(specBa)} (19 cyc), got ${setStr(got.ba)}`);
  expect(setEq(got.aec, specAec),
    `all 8: spec AEC = ${setStr(specAec)} (16 cyc), got ${setStr(got.aec)}`);
  console.log(`ok  - all 8 sprites: BA=19 cyc, AEC=16 cyc per scanline (Bauer rule 1)`);
}

// ── Empty mask: no DMA → no stalls ───────────────────────────────────────
{
  const vic = makeVic();
  vic.spriteDmaOn.fill(0);
  const got = probeImpl(vic);
  expect(got.ba.size === 0, `no DMA: BA must stay high all line, got ${setStr(got.ba)}`);
  expect(got.aec.size === 0, `no DMA: AEC must stay high all line`);
  console.log('ok  - no DMA: BA and AEC high all line (Bauer rule 1, no sprites)');
}

// ── Bauer §3.8.1 rule 3: Y match at cycle 55 sets DMA flag ───────────────
// Drive the live VIC: enable sprite, set Y = raster, run to cycle 55 of
// that line, verify DMA flag transitions 0 → 1 *at* cycle 55.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 51;
  vic.displayEnabled = true;

  for (let i = 0; i < CYCLES_PER_LINE * 51; i++) vic.clock(1);
  expect(vic.spriteDmaOn[0] === 0, `pre L51: DMA must be off`);
  for (let i = 0; i < 54; i++) vic.clock(1);
  expect(vic.cycleInLine === 54 && vic.spriteDmaOn[0] === 0,
    `L51.c54: DMA must still be off (rule 3 fires at cycle 55)`);
  vic.clock(1);
  expect(vic.cycleInLine === 55 && vic.spriteDmaOn[0] === 1,
    `L51.c55: DMA must turn ON (Bauer §3.8.1 rule 3)`);
  console.log('ok  - Bauer §3.8.1 rule 3: Y match at cycle 55 sets sprite DMA');
}

// ── Bauer §3.8.1 rule 8: DMA clears at cycle 16 when MC == 63 ────────────
// 21 lines after the Y match, MCBASE wraps; cycle 16 of that line clears
// DMA. Run forward 21 lines and verify.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 51;
  vic.displayEnabled = true;

  for (let i = 0; i < CYCLES_PER_LINE * 51; i++) vic.clock(1);
  for (let i = 0; i < CYCLES_PER_LINE * 21; i++) vic.clock(1);
  for (let i = 0; i < 16; i++) vic.clock(1);
  expect(vic.cycleInLine === 16 && vic.spriteDmaOn[0] === 0,
    `L72.c16: DMA must clear after 21 sprite-display lines (Bauer §3.8.1 rule 8)`);
  console.log('ok  - Bauer §3.8.1 rule 8: DMA clears at cycle 16 when MC==63');
}

// ── Live-vs-spec comparison on a steady-state scanline ───────────────────
// Run the actual VIC clock through a full line where sp0..sp2 are in DMA,
// and compare each cycle's live BA/AEC to the spec table above.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x07;
  vic.regs[0x01] = 51;
  vic.regs[0x03] = 51;
  vic.regs[0x05] = 51;
  vic.displayEnabled = true;

  for (let i = 0; i < CYCLES_PER_LINE * 52; i++) vic.clock(1);
  const live = new Array(CYCLES_PER_LINE + 1).fill(null);
  for (let i = 0; i < CYCLES_PER_LINE; i++) {
    vic.clock(1);
    const c = vic.cycleInLine === 0 ? CYCLES_PER_LINE : vic.cycleInLine;
    live[c] = { ba: vic.baLow, aec: vic.aecLow };
  }

  const specBa = specBaLowForMask(0b111);
  const specAec = aecFromBa(specBa);
  for (let c = 1; c <= CYCLES_PER_LINE; c++) {
    expect(live[c].ba === specBa.has(c),
      `live BA at cycle ${c}: spec=${specBa.has(c)} got=${live[c].ba}`);
    expect(live[c].aec === specAec.has(c),
      `live AEC at cycle ${c}: spec=${specAec.has(c)} got=${live[c].aec}`);
  }
  console.log('ok  - live VIC.clock matches Bauer-derived BA/AEC table for sp0..sp2');
}

console.log('\nall sprite BA/AEC scenarios match spec');
