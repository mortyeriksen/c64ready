// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/media/sid.js – PSID / RSID files, read and wrapped for the machine.
//
// A tune is not played by emulating a player. It is run the way a C64 runs it:
// the file's own driver, on the real 6510, driving the real SID. What this
// module does is turn a .sid into one ordinary .prg — a BASIC stub, a copier,
// the C64-side player, its parameter block and the tune's bytes — and the
// loader takes it from there with no idea a .sid was involved.
//
// Everything tune-specific lives in the parameter block, so the player is the
// same bytes for every file (src/media/sid-player-blob.js, built by
// tools/build-sid-player.mjs). Design: investigation/SID-PLAYER-DESIGN.md
//
// The header is big-endian, which no other format here is: the format came from
// a Java program on a big-endian day and never changed.

import {
  PLAYER, PARAM_AT, PARAM_SIZE, PAYLOAD_STAGE, PLAYER_ORIGIN, PLAYER_CEILING,
  PRG_BASE, BLOB_AT, BLOB_SIZE, RELOCATIONS, COPIER_PAGE_AT, COPIER_JMP_AT,
} from './sid-player-blob.js';

const V1_HEADER = 0x76;          // where a version 1 file's data may start
const V2_HEADER = 0x7C;          // version 2 and later add flags and SID addresses
const SCREEN_RAM = { from: 0x0400, to: 0x0800 };
// The SID, the VIC and the CIAs live here. A tune cannot have this range: the
// player would have to give up the chip it is playing through. $E000-$FFFF is a
// different matter — the KERNAL ROM is there, but the RAM underneath it is a
// classic home for a game's music, and the driver can run with the ROM banked
// out for the length of a call (see P_BANK in the player).
const IO_REGISTERS = { from: 0xD000, to: 0xE000 };
const UNDER_KERNAL = 0xE000;
const BANK_NORMAL = 0x36;        // BASIC out, KERNAL in, I/O in
const BANK_NO_KERNAL = 0x35;     // and the KERNAL out too, for the driver alone
// A PAL frame is 312 lines of 63 cycles; an NTSC one 263 of 65. These are the
// timer values a tune driven by the CIA expects to be called at.
const CIA_PAL = 0x4CC7;
const CIA_NTSC = 0x4295;

const word = (b, at) => (b[at] << 8) | b[at + 1];
const long = (b, at) => (word(b, at) * 0x10000) + word(b, at + 2);
const magic = (b, at, text) => [...text].every((ch, i) => b[at + i] === ch.charCodeAt(0));

/**
 * One character of a header field as a C64 screen code. The fields are Latin-1
 * and the player runs in the default upper-case character set, so lower case
 * folds up rather than turning into graphics.
 */
function screenCode(ch) {
  const c = ch.charCodeAt(0);
  if (c >= 65 && c <= 90) return c - 64;
  if (c >= 97 && c <= 122) return c - 96;
  if (c >= 48 && c <= 57) return c;
  return { ' ': 0x20, '.': 0x2E, ',': 0x2C, ':': 0x3A, ';': 0x3B, '/': 0x2F, '-': 0x2D,
           '+': 0x2B, '*': 0x2A, '(': 0x28, ')': 0x29, '&': 0x26, '$': 0x24, '#': 0x23,
           '!': 0x21, '?': 0x3F, "'": 0x27, '"': 0x22, '<': 0x3C, '>': 0x3E, '=': 0x3D,
           '[': 0x1B, ']': 0x1D, '@': 0x00 }[ch] ?? 0x20;
}

/** A 32-byte header field as text, stopping at the first NUL. */
function field(bytes, at) {
  let text = '';
  for (let i = at; i < at + 32 && bytes[i]; i++) text += String.fromCharCode(bytes[i]);
  return text.trim();
}

/**
 * What a .sid says about itself. Throws with a sentence a person can act on
 * when the file is not one, or says something the machine cannot honour.
 * @param {Uint8Array} bytes
 */
export function parseSid(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < V1_HEADER + 2) throw new Error('This file is too short to be a .sid.');
  const rsid = magic(bytes, 0, 'RSID');
  if (!rsid && !magic(bytes, 0, 'PSID')) throw new Error('This is not a PSID or RSID file.');
  const version = word(bytes, 4);
  if (version < 1 || version > 4) throw new Error(`Unsupported .sid version ${version}.`);
  const dataOffset = word(bytes, 6);
  const least = version === 1 ? V1_HEADER : V2_HEADER;
  if (dataOffset < least || dataOffset >= bytes.length) throw new Error('The .sid header points past the end of the file.');

  let loadAddress = word(bytes, 8);
  let payload = bytes.subarray(dataOffset);
  // A load address of zero is the common case: the tune carries its own in the
  // first two bytes of its data, exactly as a .prg does.
  if (loadAddress === 0) {
    if (payload.length < 3) throw new Error('The .sid holds no tune data.');
    loadAddress = payload[0] | (payload[1] << 8);
    payload = payload.subarray(2);
  }
  if (!payload.length) throw new Error('The .sid holds no tune data.');

  const initAddress = word(bytes, 10) || loadAddress;
  const playAddress = word(bytes, 12);
  const songs = Math.min(Math.max(word(bytes, 14) || 1, 1), 99);
  const startSong = Math.min(Math.max(word(bytes, 16) || 1, 1), songs);
  const speed = long(bytes, 18);
  const flags = version === 1 ? 0 : word(bytes, 0x76);

  return {
    format: rsid ? 'RSID' : 'PSID', version, loadAddress, initAddress, playAddress,
    songs, startSong, speed, flags,
    clock: (flags >> 2) & 3,        // 0 unknown, 1 PAL, 2 NTSC, 3 either
    chip: (flags >> 4) & 3,         // 0 unknown, 1 6581, 2 8580, 3 either
    title: field(bytes, 0x16), author: field(bytes, 0x36), released: field(bytes, 0x56),
    payload,
  };
}

