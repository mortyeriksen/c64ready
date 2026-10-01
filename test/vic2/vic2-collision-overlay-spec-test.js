import assert from 'node:assert/strict';
import { CollisionOverlay, CollisionIndicator } from '../../src/vic2-collision-overlay.js';
import { SWITCHES } from '../../src/switches.js';
import { CANVAS_W, CANVAS_H } from '../../src/vic2.js';
import { newVic, placeSprites, runFrame, standardWrites } from './_vic2-equivalence.js';

assert.equal(SWITCHES.vicCollisionOverlay.default, false, 'Diagnostic overlay is opt-in');
const overlay = new CollisionOverlay();
const graphics = new Uint8Array(CANVAS_W), sprites = new Uint8Array(CANVAS_W);
graphics[1] = 1; sprites[2] = 0x80; graphics[3] = 1; sprites[3] = 1; sprites[4] = 0x81;
overlay.capture(0, graphics, sprites);
assert.deepEqual([...overlay.mask.slice(0, 5)], [0, 1, 2, 3, 3],
  'Overlay classifies foreground, single sprites and both overlap types independently of color');
graphics.fill(0); sprites.fill(0); overlay.capture(1, graphics, sprites);
assert.equal(overlay.mask[1], 1, 'Completed row survives reuse of the line buffers');
const source = new Uint8ClampedArray(CANVAS_W * CANVAS_H * 4).fill(100);
const composed = overlay.compose(source);
assert.deepEqual([...composed.slice(0, 20)], [100,100,100,100,50,177,50,255,50,50,177,255,177,50,50,255,177,50,50,255],
  'Overlay uses green graphics, blue sprites and red overlaps over original pixels');
assert.ok(source.every(x => x === 100), 'Presentation cannot change the raw framebuffer');
assert.equal(overlay.compose(source), composed, 'Presentation reuses its output allocation');

const saved = process.env.VIC_COLLISION_OVERLAY;
try {
  for (const live of [false, true]) {
    process.env.VIC_COLLISION_OVERLAY = '0'; const plain = newVic();
    process.env.VIC_COLLISION_OVERLAY = '1'; const marked = newVic();
    assert.equal(plain._collisionOverlay, null, 'Disabled overlay allocates no diagnostic buffers');
    for (const v of [plain, marked]) {
      placeSprites(v, [100,100,110,120,130,140,150,160]);
      for (let s = 0; s < 8; s++) v.regs[s * 2 + 1] = 70;
      v.irqMask = live ? 6 : 0;
    }
    for (let frame = 0; frame < 2; frame++) {
      runFrame(plain, standardWrites); runFrame(marked, standardWrites);
      assert.deepEqual(marked.serialize(), plain.serialize(),
        `Display diagnostic preserves serialized emulation state (live=${live})`);
      assert.ok(marked._collisionOverlay.mask.some(x => x === 3), 'Rendered sprite overlaps reach the diagnostic frame');
      assert.notDeepEqual(marked.presentationBuffer(), plain.frameBuffer, 'Enabled overlay is visible');
      assert.deepEqual(marked.frameBuffer, plain.frameBuffer, 'Overlay preserves raw pixels after composition');
      assert.equal(plain.presentationBuffer(), plain.frameBuffer, 'Disabled presentation passes through without copying');
    }
    const state = marked.serialize();
    marked.deserialize(state);
    assert.ok(marked._collisionOverlay.mask.every(x => x === 0), 'Restore discards stale diagnostic rows');
    marked._collisionOverlay.mask.fill(3); marked.reset();
    assert.ok(marked._collisionOverlay.mask.every(x => x === 0), 'Reset discards stale diagnostic rows');
  }
} finally {
  if (saved === undefined) delete process.env.VIC_COLLISION_OVERLAY;
  else process.env.VIC_COLLISION_OVERLAY = saved;
}
console.log('PASS collision overlay classification, presentation isolation, live/deferred state parity, reset and restore');

const label = { hidden: true };
const indicator = new CollisionIndicator(label);
const signal = { collisionPending: false };
indicator.update(100, signal);
assert.equal(label.hidden, true, 'Indicator stays hidden before a collision');
signal.collisionPending = true; indicator.update(200, signal);
assert.equal(label.hidden, false, 'Detected collision shows the indicator');
assert.equal(signal.collisionPending, false, 'Indicator consumes each detection once');
indicator.update(399, signal);
assert.equal(label.hidden, false, 'Indicator holds for 200 ms of host time');
indicator.update(400, signal);
assert.equal(label.hidden, true, 'Indicator expires at 200 ms without emulation advancing');
signal.collisionPending = true; indicator.update(2000, signal);
signal.collisionPending = true; indicator.update(2100, signal);
indicator.update(2299, signal);
assert.equal(label.hidden, false, 'Another collision extends the hold');
indicator.update(2300, signal);
assert.equal(label.hidden, true, 'Extended hold expires after the latest collision');
console.log('PASS collision indicator host-time hold and retrigger');

const filteredOverlay = new CollisionOverlay();
const filteredLabel = { hidden: true };
const filteredIndicator = new CollisionIndicator(filteredLabel);
graphics.fill(0); sprites.fill(0);
graphics[0] = 1; sprites[0] = 0x80;
filteredOverlay.capture(0, graphics, sprites);
filteredIndicator.update(100, filteredOverlay);
assert.equal(filteredLabel.hidden, true, 'Sprite-background overlap cannot trigger the badge');
assert.equal(filteredOverlay.mask[0], 3, 'Sprite-background overlap retains its red pixel tint');
sprites[0] = 0x81;
filteredOverlay.capture(0, graphics, sprites);
filteredIndicator.update(200, filteredOverlay);
assert.equal(filteredLabel.hidden, false, 'Two distinct sprite bits trigger the badge');
sprites[0] = 0x80;
filteredOverlay.capture(0, graphics, sprites);
filteredIndicator.update(399, filteredOverlay);
filteredIndicator.update(400, filteredOverlay);
assert.equal(filteredLabel.hidden, true, 'Sprite-background overlap cannot extend the sprite collision hold');
console.log('PASS badge filters sprite-background overlaps');
