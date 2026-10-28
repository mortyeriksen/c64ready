// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

export const LEARN_SOURCE = 'https://www.cebix.net/VIC-Article.txt';
export const LEARN_QUESTIONS = {
  sprites: { title: 'Which parts of this picture come from sprites?', reference: 'Bauer §3.8 describes sprite DMA, display, priority and collision rules. A hardware slot can represent different objects at different raster positions.', hint: 'Select a sprite slot to isolate its recorded coverage.' },
  border: { title: 'How does the picture escape the border?', reference: 'Bauer §3.9 describes the border flip-flops. Opening the border permits graphics outside the normal screen, but does not identify the source of those graphics.', hint: 'Highlighted pixels lie outside the normal screen with the border mask open.' },
  timing: { title: 'How does everything stay in time?', reference: 'Bauer §3.5 defines the bad-line condition. Sections 2.2 and 2.3 describe how BA and AEC affect CPU bus access. The rule checker compares those rules with recorded evidence.', hint: 'Each column is a CPU cycle. Lit cells show when the VIC owns the bus.' },
};

export function spriteCoverage(frame) {
  const counts = new Uint32Array(8);
  for (let i = 0; i < frame.owners.length; i++) if (!frame.border[i] && frame.owners[i] < 8) counts[frame.owners[i]]++;
  return counts;
}

export function relatedWrites(frame, topic, sprite = -1) {
  const events = [];
  for (let i = 0; i < frame.eventCount; i++) {
    const reg = frame.eventKind[i];
    const related = topic === 'border' ? [0x11, 0x16, 0x20, 0x21].includes(reg)
      : topic === 'timing' ? [0x11, 0x12, 0x15, 0x17, 0x18, 0x19, 0x1A, 0x21].includes(reg)
      : sprite < 0 ? (reg <= 0x10 || [0x15, 0x17, 0x18, 0x1B, 0x1C, 0x1D, 0x25, 0x26].includes(reg) || (reg >= 0x27 && reg <= 0x2E))
      : reg === sprite * 2 || reg === sprite * 2 + 1 || reg === 0x27 + sprite || [0x10, 0x15, 0x17, 0x18, 0x1B, 0x1C, 0x1D, 0x25, 0x26].includes(reg);
    if (related) events.push(i);
  }
  return events;
}

export function spriteSourceAtLine(frame, sprite, line) {
  const index = Math.max(0, Math.min(frame.lines - 1, line)) * 8 + sprite;
  return { pointer: frame.pointers[index], bank: frame.spriteBanks[index], address: frame.spriteBanks[index] + frame.pointers[index] * 64 };
}

// Canvas CSS uses object-fit: contain, so clicks in the letterbox are not pixels.
export function picturePoint(x, y, width, height, pictureWidth, pictureHeight) {
  const scale = Math.min(width / pictureWidth, height / pictureHeight);
  if (scale <= 0) return null;
  const px = (x - (width - pictureWidth * scale) / 2) / scale;
  const py = (y - (height - pictureHeight * scale) / 2) / scale;
  return px < 0 || py < 0 || px >= pictureWidth || py >= pictureHeight ? null : { x: Math.floor(px), y: Math.floor(py) };
}

export function spriteBounds(frame, visibleOnly = false) {
  const bounds = Array.from({length: 8}, () => ({left: frame.width, top: frame.height, right: -1, bottom: -1, pixels: 0}));
  for (let i = 0; i < frame.owners.length; i++) {
    const slot = frame.owners[i];
    if (slot >= 8 || frame.border[i] || (visibleOnly && frame.provenance?.visibleSprites && !frame.provenance.visibleSprites[i])) continue;
    const b = bounds[slot], x = i % frame.width, y = Math.floor(i / frame.width);
    b.left = Math.min(b.left,x); b.right = Math.max(b.right,x);
    b.top = Math.min(b.top,y); b.bottom = Math.max(b.bottom,y); b.pixels++;
  }
  return bounds;
}