/** Where the tune's bytes land once the player has moved them. */
function occupied(tune) {
  return { from: tune.loadAddress, to: tune.loadAddress + tune.payload.length };
}

const overlaps = (a, b) => a.from < b.to && b.from < a.to;

/**
 * Where the player can sit for this tune, page-aligned, or null when nothing
 * fits. Its usual home is $C000 — 4K that most tunes leave alone — but plenty of
 * game rips load at $A000-$BFFF and run straight through it, so rather than
 * refuse them the player moves. It can: every address it holds of its own is in
 * a relocation list, and moving it is that list plus a page delta.
 *
 * It may not sit below the .prg image, because the copier would then be writing
 * over bytes it has not read yet — either its own or the tune's.
 */
function playerAddress(tune, imageLength) {
  const where = occupied(tune);
  const lowest = Math.ceil((PRG_BASE + imageLength) / 256) * 256;
  const free = at => at >= lowest && at + BLOB_SIZE <= PLAYER_CEILING
    && (at + BLOB_SIZE <= where.from || at >= where.to);
  if (free(PLAYER_ORIGIN)) return PLAYER_ORIGIN;
  for (let at = (PLAYER_CEILING - BLOB_SIZE) & 0xFF00; at >= lowest; at -= 256) {
    if (free(at)) return at;
  }
  return null;
}

/**
 * The tune as a runnable .prg: the player, its parameter block filled in, and
 * the tune's own bytes behind it.
 *
 * @param {Uint8Array} bytes  the .sid file
 * @param {object} [options]
 * @param {number} [options.song]  start on this song instead of the file's own
 * @returns {{data: Uint8Array, tune: object}}
 */
export function sidToPrg(bytes, { song } = {}) {
  const tune = parseSid(bytes);
  const where = occupied(tune);
  if (where.from < 0x0200) throw new Error('This tune loads over the zero page and the stack, which the machine needs.');
  if (where.to > 0x10000) throw new Error('This tune runs past the top of the C64\u2019s memory.');
  if (overlaps(where, SCREEN_RAM)) throw new Error('This tune loads over screen memory, which the player draws on.');
  if (overlaps(where, IO_REGISTERS)) throw new Error('This tune loads over the I/O registers, which is where the SID itself is.');
  const imageLength = PLAYER.length - 2 + tune.payload.length;
  const at = playerAddress(tune, imageLength);
  if (at === null) throw new Error('This tune leaves no room anywhere for the player.');

  const start = Math.min(Math.max(song || tune.startSong, 1), tune.songs);
  const data = new Uint8Array(PLAYER.length + tune.payload.length);
  data.set(PLAYER, 0);
  data.set(tune.payload, PLAYER.length);

  // Move the player to where it fits: one page added to every address it holds
  // of its own, and to the copier's two references to where it is going.
  const page = ((at - PLAYER_ORIGIN) >> 8) & 0xFF;
  if (page) {
    for (const { at: offset, kind } of RELOCATIONS) {
      const index = BLOB_AT + offset + (kind === 'word' ? 1 : 0);
      data[index] = (data[index] + page) & 0xFF;
    }
  }
  data[COPIER_PAGE_AT] = (at >> 8) & 0xFF;
  data[COPIER_JMP_AT] = (at >> 8) & 0xFF;

  const put = (at, value) => { data[PARAM_AT + at] = value & 0xFF; };
  const putWord = (at, value) => { put(at, value); put(at + 1, value >> 8); };
  putWord(0, tune.loadAddress);
  putWord(2, tune.payload.length);
  putWord(4, tune.initAddress);
  putWord(6, tune.playAddress);
  put(8, tune.songs);
  put(9, start);
  for (let i = 0; i < 4; i++) put(10 + i, tune.speed >>> (i * 8));
  // Clock and chip keep the header's own bit positions. Bit 1 marks an RSID —
  // a file that says it needs a real C64 — and bit 0 is the view the player
  // opens in: a PSID may snoop the driver's writes to show all three voices,
  // an RSID starts on the safe view and leaves that to a keypress.
  put(14, (tune.flags & 0x3C) | (tune.format === 'RSID' ? 2 : 0) | (tune.format === 'PSID' ? 1 : 0));
  put(15, where.to > UNDER_KERNAL ? BANK_NO_KERNAL : BANK_NORMAL);
  putWord(16, tune.clock === 2 ? CIA_NTSC : CIA_PAL);
  const text = (at, value) => {
    for (let i = 0; i < 32; i++) put(at + i, i < value.length ? screenCode(value[i]) : 0x20);
  };
  text(18, tune.title);
  text(50, tune.author);
  text(82, tune.released);

  return { data, tune };
}

/** The .prg this .sid becomes, named after the file it came from. */
export function openSid(bytes, name, { song } = {}) {
  const { data } = sidToPrg(bytes, { song });
  return { data, name: `${String(name || 'tune').replace(/\.sid$/i, '')}.prg` };
}

export { PAYLOAD_STAGE, PARAM_SIZE };
