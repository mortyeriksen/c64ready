// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { createPrintJob } from '../print-job.js';

export const meta = { id: 'c64ready.iec-printer', name: 'IEC Printer', version: '1.0.0', bus: 'iec',
  apiVersion: 1, address: 4, author: 'C64 READY.', description: 'This printer supports Commodore text and bitmap graphics.' };

// MPS-801/803 command subset, from the Commodore printer manuals.
// Seven data bits, least significant bit at the top, with MPS-803 dot pitch.
export function mpsPrinterPages(bytes) {
  const pages = []; let page = null, x = 0, y = 0, bitmap = false, wide = false, lower = false, reverse = false;
  let incomplete = false, unsupported = 0, limited = false;
  function paper() {
    if (!page) { if (pages.length === 100) { limited = true; return null; } page = []; pages.push(page); }
    return page;
  }
  function feed() { y += bitmap ? 70 : 120; if (y + 80 > 7560) { y = 0; page = null; } }
  function dotColumn(value) {
    if (x >= 5760) { x = 0; feed(); }
    let path = '';
    for (let bit = 0; bit < 7; bit++) if (value & (1 << bit)) path += `M${x} ${y + bit * 10}h12v10h-12z`;
    if (path) {
      const ops = paper(), prev = ops?.at(-1);
      if (prev?.path && prev.path.length < 64000) prev.path += path;
      else ops?.push({ path });
    }
    x += 12;
  }
  for (let i = 0; i < bytes.length && !limited; i++) {
    const b = bytes[i];
    if (b === 8) { bitmap = true; continue; }
    if (b === 14 || b === 15) { wide = b === 14; bitmap = false; continue; }
    if (b === 10) { feed(); continue; }
    if (b === 13) { x = 0; feed(); reverse = false; continue; }
    // Form feed separates browser pages, outside the MPS command subset.
    if (b === 12) { paper(); x = y = 0; page = null; continue; }
    if (b === 17 || b === 145) { lower = b === 17; continue; }
    if (b === 18 || b === 146) { reverse = b === 18; continue; }
    if (b === 16) {
      if (i + 2 >= bytes.length) { incomplete = true; break; }
      const hi = bytes[++i], lo = bytes[++i];
      if (hi >= 48 && hi <= 57 && lo >= 48 && lo <= 57) x = Math.min(79, (hi - 48) * 10 + lo - 48) * 72;
      else unsupported++;
      continue;
    }
    if (b === 27) {
      if (i + 3 >= bytes.length) { incomplete = true; break; }
      if (bytes[++i] === 16) { const hi = bytes[++i], lo = bytes[++i]; x = Math.min(479, hi * 256 + lo) * 12; }
      else unsupported++;
      continue;
    }
    if (bitmap) {
      if (b === 26) {
        if (i + 2 >= bytes.length) { incomplete = true; break; }
        const count = bytes[++i] || 256, value = bytes[++i] & 127;
        for (let n = 0; n < count; n++) dotColumn(value);
      } else if (b & 128) dotColumn(b & 127);
      else unsupported++;
      continue;
    }
    if (b < 32) continue;
    const w = wide ? 144 : 72;
    if (x + w > 5760) { x = 0; feed(); }
    let c = b & 127;
    if (lower && c >= 65 && c <= 90) c += 32;
    else if (lower && c >= 97 && c <= 122) c -= 32;
    const glyph = c === 92 ? '£' : c === 94 ? '↑' : c === 95 ? '←' : c >= 32 && c <= 126 ? String.fromCharCode(c) : '�';
    if (reverse) unsupported++;
    const ops = paper(), prev = ops?.at(-1);
    if (prev?.text && prev.y === y + 80 && prev.x + prev.width === x && prev.width / prev.text.length === w) { prev.text += glyph; prev.width += w; }
    else ops?.push({ text: glyph, x, y: y + 80, width: w });
    x += w;
  }
  return { pages, limited, unsupported, incomplete };
}

export function create(port, host) {
  let serial;
  const job = createPrintJob(host, { decodePages: mpsPrinterPages, onClear: () => serial?.resume() });
  serial = port.createListener({
    onListen: channel => { job.writeByte(channel === 7 ? 17 : 145); },
    onByte: (byte, channel, eoi, kind) => kind !== 'data' || job.writeByte(byte),
  });
  return {
    onLines: serial.onLines, onTimer: serial.onTimer,
    reset: serial.reset,
    detach() { serial.detach(); job.detach(); },
    serialize: () => ({ job: job.serialize(), serial: serial.serialize() }),
    deserialize(state) { if (state?.job) job.deserialize(state.job); serial.deserialize(state?.serial); },
    exportOutput: format => job.exportOutput(format),
  };
}
