// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/crt.js – C64 .CRT cartridge file parser
// Format: 64-byte header + 1..N CHIP packets.
// See Peter Schepers' CRT.TXT (CCS64 .CRT cartridge format) for the field layout.

const MAGIC_CART = 'C64 CARTRIDGE   ';
const MAGIC_CHIP = 'CHIP';

function asciiAt(bytes, offset, length) {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i]);
  return s;
}

function readU16BE(b, o) { return (b[o] << 8) | b[o + 1]; }
function readU32BE(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

export function parseCRT(bytes) {
  if (bytes.length < 0x40) {
    throw new Error(`CRT too small: ${bytes.length} bytes (need ≥64)`);
  }
  if (asciiAt(bytes, 0, 16) !== MAGIC_CART) {
    throw new Error('Not a CRT file (bad header magic)');
  }

  const headerLen = readU32BE(bytes, 0x10);
  const hwType    = readU16BE(bytes, 0x16);
  const exrom     = bytes[0x18];
  const game      = bytes[0x19];
  const nameRaw   = asciiAt(bytes, 0x20, 32);
  const name      = nameRaw.replace(/\0+.*$/, '').trim();

  const chips = [];
  let offset = headerLen;
  while (offset < bytes.length) {
    if (offset + 16 > bytes.length) {
      throw new Error(`Truncated CHIP packet at offset 0x${offset.toString(16)}`);
    }
    if (asciiAt(bytes, offset, 4) !== MAGIC_CHIP) {
      throw new Error(`Bad CHIP magic at offset 0x${offset.toString(16)}`);
    }
    const packetLen = readU32BE(bytes, offset + 4);
    const type      = readU16BE(bytes, offset + 8);
    const bank      = readU16BE(bytes, offset + 10);
    const loadAddr  = readU16BE(bytes, offset + 12);
    const size      = readU16BE(bytes, offset + 14);
    const dataStart = offset + 16;
    const dataEnd   = dataStart + size;
    if (dataEnd > bytes.length || packetLen < 16) {
      throw new Error(`Truncated CHIP data at offset 0x${offset.toString(16)}`);
    }
    chips.push({
      type, bank, loadAddr, size,
      data: bytes.subarray(dataStart, dataEnd),
    });
    offset += packetLen;
  }

  return { hwType, exrom, game, name, chips };
}
