// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

// The CPU-visible source is sampled separately from cartridge mode selection.
export function cartridgeWindows(snapshot) {
  const ranges = [];
  for (let page = 0; page < 256; page++) {
    const source = snapshot.cpuMemorySource(page * 256 + 2);
    if (!source.startsWith('Cartridge')) continue;
    const previous = ranges[ranges.length - 1];
    if (previous && previous.end === page * 256 && previous.source === source) previous.end += 256;
    else ranges.push({ start: page * 256, end: (page + 1) * 256, source });
  }
  return ranges;
}

export function reuFrameAccesses(frame) {
  const p = frame?.provenance, accesses = [];
  if (p) for (let i = 0; i < p.count; i++) {
    if (p.kind[i] !== 6 && p.kind[i] !== 7) continue;
    accesses.push({ tick: p.tick[i], write: p.kind[i] === 7, address: p.address[i],
      value: p.value[i], expansion: p.aux[i] & 0xffffff, command: (p.aux[i] >>> 24) & 3 });
  }
  return { accesses, available: !!p, incomplete: !!(frame?.overflow || p?.overflow),
    cycles: (frame?.lines ?? 0) * (frame?.cyclesPerLine ?? 0) };
}
