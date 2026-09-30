// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/virtual-drive.js – the DOS behind a trap-served drive. With true drive
// emulation off, the KERNAL's serial primitives (LISTEN, TALK, SECOND, TKSA,
// CIOUT, ACPTR, UNLISTEN, UNTALK) are answered here instead of on the IEC bus.
// Files open, read, write and close over the mounted sector image, the
// directory reads as a channel, buffers take block commands, and channel 15
// takes DOS commands and reports the status line. Everything the KERNAL's
// OPEN, CHKIN, CHRIN, GETIN, CLOSE, LOAD and SAVE do reaches the image this way.

import { TYPE_SEQ, TYPE_PRG, TYPE_USR } from './media/d64.js';

const CR = 0x0D;
const CMD = 15;

// Status messages by code, as the 1541 and 1581 DOS print them. Code 73 names
// the DOS, so it is looked up by disk kind.
const MESSAGES = {
  0: ' OK', 1: 'FILES SCRATCHED',
  20: 'READ ERROR', 21: 'READ ERROR', 22: 'READ ERROR', 23: 'READ ERROR',
  24: 'READ ERROR', 25: 'WRITE ERROR', 26: 'WRITE PROTECT ON', 27: 'READ ERROR',
  28: 'WRITE ERROR', 29: 'DISK ID MISMATCH', 30: 'SYNTAX ERROR', 31: 'SYNTAX ERROR',
  32: 'SYNTAX ERROR', 33: 'SYNTAX ERROR', 34: 'SYNTAX ERROR', 39: 'SYNTAX ERROR',
  60: 'WRITE FILE OPEN', 61: 'FILE NOT OPEN', 62: 'FILE NOT FOUND', 63: 'FILE EXISTS',
  64: 'FILE TYPE MISMATCH', 65: 'NO BLOCK', 66: 'ILLEGAL TRACK OR SECTOR',
  67: 'ILLEGAL SYSTEM T OR S', 70: 'NO CHANNEL', 71: 'DIR ERROR', 72: 'DISK FULL',
  74: 'DRIVE NOT READY',
};
const DOS_NAME = { d81: 'COPYRIGHT CBM DOS V10 1581' };
const DOS_NAME_DEFAULT = 'CBM DOS V2.6 1541';

const TYPE_LETTER = { P: TYPE_PRG, S: TYPE_SEQ, U: TYPE_USR };
const pet = bytes => String.fromCharCode(...bytes);
const two = n => String(n % 100).padStart(2, '0');

export class VirtualDrive {
  /** @param {() => (import('./media/d64.js').D64|null)} getDisk the mounted image, or null */
  constructor(getDisk) {
    this._getDisk = getDisk;
    this.onWrite = null;      // host hook: the image changed
    this.onOpen = null;       // host hook: a data file opened (LED, sound)
    this.opens = 0;
    this.reset();
  }

  get disk() { return this._getDisk(); }

  /** Power-on state: no channels open, the DOS announcing itself. */
  reset() {
    this.channels = new Array(16).fill(null);
    this._listen = null;      // { ch, kind: 'open' | 'close' | 'data', bytes } while listening
    this._talkCh = -1;
    this._reply = null;       // bytes channel 15 hands out next, else the status line
    this._setStatus(73);
  }

  /** A disk swap: what was open is gone; the status stays. */
  diskChanged() {
    this.channels = new Array(16).fill(null);
    this._listen = null;
    this._talkCh = -1;
  }

  // ── The serial primitives ──────────────────────────────────────────────────

  /** SECOND after LISTEN: $6x selects a data channel, $Fx opens, $Ex closes. */
  listen(sa) {
    const kind = sa & 0xF0, ch = sa & 0x0F;
    this._listen = { ch, kind: kind === 0xF0 ? 'open' : kind === 0xE0 ? 'close' : 'data', bytes: [] };
  }

  /** CIOUT: a byte for the listening channel. */
  write(byte) {
    if (!this._listen) return;
    if (this._listen.kind === 'data' && this._listen.ch !== CMD) {
      const c = this.channels[this._listen.ch];
      if (c && c.out) c.out.push(byte & 0xFF);
      return;
    }
    this._listen.bytes.push(byte & 0xFF);
  }

  /** UNLISTEN: what the bytes meant happens now. */
  unlisten() {
    const l = this._listen;
    this._listen = null;
    if (!l) return;
    if (l.kind === 'open') this._open(l.ch, l.bytes);
    else if (l.kind === 'close') this._close(l.ch);
    else if (l.ch === CMD && l.bytes.length) this._commands(l.bytes);
  }

