// VIC-II: sprite p-access happens every line even with DMA off (s-access gated)
//
// Bauer §3.6.3, diagram "6569, Bad Line, no sprites" (https://www.cebix.net/VIC-Article.txt,
// VIC row :1022):
//
//   VIC i 3 i 4 i 5 i 6 i 7 i r r r r r cgcg...cg i i 0 i 1 i 2 i 3
//
// With NO sprites active, the sprite-pointer accesses (p-accesses) STILL occur:
//   - sprites 3,4,5,6,7 at cycles 1,3,5,7,9
//   - sprites 0,1,2     at cycles 58,60,62
// The sprite-data slots (the `i` between/after them: cycles 2,4,6,8,10 and
// 59,61,63) are IDLE — no s-access, because s-accesses (§3.8.1 rule 5) only
// run when a sprite's DMA is on. So the pointer fetch is unconditional; only
// the 3 data fetches are DMA-gated.
//
// Pointer address (§3.8.1 / §2.4.2): VIC bank base + (screen base from $D018
// bits 4-7) + $3F8 + sprite#.

import {
  assert,
  makeVic,
} from './_vic2-helpers.js';

// Bauer §3.6.3 "no sprites" diagram: cycle -> sprite whose pointer is fetched.
const P_ACCESS = { 1: 3, 3: 4, 5: 5, 7: 6, 9: 7, 58: 0, 60: 1, 62: 2 };
// The s-access slots that are IDLE when DMA is off (diagram shows `i` here).
const S_SLOTS = [2, 4, 6, 8, 10, 59, 61, 63];

// ---------------------------------------------------------------------------
// Test 1: the p-access cycle schedule matches Bauer's "no sprites" diagram.
// ---------------------------------------------------------------------------
{
  const vic = makeVic();
  for (const [cycle, sprite] of Object.entries(P_ACCESS)) {
    assert(
      vic._getSpritePointerAccessSprite(Number(cycle)) === sprite,
      `Bauer §3.6.3 no-sprites diagram: cycle ${cycle} is the p-access for sprite ${sprite}`,
    );
  }
  for (const cycle of S_SLOTS) {
    assert(
      vic._getSpritePointerAccessSprite(cycle) === -1,
      `Bauer §3.6.3: cycle ${cycle} is an s-access slot (idle with DMA off), not a p-access`,
    );
  }
  console.log('ok  - p-access cycle schedule matches the §3.6.3 "no sprites" diagram');
}

// ---------------------------------------------------------------------------
// Test 2: with all DMA off, every sprite's pointer is STILL fetched at its
// p-access cycle, reading from screenBase + $3F8 + sprite#.
// ---------------------------------------------------------------------------
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;          // no sprites enabled -> no DMA will ever start
  vic.regs[0x18] = 0x14;          // screen base = bits 4-7 (1) * $0400 = $0400
  vic.currentVicBank = 0x0000;
  const screenBase = 0x0400;
  // Distinct, recognizable pointer byte per sprite at $0400+$3F8+s = $07F8+s.
  for (let s = 0; s < 8; s++) vic.ram[screenBase + 0x3F8 + s] = 0x40 + s;

  for (const [cycleStr, sprite] of Object.entries(P_ACCESS)) {
    const cycle = Number(cycleStr);
    vic.spritePointerFresh[sprite] = 0;   // clear so we observe a real fetch
    vic._spriteSequencerPointerAccess(cycle);
    const expectedPtr = 0x40 + sprite;
    assert(
      vic.spritePointerFresh[sprite] === 1,
      `§3.6.3: sprite ${sprite} p-access at cycle ${cycle} fires even with DMA off`,
    );
    assert(
      vic.spritePointerValue[sprite] === expectedPtr,
      `§3.8.1: sprite ${sprite} pointer = byte at screenBase+$3F8+${sprite} ($${(screenBase + 0x3F8 + sprite).toString(16)})`,
    );
    assert(
      vic.spriteDataBase[sprite] === expectedPtr * 64,
      `§3.8.1: sprite ${sprite} data base = pointer*64`,
    );
    assert(
      vic.spriteDmaOn[sprite] === 0,
      `§3.8.1: the p-access does NOT turn DMA on for sprite ${sprite}`,
    );
  }
  console.log('ok  - all 8 sprite pointers fetched with DMA off, from screenBase+$3F8+s');
}

// ---------------------------------------------------------------------------
// Test 3: with DMA off, the s-access slots perform NO sprite-data fetch — MC
// does not advance (the 3 s-accesses are DMA-gated, §3.8.1 rule 5).
// ---------------------------------------------------------------------------
{
  const vic = makeVic();
  vic.regs[0x18] = 0x14;
  vic.currentVicBank = 0x0000;
  // s-access slot -> the sprite whose data would be fetched there (the pair
  // partner of the preceding p-access cycle in the diagram).
  const S_SPRITE = { 2: 3, 4: 4, 6: 5, 8: 6, 10: 7, 59: 0, 61: 1, 63: 2 };
  for (const [cycleStr, sprite] of Object.entries(S_SPRITE)) {
    const cycle = Number(cycleStr);
    vic.spriteDmaOn[sprite] = 0;
    vic.spritePointerFresh[sprite] = 1;     // pointer was fetched this line
    const mcBefore = 0x15;                   // sentinel
    vic.spriteMC[sprite] = mcBefore;
    vic._spriteSequencerRowAccess(cycle);
    assert(
      vic.spriteMC[sprite] === mcBefore,
      `§3.8.1 rule 5: s-access slot cycle ${cycle} (sprite ${sprite}) does NOT advance MC when DMA is off`,
    );
    assert(
      vic.spriteDmaOn[sprite] === 0,
      `§3.8.1: the idle s-slot cycle ${cycle} leaves DMA off for sprite ${sprite}`,
    );
  }
  console.log('ok  - s-access slots are idle (MC frozen) when DMA is off');
}

// ---------------------------------------------------------------------------
// Test 4 (contrast): the s-access IS real when DMA is on — MC advances by 3.
// Proves Test 3's freeze is the DMA gate, not a dead code path.
// ---------------------------------------------------------------------------
{
  const vic = makeVic();
  vic.regs[0x18] = 0x14;
  vic.currentVicBank = 0x0000;
  vic.ram[0x07F8] = 0x22;                  // sprite 0 pointer
  const base = 0x22 * 64;
  vic.ram[base + 0] = 0xAA;
  vic.ram[base + 1] = 0xBB;
  vic.ram[base + 2] = 0xCC;

  vic._spriteSequencerPointerAccess(58);   // p-access sprite 0 -> sets base + fresh
  vic.spriteDmaOn[0] = 1;
  vic.spriteMC[0] = 0;
  vic._spriteSequencerRowAccess(59);       // s-access sprite 0

  assert(vic.spriteMC[0] === 3,
    '§3.8.1 rule 5: with DMA on, the 3 s-accesses advance MC by 3');
  assert(
    vic.spriteRowData[0][0] === 0xAA &&
    vic.spriteRowData[0][1] === 0xBB &&
    vic.spriteRowData[0][2] === 0xCC,
    '§3.8.1 rule 5: with DMA on, the s-accesses read the 3 sprite-data bytes',
  );
  console.log('ok  - s-access fetches data and advances MC when DMA is on (contrast)');
}

console.log('\nAll sprite p-access-DMA-off (§3.6.3 / §3.8.1) tests passed.');