// Line samples locate observations without claiming the exact fetch cycle.
export function frameFindings(frame) {
  const groups = [
    { id: 'sprites', label: 'Sprite slots', points: [] },
    { id: 'border', label: 'Open border lines', points: [] },
    { id: 'pointers', label: 'Source changes', points: [] },
    { id: 'badlines', label: 'Bad-line conditions', points: [] },
    { id: 'writes', label: 'VIC writes', points: [] },
  ];
  if (!frame) return groups;
  const seen = new Set();
  for (let y = 0; y < frame.height; y++) {
    let open = false;
    const line = y + frame.rasterOffset;
    for (let x = 0; x < frame.width; x++) {
      const i = y * frame.width + x, slot = frame.owners[i];
      if (frame.border[i]) continue;
      if (slot < 8 && !seen.has(slot)) {
        seen.add(slot);
        groups[0].points.push({ tick: line * frame.cyclesPerLine, line, slot, precision: 'line' });
      }
      if (x < 32 || x >= 352 || y < 36 || y >= 236) open = true;
    }
    if (open) groups[1].points.push({ tick: line * frame.cyclesPerLine, line, precision: 'line' });
  }
  for (let line = 0; line < frame.lines; line++) {
    for (let c = 0; c < frame.cyclesPerLine; c++) {
      const tick = line * frame.cyclesPerLine + c;
      if (frame.flags[tick] & 4) { groups[3].points.push({ tick, line, precision: 'cycle' }); break; }
    }
    if (line) for (let slot = 0; slot < 8; slot++) {
      const i = line * 8 + slot;
      if ((frame.spriteDma[line] & frame.spriteDma[line - 1] & (1 << slot)) &&
          (frame.pointers[i] !== frame.pointers[i - 8] || frame.spriteBanks[i] !== frame.spriteBanks[i - 8])) {
        groups[2].points.push({ tick: (line + 1) * frame.cyclesPerLine - 1, line, slot, precision: 'line-end' });
      }
    }
  }
  for (let event = 0; event < frame.eventCount; event++) if (frame.eventKind[event] < 64) {
    const tick = frame.eventTick[event];
    groups[4].points.push({ tick, line: Math.floor(tick / frame.cyclesPerLine), event, precision: 'cycle' });
  }
  return groups;
}

export function borderEvidence(frame, tick) {
  if (!frame || !Number.isInteger(tick) || tick < 0 || tick >= frame.flags.length) return null;
  const line = Math.floor(tick / frame.cyclesPerLine), y = line - frame.rasterOffset;
  let uncovered = 0, spriteCoverage = 0;
  if (y >= 0 && y < frame.height) for (let x = 0; x < frame.width; x++) {
    if (x >= 32 && x < 352 && y >= 36 && y < 236) continue;
    const p = y * frame.width + x;
    if (!frame.border[p]) { uncovered++; if (frame.owners[p] < 8) spriteCoverage++; }
  }
  const transitions = [];
  for (let c = 0; c < frame.cyclesPerLine; c++) {
    const t = line * frame.cyclesPerLine + c;
    if (!t) continue;
    const changed = (frame.flags[t] ^ frame.flags[t - 1]) & 3;
    if (changed) transitions.push({ tick: t, changed, mainClosed: !!(frame.flags[t] & 1), verticalClosed: !!(frame.flags[t] & 2) });
  }
  // The latest recorded writes before this phi1 sample are related evidence,
  // not proof of which write caused a gate transition.
  const writes = [];
  for (const register of [0x11, 0x16]) {
    let event = -1;
    for (let i = 0; i < frame.eventCount; i++) if (frame.eventKind[i] === register && frame.eventTick[i] < tick) event = i;
    if (event >= 0) writes.push(event);
  }
  return { line, uncovered, spriteCoverage, transitions, writes,
    mainClosed: !!(frame.flags[tick] & 1), verticalClosed: !!(frame.flags[tick] & 2),
    pixelsAvailable: y >= 0 && y < frame.height, incompleteWrites: !!frame.overflow };
}
