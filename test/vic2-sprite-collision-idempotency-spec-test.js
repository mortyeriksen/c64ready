// _latchSpriteSpriteCollision must be idempotent under repeated calls
// for the same (pIdx, spriteIdx). The veto/re-render path can replay
// sprite-pixel emission for an already-painted cycle; a naïve
// "existingSpr !== 0" check would treat this sprite's own previously-
// written bit as another sprite and latch a phantom self-collision.

import { VIC2, CANVAS_W } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.currentVicBank = 0x0000;
  vic.irqHandler = () => {};
  return vic;
}

let testNo = 0, failing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { failing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

// ── 1: duplicate same-sprite emission does NOT latch a collision ──────
{
  const vic = makeVic();
  const pIdx = 100;
  vic._latchSpriteSpriteCollision(pIdx, 0);
  expect(vic.regs[0x1E] === 0, `first call: $D01E stays 0 (no other sprite present)`);
  expect(vic.spriteCollisionBuffer[pIdx] === 0x01, `buffer marks sprite 0`);
  vic._latchSpriteSpriteCollision(pIdx, 0);
  expect(vic.regs[0x1E] === 0, `second call (same sprite): $D01E STILL 0 (got $${vic.regs[0x1E].toString(16)})`);
  expect(vic.spriteCollisionBuffer[pIdx] === 0x01, `buffer unchanged`);
  ok('Repeated emission for same (pIdx, sprite) is a no-op');
}

// ── 2: real two-sprite collision still latches correctly ───────────────
{
  const vic = makeVic();
  const pIdx = 200;
  vic._latchSpriteSpriteCollision(pIdx, 1);    // sprite 1 first
  expect(vic.regs[0x1E] === 0, `lone sprite 1 emission: no collision`);
  vic._latchSpriteSpriteCollision(pIdx, 4);    // sprite 4 collides
  expect(vic.regs[0x1E] === 0x12, `sprite 1 + 4 collision: $D01E = $12 (got $${vic.regs[0x1E].toString(16)})`);
  expect(vic.spriteCollisionBuffer[pIdx] === 0x12, `buffer = $12`);
  ok('Genuine two-sprite collision still latches into $D01E');
}

// ── 3: re-replaying the second sprite does not flip extra bits ────────
{
  const vic = makeVic();
  const pIdx = 300;
  vic._latchSpriteSpriteCollision(pIdx, 2);
  vic._latchSpriteSpriteCollision(pIdx, 5);
  const afterFirst = vic.regs[0x1E];
  expect(afterFirst === 0x24, `sprites 2+5 collide → $D01E = $24 (got $${afterFirst.toString(16)})`);
  // Replay sprite 5 pass.
  vic._latchSpriteSpriteCollision(pIdx, 5);
  expect(vic.regs[0x1E] === 0x24, `replay does not change $D01E (got $${vic.regs[0x1E].toString(16)})`);
  // Replay sprite 2 pass too.
  vic._latchSpriteSpriteCollision(pIdx, 2);
  expect(vic.regs[0x1E] === 0x24, `replay does not change $D01E`);
  ok('Replays after a real collision do not alter $D01E');
}

// ── 4: IMMC IRQ fires only on first 0→non-zero transition ──────────────
{
  const vic = makeVic();
  vic.irqMask = 0x04;                          // enable IMMC
  let irqRaises = 0;
  vic.irqHandler = (level) => { if (level) irqRaises++; };
  const pIdx = 320;  // canvas column (side buffers line-sized #1; was 400)
  vic._latchSpriteSpriteCollision(pIdx, 0);    // lone, no IRQ
  expect(irqRaises === 0, `lone sprite: no IMMC raise`);
  vic._latchSpriteSpriteCollision(pIdx, 3);    // 0→3 collision: IMMC raises
  expect(irqRaises === 1, `0+3 collision: IMMC raised once`);
  // Replay should NOT raise IMMC again — $D01E is already non-zero so
  // the 0→non-zero edge already fired, and the replay is a no-op anyway.
  vic._latchSpriteSpriteCollision(pIdx, 0);
  vic._latchSpriteSpriteCollision(pIdx, 3);
  expect(irqRaises === 1, `replays do not refire IMMC (raises=${irqRaises})`);
  ok('IMMC raises exactly once across replays of the same collision');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