  /** TKSA after TALK: the channel the next reads come from. */
  talk(sa) { this._talkCh = sa & 0x0F; }

  untalk() { this._talkCh = -1; }

  /**
   * ACPTR: the next byte of the talking channel. EOI comes with the last byte,
   * as on the bus. A channel with nothing to give times out, and the KERNAL
   * hands the program a carriage return for it.
   * @returns {{ byte: number, eoi: boolean, timeout?: boolean }}
   */
  read() {
    if (this._talkCh === CMD) {
      if (!this._reply) this._reply = { data: this._statusBytes(), pos: 0, clears: true };
      const r = this._reply;
      const byte = r.data[r.pos++];
      const eoi = r.pos >= r.data.length;
      if (eoi) { this._reply = null; if (r.clears) this._setStatus(0); }
      return { byte, eoi };
    }
    const c = this.channels[this._talkCh];
    if (!c || !c.data || c.pos >= c.data.length) return { byte: CR, eoi: true, timeout: true };
    const byte = c.data[c.pos++];
    return { byte, eoi: c.pos >= c.data.length };
  }

  // ── Opening and closing ────────────────────────────────────────────────────

  _open(ch, nameBytes) {
    if (ch === CMD) { if (nameBytes.length) this._commands(nameBytes); return; }
    this.channels[ch] = null;
    const disk = this.disk;
    if (!disk) { this._setStatus(74); return; }
    let name = pet(nameBytes);
    const replace = name.startsWith('@');
    if (replace) name = name.slice(1);
    name = name.replace(/^[0-9]?:/, '');

    if (name.startsWith('$')) {                       // the directory, as LOAD"$" lists it
      this.channels[ch] = { data: disk.buildDirectoryPRG(name.slice(1)), pos: 0 };
      this._setStatus(0);
      return;
    }
    if (name.startsWith('#')) {                       // a 256-byte buffer for block commands
      this.channels[ch] = { data: new Uint8Array(256), pos: 0, buffer: true };
      this._setStatus(0);
      return;
    }
    const [file, ...opts] = name.split(',');
    const typeLetter = opts.map(o => o.trim().toUpperCase()).find(o => o in TYPE_LETTER);
    const modeLetter = opts.map(o => o.trim().toUpperCase()).find(o => 'RWAM'.includes(o) && o.length === 1);
    const mode = ch === 0 ? 'R' : ch === 1 ? 'W' : (modeLetter || 'R');
    const entry = disk.findEntry(file);

    if (mode === 'W' || mode === 'A') {
      if (disk.writeProtected !== false) { this._setStatus(26); return; }
      if (entry && !replace && mode === 'W') { this._setStatus(63); return; }
      const typeCode = TYPE_LETTER[typeLetter] ?? (ch === 1 ? TYPE_PRG : TYPE_SEQ);
      const out = mode === 'A' && entry ? Array.from(disk.readEntry(entry) || []) : [];
      this.channels[ch] = { out, name: file, typeCode, replaces: entry ? entry.name : null };
      this._setStatus(0);
      return;
    }
    if (!entry) { this._setStatus(62); return; }
    const data = disk.readEntry(entry);
    if (!data || (typeLetter && TYPE_LETTER[typeLetter] !== entry.typeCode)) { this._setStatus(64); return; }
    this.channels[ch] = { data, pos: 0 };
    this.opens++;
    this.onOpen?.();
    this._setStatus(0);
  }

  _close(ch) {
    const c = this.channels[ch];
    this.channels[ch] = null;
    if (!c || !c.out) return;
    const disk = this.disk;
    if (!disk) { this._setStatus(74); return; }
    if (c.replaces) disk.scratch(c.replaces);
    const blocks = disk.writeFile(c.name, Uint8Array.from(c.out), c.typeCode);
    this._setStatus(blocks ? 0 : 72);
    this._changed();
  }

  // ── The command channel ────────────────────────────────────────────────────

  _commands(bytes) {
    // A memory read names an address in raw bytes, so it is picked off before
    // the text is split on carriage returns.
    if (bytes[0] === 0x4D && bytes[1] === 0x2D && bytes[2] === 0x52) {       // M-R
      const n = bytes.length > 5 ? bytes[5] : 1;
      this._setStatus(0);
      this._reply = { data: new Uint8Array(Math.max(1, n)), pos: 0, clears: false };
      return;
    }
    for (const line of pet(bytes).split('\r')) if (line.length) this._command(line);
  }

