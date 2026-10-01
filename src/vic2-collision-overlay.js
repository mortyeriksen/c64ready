// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { CANVAS_W, CANVAS_H } from './vic2-tables.js';

// Display-only snapshots of completed raster lines, independent of IRQ latches.
export class CollisionOverlay {
  constructor() {
    this.collisionPending = false;
    this.mask = new Uint8Array(CANVAS_W * CANVAS_H);
    this.pixels = new Uint8ClampedArray(CANVAS_W * CANVAS_H * 4);
  }

  capture(y, graphics, sprites) {
    const row = y * CANVAS_W;
    for (let x = 0; x < CANVAS_W; x++) {
      const s = sprites[x], g = graphics[x];
      const spriteCollision = (s & (s - 1)) !== 0;
      const collision = s && (g || spriteCollision);
      if (spriteCollision) this.collisionPending = true;
      this.mask[row + x] = collision ? 3 : s ? 2 : g ? 1 : 0;
    }
  }

  compose(source) {
    this.pixels.set(source);
    for (let i = 0; i < this.mask.length; i++) {
      const kind = this.mask[i];
      if (!kind) continue;
      const p = i * 4;
      // Half-strength tint preserves the underlying screen and border.
      this.pixels[p] = (source[p] + (kind === 3 ? 255 : 0)) >> 1;
      this.pixels[p + 1] = (source[p + 1] + (kind === 1 ? 255 : 0)) >> 1;
      this.pixels[p + 2] = (source[p + 2] + (kind === 2 ? 255 : 0)) >> 1;
      this.pixels[p + 3] = 255;
    }
    return this.pixels;
  }
}

// Host-time indicator; sprite-to-sprite detections extend the 200 ms hold.
export class CollisionIndicator {
  constructor(element) {
    this.element = element;
    this.until = 0;
    this.visible = false;
  }

  update(now, overlay) {
    if (overlay?.collisionPending) {
      overlay.collisionPending = false;
      this.until = now + 200;
    }
    const visible = !!overlay && now < this.until;
    if (visible !== this.visible) {
      this.element.hidden = !visible;
      this.visible = visible;
    }
  }
}
