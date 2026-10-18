// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// WiFi modem: a user port device plugin (user port device API version 2).
//
// A Hayes-compatible modem in the style of the Zimodem firmware, wired the way
// user port WiFi modems are: RXD on PB0 and FLAG2, TXD on PA2, RTS on PB1,
// DTR on PB2, DCD on PB4, CTS on PB6. Control lines are active high at the
// pins (the Commodore convention), with Zimodem's S46/S48/S50 to invert them.
// It also has the UP9600 bridges for 9600 baud: RXD to SP2, SP1 to TXD and
// PB7 to CNT2, so CIA2's shift register receives clocked by Timer B on PB7,
// and CIA1's shift register sends.
//
// This file is a plugin like any other: one module, no imports, only the
// `port` and `host` objects. It is the reference for writing devices.

export const meta = {
  id: 'builtin.wifi-modem',
  name: 'WiFi modem',
  version: '1.1.0',
  apiVersion: 2,
  author: 'C64 READY.',
  description: 'A Hayes-compatible WiFi modem with the Zimodem command set. Dial a BBS with ATDT"host:port".',
};

const RXD = 0x01, RTS = 0x02, DTR = 0x04, DCD = 0x10, CTS = 0x40;
const DRIVEN = RXD | DCD | CTS;
const SP1 = 0x01, SP2 = 0x04, CNT2 = 0x08;
const BAUDS = [300, 600, 1200, 2400, 4800, 9600, 19200];
const PLUS_IDLE = 0;
const NOT_DUE = Number.MAX_SAFE_INTEGER;

const DEFAULTS = Object.freeze({
  baud: 1200, dataBits: 8, parity: 'N', stopBits: 1,
  echo: 1, verbose: 1, quiet: 0, extended: 1, eol: 1,
  flow: 0,          // 0 none, 1 RTS/CTS
  dtrMode: 0,       // &D: 0 ignore DTR, 2 hang up when DTR drops
  dcdMode: 1,       // &C: 0 DCD always on, 1 DCD follows the carrier
  petscii: 0,       // &P: translate command-mode text to PETSCII
  autobaud: 1,
  s: { 0: 0, 2: 43, 3: 13, 4: 10, 5: 8, 12: 50, 46: 0, 48: 0, 50: 0 },
});

const RESULT_CODES = { OK: 0, CONNECT: 1, RING: 2, 'NO CARRIER': 3, ERROR: 4, BUSY: 7, 'NO ANSWER': 8 };
const CONNECT_CODES = { 1200: 5, 2400: 10, 4800: 11, 9600: 12, 19200: 16 };

// Telnet (RFC 854/855) bytes the filter needs.
const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const OPT_ECHO = 1, OPT_SGA = 3;

function cloneSettings(src) {
  return { ...DEFAULTS, ...src, s: { ...DEFAULTS.s, ...(src && src.s) } };
}

// ASCII text to PETSCII: letters swap case ranges, everything else passes.
function asciiToPetscii(b) {
  if (b >= 0x61 && b <= 0x7a) return b - 0x20;
  if (b >= 0x41 && b <= 0x5a) return b + 0x80;
  return b;
}

function petsciiToAscii(b) {
  if (b >= 0x41 && b <= 0x5a) return b + 0x20;
  if (b >= 0xc1 && b <= 0xda) return b - 0x80;
  return b;
}

// Command letters: PETSCII shifted letters and ASCII lowercase both fold to
// ASCII uppercase, so commands work in either case on either character set.
function commandChar(b) {
  if (b >= 0xc1 && b <= 0xda) return b - 0x80;
  if (b >= 0x61 && b <= 0x7a) return b - 0x20;
  return b;
}