  _command(text) {
    const disk = this.disk;
    const head = text.slice(0, 3).toUpperCase();
    if (head.startsWith('M-') ) { this._setStatus(0); return; }               // M-W, M-E: nothing to write into
    const letter = text[0].toUpperCase();
    if (letter === 'I' || letter === 'V') { this._setStatus(disk ? 0 : 74); return; }
    if (letter === 'U') {
      const sub = text[1]?.toUpperCase();
      if (sub === '1' || sub === 'A' || sub === '2' || sub === 'B') return this._block(sub === '1' || sub === 'A' ? 'read' : 'write', text.slice(2));
      if (sub === 'I' || sub === 'J' || sub === ':') { this.channels = new Array(16).fill(null); this._setStatus(73); return; }
      this._setStatus(0);
      return;
    }
    if (letter === 'B') {
      const sub = text[2]?.toUpperCase();
      if (sub === 'R') return this._block('read', text.slice(3));
      if (sub === 'W') return this._block('write', text.slice(3));
      if (sub === 'P') {
        const [ch, pos] = this._numbers(text.slice(3));
        const c = this.channels[ch];
        if (!c || !c.buffer) { this._setStatus(70); return; }
        c.pos = (pos ?? 0) & 0xFF;
        this._setStatus(0);
        return;
      }
      this._setStatus(0);                                                     // B-A, B-F: nothing to keep
      return;
    }
    if (!disk) { this._setStatus(74); return; }
    const arg = text.replace(/^.[0-9]?:?/, '');
    if (letter === 'S') {
      if (disk.writeProtected !== false) { this._setStatus(26); return; }
      let n = 0;
      for (const pattern of arg.split(',')) n += disk.scratch(pattern).scratched.length;
      this._setStatus(1, n);
      this._changed();
      return;
    }
    if (letter === 'R') {
      const eq = arg.indexOf('=');
      if (eq < 0) { this._setStatus(30); return; }
      if (disk.writeProtected !== false) { this._setStatus(26); return; }
      const [to, from] = [arg.slice(0, eq), arg.slice(eq + 1)];
      if (disk.findEntry(to)) { this._setStatus(63); return; }
      this._setStatus(disk.renameFile(from, to) ? 0 : 62);
      this._changed();
      return;
    }
    if (letter === 'N') {
      if (disk.writeProtected !== false) { this._setStatus(26); return; }
      const [name, id] = arg.split(',');
      disk.format(name.slice(0, 16), id ? id.slice(0, 2) : undefined);
      this.channels = new Array(16).fill(null);
      this._setStatus(0);
      this._changed();
      return;
    }
    this._setStatus(31);
  }

  /** U1/U2 and B-R/B-W: a sector into a buffer channel, or a buffer onto a sector. */
  _block(op, args) {
    const disk = this.disk;
    if (!disk) { this._setStatus(74); return; }
    const [ch, , track, sector] = this._numbers(args);
    const c = this.channels[ch];
    if (!c || !c.buffer) { this._setStatus(70); return; }
    const sec = disk.readSector(track ?? 0, sector ?? 0);
    if (!sec) { this._setStatus(66, track ?? 0, sector ?? 0); return; }
    if (op === 'read') {
      c.data.set(sec);
      c.pos = 0;
    } else {
      if (disk.writeProtected !== false) { this._setStatus(26); return; }
      disk.writeSector(track, sector, c.data);
      this._changed();
    }
    this._setStatus(0);
  }

  _numbers(text) { return (text.match(/\d+/g) || []).map(Number); }

  // ── Status ─────────────────────────────────────────────────────────────────

  _setStatus(code, track = 0, sector = 0) {
    this._status = { code, track, sector };
    this._reply = null;
  }

  /** The status line as channel 15 sends it: "NN,MESSAGE,TT,SS" and a return. */
  statusText() {
    const { code, track, sector } = this._status;
    const message = code === 73 ? (DOS_NAME[this.disk?.kind] || DOS_NAME_DEFAULT) : (MESSAGES[code] || 'SYNTAX ERROR');
    return `${two(code)},${message},${two(track)},${two(sector)}\r`;
  }

  _statusBytes() { return Uint8Array.from(this.statusText(), c => c.charCodeAt(0) & 0xFF); }

  _changed() { this.onWrite?.(); }
}
