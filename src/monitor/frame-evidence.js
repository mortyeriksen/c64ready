// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

export function frameEvidence(frame) {
  const spritePixels = new Uint32Array(8);
  for (const owner of frame.owners) if (owner < 8) spritePixels[owner]++;
  let badLines = 0, openBorderPixels = 0, pointerChanges = 0, writes = 0, origins = 0;
  for (let line = 0; line < frame.lines; line++) {
    let bad = false;
    for (let c = 0; c < frame.cyclesPerLine; c++) if (frame.flags[line * frame.cyclesPerLine + c] & 4) bad = true;
    if (bad) badLines++;
    if (line) for (let s = 0; s < 8; s++) {
      if ((frame.spriteDma[line] & frame.spriteDma[line - 1] & (1 << s)) &&
          (frame.pointers[line * 8 + s] !== frame.pointers[(line - 1) * 8 + s] || frame.spriteBanks[line * 8 + s] !== frame.spriteBanks[(line - 1) * 8 + s])) pointerChanges++;
    }
  }
  for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
    if ((x < 32 || x >= 352 || y < 36 || y >= 236) && !frame.border[y * frame.width + x]) openBorderPixels++;
  }
  for (let i = 0; i < frame.eventCount; i++) if (frame.eventKind[i] < 64) { writes++; if (frame.eventCPU[i]) origins++; }
  return { spritePixels, badLines, openBorderPixels, pointerChanges, writes, origins };
}