export function create(port, host) {
  const cps = port.cyclesPerSecond;
  const storage = host && host.storage ? host.storage : null;

  let settings = cloneSettings(storage ? storage.get('settings') : null);
  let phonebook = (storage && storage.get('phonebook')) || {};

  // ── Line state ───────────────────────────────────────────────────────────
  let baud = settings.baud;
  let bitCycles = cps / baud;
  let c64Lines = port.c64PB();

  // Bytes waiting to go to the C64, as a queue of Uint8Array chunks.
  const rxChunks = [];
  let rxChunk = null, rxPos = 0;
  const frame = new Uint8Array(13);  // levels of the frame being shifted out
  let frameLen = 0, frameBit = 0, frameStart = 0;
  let rxDue = NOT_DUE;
  let lineFreeAt = 0;                // end of the last stop bit sent
  let rxdLevel = 1;
  let cnt2Level = (c64Lines >> 7) & 1;  // the PB7 bridge
  let txLine = 1;                       // PA2 and SP1, wired together

  // Frame being received from the C64.
  let txState = 0;                   // 0 idle, 1 measuring the start bit, 2 sampling
  let txStart = 0, txBit = 0, txValue = 0, txParityBits = 0;
  let probeFrom = 0;                 // rate before an autobaud guess, 0 when none
  let txDue = NOT_DUE;

  // Wall-clock work handed to emulated time (guard times, timeouts).
  let houseDue = NOT_DUE;

  // ── Modem state ──────────────────────────────────────────────────────────
  let online = false;                // data mode (bytes go to the connection)
  let sock = null;                   // open or opening connection
  let connected = false;
  let dialing = false;
  let conn = { host: '', port: 0, telnet: false, petscii: false };
  let line = '';                     // command line after AT
  let gotA = false, inCommand = false;
  let lastCommand = '';
  let lastC64Byte = 0;               // cycle of the last byte from the C64
  let plusCount = 0, plusTime = 0;
  const held = [];                   // connection data held while in command mode
  let telnetState = 0, telnetCmd = 0;
  let pendingDrop = false;           // DCD drops once received data is delivered
  let rxActivity = 0, txActivity = 0;

  // ── Pins ─────────────────────────────────────────────────────────────────
  function active(level, sreg) {
    const mode = settings.s[sreg] | 0;
    if (mode === 2) return 1;
    if (mode === 3) return 0;
    return mode === 1 ? (level ? 0 : 1) : (level ? 1 : 0);
  }

  function drivePins() {
    const carrier = settings.dcdMode === 0 || connected;
    let levels = rxdLevel ? RXD : 0;
    if (active(carrier ? 1 : 0, 46)) levels |= DCD;
    if (active(1, 48)) levels |= CTS;
    port.drivePB(DRIVEN, levels);
    port.driveSerial(SP2 | CNT2, (rxdLevel ? SP2 : 0) | (cnt2Level ? CNT2 : 0));
  }

  function txLevel() {
    return port.c64PA2() & port.c64Serial() & SP1;
  }

  function rtsAsserted() {
    const level = (c64Lines & RTS) ? 1 : 0;
    const mode = settings.s[50] | 0;
    if (mode === 2 || mode === 3) return true;
    return mode === 1 ? level === 0 : level === 1;
  }

  function setRxd(level) {
    if (level === rxdLevel) return;
    rxdLevel = level;
    drivePins();
    port.setFlag(level);
  }

  function schedule() {
    const due = Math.min(rxDue, txDue, houseDue);
    if (due === NOT_DUE) port.cancelWake();
    else port.wakeAt(due);
  }

  // ── To the C64 ───────────────────────────────────────────────────────────
  function queueBytes(bytes) {
    if (!bytes.length) return;
    rxChunks.push(bytes);
    if (rxDue === NOT_DUE && frameLen === 0) {
      rxDue = Math.max(port.now() + 1, lineFreeAt);
      schedule();
    }
  }

  function queueText(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const b = text.charCodeAt(i) & 0xff;
      out[i] = settings.petscii ? asciiToPetscii(b) : b;
    }
    queueBytes(out);
  }

  function eol() {
    const cr = String.fromCharCode(settings.s[3]), lf = String.fromCharCode(settings.s[4]);
    return [cr, cr + lf, lf + cr, lf][settings.eol] ?? cr + lf;
  }

  function result(word) {
    if (settings.quiet) return;
    if (!settings.verbose) {
      const code = word.startsWith('CONNECT')
        ? (settings.extended ? CONNECT_CODES[baud] ?? 1 : 1)
        : RESULT_CODES[word] ?? 4;
      queueText(`${code}${String.fromCharCode(settings.s[3])}`);
      return;
    }
    queueText(`${eol()}${word}${eol()}`);
  }

  function takeRxByte() {
    while (rxChunk === null || rxPos >= rxChunk.length) {
      if (!rxChunks.length) { rxChunk = null; return -1; }
      rxChunk = rxChunks.shift();
      rxPos = 0;
    }
    return rxChunk[rxPos++];
  }

  function rxPending() {
    return (rxChunk !== null && rxPos < rxChunk.length) || rxChunks.length > 0;
  }

  function loadFrame(byte) {
    let n = 0, ones = 0;
    frame[n++] = 0;
    for (let i = 0; i < settings.dataBits; i++) {
      const bit = (byte >> i) & 1;
      ones += bit;
      frame[n++] = bit;
    }
    const parity = settings.parity;
    if (parity === 'E') frame[n++] = ones & 1;
    else if (parity === 'O') frame[n++] = (ones & 1) ^ 1;
    else if (parity === 'M') frame[n++] = 1;
    else if (parity === 'S') frame[n++] = 0;
    for (let i = 0; i < settings.stopBits; i++) frame[n++] = 1;
    frameLen = n;
  }

  function rxEvent(now) {
    if (frameLen === 0) {
      if (settings.flow === 1 && !rtsAsserted()) { rxDue = now + Math.ceil(bitCycles); return; }
      const b = takeRxByte();
      if (b < 0) { rxDue = NOT_DUE; return; }
      loadFrame(b);
      rxActivity = 2;
      frameBit = 0;
      frameStart = now;
    }
    setRxd(frame[frameBit]);
    frameBit++;
    if (frameBit >= frameLen) {
      frameLen = 0;
      rxDue = lineFreeAt = frameStart + Math.round(frameBit * bitCycles);
      if (!rxPending()) {
        rxDue = NOT_DUE;
        afterDrain();
      }
      return;
    }
    rxDue = frameStart + Math.round(frameBit * bitCycles);
  }

  // ── From the C64 ─────────────────────────────────────────────────────────
  function frameBits() {
    return settings.dataBits + (settings.parity === 'N' ? 0 : 1);
  }

  function autobaudArmed() {
    return settings.autobaud && !online && !dialing && !gotA;
  }

  function onTxLine() {
    const level = txLevel();
    if (level === txLine) return;
    txLine = level;
    if (txState === 0) {
      if (level !== 0) return;
      txStart = port.now();
      txValue = 0; txBit = 0; txParityBits = 0;
      if (autobaudArmed()) {
        txState = 1;
      } else {
        txState = 2;
        txDue = txStart + Math.round(bitCycles / 2);
        schedule();
      }
      return;
    }
    if (txState === 1 && level === 1) {
      // The start bit of "A" is one bit wide: bit 0 of A is a 1 in ASCII and in
      // PETSCII, so its end marks the bit time.
      const width = port.now() - txStart;
      const measured = cps / Math.max(1, width);
      let best = 0, bestErr = 1;
      for (const b of BAUDS) {
        const err = Math.abs(measured - b) / b;
        if (err < bestErr) { bestErr = err; best = b; }
      }
      if (bestErr > 0.25) { txState = 0; return; }
      probeFrom = baud;
      setBaud(best);
      txState = 2;
      txBit = 1;
      txDue = txStart + Math.round(bitCycles * 1.5);
      schedule();
    }
  }

  function txEvent() {
    const level = txLevel();
    const dataBits = frameBits();
    if (txBit === 0) {
      if (level !== 0) { txState = 0; txDue = NOT_DUE; return; }   // glitch, not a start bit
    } else if (txBit <= dataBits) {
      if (txBit <= settings.dataBits) txValue |= level << (txBit - 1);
      else txParityBits = level;
    } else {
      txState = 0;
      txDue = NOT_DUE;
      if (probeFrom) {
        // The guessed rate holds only if the character really was an A.
        const wasA = level === 1 && commandChar(txValue) === 0x41;
        if (!wasA) { setBaud(probeFrom); probeFrom = 0; return; }
        probeFrom = 0;
      }
      if (level === 1) fromC64(txValue);     // a low stop bit is a framing error
      return;
    }
    txBit++;
    txDue = txStart + Math.round((txBit + 0.5) * bitCycles);
  }

  function setBaud(b) {
    baud = b;
    bitCycles = cps / b;
  }

  function fromC64(byte) {
    txActivity = 2;
    const now = port.now();
    if (online) {
      const escapeChar = settings.s[2];
      const guard = guardCycles();
      const opens = plusCount === PLUS_IDLE && now - lastC64Byte >= guard;
      const continues = plusCount > 0 && plusCount < 3 && now - plusTime < guard;
      if (escapeChar <= 127 && byte === escapeChar && (opens || continues)) {
        plusCount++;
        plusTime = now;
        if (plusCount === 3) { houseDue = now + guard; schedule(); }
      } else {
        plusCount = PLUS_IDLE;
      }
      lastC64Byte = now;
      sendToConnection(byte);
      return;
    }
    lastC64Byte = now;
    if (dialing) {
      // Any key while dialing aborts the call.
      abortDial();
      return;
    }
    commandByte(byte);
  }

  function guardCycles() {
    return Math.round((settings.s[12] / 50) * cps);
  }

  function houseEvent(now) {
    houseDue = NOT_DUE;
    if (online && plusCount === 3 && now - lastC64Byte >= guardCycles()) {
      plusCount = PLUS_IDLE;
      online = false;
      result('OK');
    }
  }

  // ── Command mode ─────────────────────────────────────────────────────────
  function echo(byte) {
    if (settings.echo) queueBytes(Uint8Array.of(byte));
  }

  function commandByte(byte) {
    const c = commandChar(byte);
    if (!gotA) {
      if (c === 0x41) { gotA = true; echo(byte); }
      return;
    }
    if (!inCommand) {
      if (c === 0x54) { inCommand = true; line = ''; echo(byte); return; }
      if (c === 0x2f) { echo(byte); gotA = false; queueText(eol()); execute(lastCommand); return; }
      gotA = c === 0x41;
      if (gotA) echo(byte);
      return;
    }
    if (byte === settings.s[3]) {
      echo(byte);
      gotA = false; inCommand = false;
      lastCommand = line;
      execute(line);
      return;
    }
    if (byte === settings.s[5] || byte === 0x14 || byte === 0x7f) {
      if (line.length) { line = line.slice(0, -1); echo(byte); }
      return;
    }
    if (line.length < 255) {
      line += String.fromCharCode(byte >= 0xc1 && byte <= 0xda ? byte - 0x80 : byte);
      echo(byte);
    }
  }

  function execute(text) {
    let i = 0;
    const s = text;
    const up = (k) => String.fromCharCode(commandChar(s.charCodeAt(k)));
    const num = () => {
      let start = i;
      while (i < s.length && s[i] >= '0' && s[i] <= '9') i++;
      return start === i ? 0 : parseInt(s.slice(start, i), 10);
    };
    const quoted = () => {
      if (s[i] !== '"') return null;
      const end = s.indexOf('"', i + 1);
      const v = s.slice(i + 1, end < 0 ? s.length : end);
      i = end < 0 ? s.length : end + 1;
      return v;
    };
    const out = [];
    while (i < s.length) {
      const ch = up(i++);
      switch (ch) {
        case ' ': break;
        case 'A': result('NO CARRIER'); return;
        case 'B': {
          const q = quoted();
          if (q !== null) { if (!setFormat(q)) { result('ERROR'); return; } }
          else {
            const b = num();
            if (!BAUDS.includes(b)) { result('ERROR'); return; }
            setBaud(b); settings.baud = b;
          }
          break;
        }
        case 'D': dial(s.slice(i)); return;
        case 'E': settings.echo = num() ? 1 : 0; break;
        case 'F': settings.flow = num() === 0 ? 1 : 0; break;
        case 'H': num(); hangup(); break;
        case 'I': out.push(...info(num())); break;
        case 'O':
          num();
          if (!connected) { result('NO CARRIER'); return; }
          online = true; plusCount = PLUS_IDLE;
          result(`CONNECT ${baud}`);
          releaseHeld();
          return;
        case 'P': {
          const r = phonebookCommand(s.slice(i));
          if (r === null) { result('ERROR'); return; }
          out.push(...r);
          i = s.length;
          break;
        }
        case 'Q': settings.quiet = num() ? 1 : 0; break;
        case 'R': settings.eol = Math.min(3, num()); break;
        case 'S': {
          const n = num();
          if (s[i] === '=') { i++; settings.s[n] = num() & 0xff; drivePins(); }
          else if (s[i] === '?') { i++; out.push(String(settings.s[n] ?? 0).padStart(3, '0')); }
          break;
        }
        case 'V': settings.verbose = num() ? 1 : 0; break;
        case 'X': settings.extended = num() ? 1 : 0; break;
        case 'Z':
          num();
          hangup();
          settings = cloneSettings(storage ? storage.get('settings') : null);
          setBaud(settings.baud);
          drivePins();
          break;
        case 'C': case 'L': case 'M': case 'N': case 'T': case 'U': case 'W': case 'Y':
          if (quoted() === null) num();
          break;
        case '&': {
          const sub = up(i++);
          const n = num();
          if (sub === 'F') { settings = cloneSettings(null); setBaud(settings.baud); drivePins(); }
          else if (sub === 'W') { if (storage) storage.set('settings', settings); }
          else if (sub === 'K') settings.flow = n === 3 || n === 6 ? 1 : 0;
          else if (sub === 'D') settings.dtrMode = n;
          else if (sub === 'C') { settings.dcdMode = n ? 1 : 0; drivePins(); }
          else if (sub === 'P') settings.petscii = n ? 1 : 0;
          else if (sub === 'V') out.push(...settingsText());
          else if (sub === 'G') { result('ERROR'); return; }
          break;
        }
        case '+':
          if (s.slice(i).toUpperCase().startsWith('CONFIG')) {
            out.push('NETWORK IS PROVIDED BY THE BROWSER. NOTHING TO CONFIGURE.');
            i = s.length;
            break;
          }
          result('ERROR');
          return;
        case '$': i = s.length; break;
        default: result('ERROR'); return;
      }
    }
    for (const lineOut of out) queueText(`${eol()}${lineOut}`);
    if (out.length) queueText(eol());
    result('OK');
  }

  function setFormat(q) {
    const m = /^\s*(\d+)\s*(?:,\s*([5-8])\s*([NEOMS])\s*([12]))?\s*$/i.exec(q);
    if (!m) return false;
    const b = parseInt(m[1], 10);
    if (!BAUDS.includes(b)) return false;
    setBaud(b);
    settings.baud = b;
    if (m[2]) {
      settings.dataBits = parseInt(m[2], 10);
      settings.parity = m[3].toUpperCase();
      settings.stopBits = parseInt(m[4], 10);
    }
    return true;
  }

  function info(n) {
    if (n === 1 || n === 5) return settingsText();
    return [`C64 READY. WIFI MODEM ${meta.version}`, 'ZIMODEM COMMAND SET, DIAL ATDT"HOST:PORT"'];
  }

  function settingsText() {
    const sregs = Object.keys(settings.s).map((k) => `S${k}=${settings.s[k]}`).join(' ');
    return [
      `B${baud} ${settings.dataBits}${settings.parity}${settings.stopBits} E${settings.echo} V${settings.verbose} Q${settings.quiet} X${settings.extended} R${settings.eol}`,
      `&K${settings.flow ? 3 : 0} &D${settings.dtrMode} &C${settings.dcdMode} &P${settings.petscii}`,
      sregs,
    ];
  }

  function phonebookCommand(rest) {
    const m = /^([PTEX]*)"([^"]*)"?\s*$/i.exec(rest.trim());
    if (!rest.trim()) {
      return Object.keys(phonebook).sort().map((num) => {
        const e = phonebook[num];
        return `${num} ${e.mods || ''} ${e.host}:${e.port}${e.notes ? ' ' + e.notes : ''}`.replace(/\s+/g, ' ');
      });
    }
    if (!m) return null;
    const [num, target] = m[2].split('=');
    if (!/^\d{1,16}$/.test(num || '') || target === undefined) return null;
    if (target.trim().toUpperCase() === 'DELETE') delete phonebook[num];
    else {
      const [hostPort, ...notes] = target.split(',');
      const hp = parseHostPort(hostPort);
      if (!hp) return null;
      phonebook[num] = { host: hp.host, port: hp.port, mods: m[1].toUpperCase(), notes: notes.join(',').trim() };
    }
    if (storage) storage.set('phonebook', phonebook);
    return [];
  }

  function parseHostPort(text) {
    const t = text.trim().toLowerCase();
    const m = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(t);
    if (!m) return null;
    const p = m[2] ? parseInt(m[2], 10) : 23;
    if (p < 1 || p > 65535) return null;
    return { host: m[1], port: p };
  }

  // ── Dialing and the connection ───────────────────────────────────────────
  function dial(rest) {
    let mods = '', target = rest.trim();
    const q = target.indexOf('"');
    if (q >= 0) {
      mods = target.slice(0, q).toUpperCase().replace(/[^PTEX]/g, '');
      target = target.slice(q + 1).replace(/".*$/, '');
    } else {
      const first = target[0] ? target[0].toUpperCase() : '';
      if (first === 'T' || first === 'P') {
        mods = first === 'T' ? 'T' : '';
        target = target.slice(1);
      }
    }
    target = target.trim();
    let hp;
    if (/^[\d\s()-]+$/.test(target)) {
      const entry = phonebook[target.replace(/\D/g, '')];
      if (!entry) { result('NO ANSWER'); return; }
      hp = { host: entry.host, port: entry.port };
      mods = entry.mods || mods;
    } else {
      hp = parseHostPort(target);
    }
    if (!hp) { result('ERROR'); return; }
    if (!host || !host.openSocket) { result('NO CARRIER'); return; }
    hangup();
    conn = { host: hp.host, port: hp.port, telnet: mods.includes('T'), petscii: mods.includes('P') };
    telnetState = 0;
    dialing = true;
    const s = host.openSocket(hp.host, hp.port);
    sock = s;
    s.onopen = () => {
      if (sock !== s) return;
      dialing = false;
      connected = true;
      online = true;
      plusCount = PLUS_IDLE;
      drivePins();
      result(`CONNECT ${baud}`);
    };
    s.ondata = (bytes) => {
      if (sock !== s) return;
      const data = filterIncoming(bytes);
      if (!data.length) return;
      if (online) queueBytes(data);
      else held.push(data);
    };
    s.onclose = () => {
      if (sock !== s) return;
      const wasDialing = dialing;
      sock = null;
      dialing = false;
      if (wasDialing) { result('NO ANSWER'); return; }
      lostCarrier();
    };
  }

  function abortDial() {
    const s = sock;
    sock = null;
    dialing = false;
    if (s) s.close();
    result('NO CARRIER');
  }

  function lostCarrier() {
    connected = false;
    held.length = 0;
    // DCD drops once the data already received has reached the C64.
    if (!rxPending() && frameLen === 0) dropCarrier();
    else pendingDrop = true;
  }

  function afterDrain() {
    if (pendingDrop) { pendingDrop = false; dropCarrier(); }
  }

  function dropCarrier() {
    online = false;
    gotA = false; inCommand = false;
    drivePins();
    result('NO CARRIER');
  }

  function hangup() {
    const s = sock;
    sock = null;
    dialing = false;
    held.length = 0;
    if (s) s.close();
    if (connected) { connected = false; online = false; drivePins(); }
    online = false;
  }

  function releaseHeld() {
    while (held.length) queueBytes(held.shift());
  }

  function sendToConnection(byte) {
    if (!sock || !connected) return;
    let b = conn.petscii ? petsciiToAscii(byte) : byte;
    // Telnet doubles a data IAC, and a CR not followed by LF goes as CR NUL.
    if (conn.telnet && b === IAC) sock.send(Uint8Array.of(IAC, IAC));
    else if (conn.telnet && b === 13) sock.send(Uint8Array.of(13, 0));
    else sock.send(Uint8Array.of(b));
  }

  // Telnet: answer option negotiation (refuse everything but the server's
  // ECHO and SUPPRESS-GO-AHEAD), drop subnegotiation, unescape IAC IAC.
  function filterIncoming(bytes) {
    if (!conn.telnet && !conn.petscii) return bytes;
    const out = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (conn.telnet) {
        if (telnetState === 0) {
          if (b === IAC) { telnetState = 1; continue; }
        } else if (telnetState === 1) {
          if (b === IAC) { telnetState = 0; out.push(conn.petscii ? asciiToPetscii(b) : b); continue; }
          if (b === DO || b === DONT || b === WILL || b === WONT) { telnetCmd = b; telnetState = 2; continue; }
          telnetState = b === SB ? 3 : 0;
          continue;
        } else if (telnetState === 2) {
          telnetState = 0;
          if (sock) {
            if (telnetCmd === DO) sock.send(Uint8Array.of(IAC, WONT, b));
            else if (telnetCmd === WILL) sock.send(Uint8Array.of(IAC, b === OPT_ECHO || b === OPT_SGA ? DO : DONT, b));
          }
          continue;
        } else if (telnetState === 3) {
          if (b === IAC) telnetState = 4;
          continue;
        } else if (telnetState === 4) {
          telnetState = b === SE ? 0 : 3;
          continue;
        }
      }
      out.push(conn.petscii ? asciiToPetscii(b) : b);
    }
    return Uint8Array.from(out);
  }

  // ── Device callbacks ─────────────────────────────────────────────────────
  function onTimer(now) {
    if (now >= rxDue) rxEvent(now);
    if (now >= txDue) txEvent(now);
    if (now >= houseDue) houseEvent(now);
    schedule();
  }

  function onPortB(levels) {
    const was = c64Lines;
    c64Lines = levels;
    const pb7 = (levels >> 7) & 1;
    if (pb7 !== cnt2Level) {
      cnt2Level = pb7;
      drivePins();
    }
    if (settings.dtrMode === 2 && (was & DTR) && !(levels & DTR) && (connected || dialing)) {
      hangup();
      result('NO CARRIER');
    }
    if (settings.flow === 1 && !(was & RTS) && (levels & RTS) && rxDue === NOT_DUE && rxPending()) {
      rxDue = port.now() + 1;
      schedule();
    }
  }

  // ── Panel ────────────────────────────────────────────────────────────────
  let view = null;
  if (host && host.panel && typeof document !== 'undefined') {
    const root = host.panel;
    root.adoptedStyleSheets = [host.css(`
      :host { display: block; }
      .row { display: flex; align-items: center; gap: 10px; font-size: 0.85em; }
      .led { display: inline-flex; align-items: center; gap: 4px; opacity: 0.85; }
      .led::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: #3a2020; }
      .led.on::before { background: #ff5040; box-shadow: 0 0 6px #ff5040; }
      .led.dcd.on::before { background: #40d060; box-shadow: 0 0 6px #40d060; }
    `)];
    const row = document.createElement('div');
    row.className = 'row';
    const mk = (cls, label) => {
      const e = document.createElement('span');
      e.className = `led ${cls}`;
      e.textContent = label;
      row.append(e);
      return e;
    };
    view = { dcd: mk('dcd', 'CD'), rx: mk('rx', 'RX'), tx: mk('tx', 'TX') };
    root.append(row);
  }
  let lastWhat = '';
  if (host && host.onFrame) {
    host.onFrame(() => {
      if (rxActivity) rxActivity--;
      if (txActivity) txActivity--;
      let what;
      if (dialing) what = `Dialing ${conn.host}:${conn.port}…`;
      else if (connected) what = `${online ? 'Connected to' : 'Command mode, holding'} ${conn.host}:${conn.port} at ${baud} baud`;
      else what = `Ready, ${baud} baud. Dial with ATDT"host:port"`;
      if (view) {
        view.dcd.classList.toggle('on', connected);
        view.rx.classList.toggle('on', rxActivity > 0);
        view.tx.classList.toggle('on', txActivity > 0);
      }
      if (what !== lastWhat && host.status) host.status(what);
      lastWhat = what;
    });
  }

  drivePins();

  return {
    onPA2: onTxLine,
    onSerial: onTxLine,
    onPortB,
    onTimer,
    // The modem has its own power: a C64 /RESET leaves the call up. (The app's
    // RESET and POWER buttons build a new machine and plug in a new modem.)
    reset() {},
    detach() {
      if (sock) { const s = sock; sock = null; s.close(); }
    },
    serialize() {
      return { settings, baud, connected, online };
    },
    deserialize(state) {
      // A live connection does not survive a snapshot: the modem comes back
      // in command mode and says the line dropped.
      settings = cloneSettings(state.settings);
      setBaud(state.baud || settings.baud);
      rxChunks.length = 0; rxChunk = null; frameLen = 0; rxDue = NOT_DUE;
      txState = 0; txDue = NOT_DUE; houseDue = NOT_DUE; probeFrom = 0;
      rxdLevel = 1;
      txLine = txLevel();
      held.length = 0; pendingDrop = false; plusCount = PLUS_IDLE;
      telnetState = 0; line = '';
      c64Lines = port.c64PB();
      cnt2Level = (c64Lines >> 7) & 1;
      lastC64Byte = port.now();
      if (sock) { const s = sock; sock = null; s.close(); }
      dialing = false;
      const wasConnected = state.connected;
      connected = false; online = false; gotA = false; inCommand = false;
      drivePins();
      port.setFlag(1);
      if (wasConnected) result('NO CARRIER');
      schedule();
    },
    // Not part of the device API: lets tests and the panel read the state.
    get state() {
      return { baud, online, connected, dialing, host: conn.host, port: conn.port };
    },
  };
}
