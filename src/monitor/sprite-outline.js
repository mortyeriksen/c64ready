// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

// Inspection ink stays distinct from the emulated palette and surrounding theme.
export const SPRITE_OUTLINE_COLOUR = '#ff1493';

// Trace recorded coverage, keeping reused slots and neighbouring slots separate.
export function traceSpriteOutlines(frame, paths) {
  const { width, height, owners, border } = frame;
  const same = (index, slot) => owners[index] === slot && !border[index];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, slot = owners[i];
    if (slot >= 8 || border[i]) continue;
    const path = paths[slot];
    if (y === 0 || !same(i - width, slot)) { path.moveTo(x,y); path.lineTo(x+1,y); }
    if (x === width-1 || !same(i + 1, slot)) { path.moveTo(x+1,y); path.lineTo(x+1,y+1); }
    if (y === height-1 || !same(i + width, slot)) { path.moveTo(x+1,y+1); path.lineTo(x,y+1); }
    if (x === 0 || !same(i - 1, slot)) { path.moveTo(x,y+1); path.lineTo(x,y); }
  }
}

export function drawSpriteOutlines(ctx, paths, selected, width, height, rasterOffset) {
  ctx.save();
  ctx.translate(80, rasterOffset);
  ctx.beginPath(); ctx.rect(0,0,width,height); ctx.clip();
  ctx.translate(.5,.5);
  ctx.lineCap = 'square';
  ctx.strokeStyle = SPRITE_OUTLINE_COLOUR; ctx.lineWidth = 1;
  for (let slot = 0; slot < paths.length; slot++) if (selected < 0 || slot === selected) ctx.stroke(paths[slot]);
  ctx.restore();
}
