// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Modem: a user port device plugin (user port device API version 2).
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
  name: 'Hayes Modem',
  version: '1.1.0',
  apiVersion: 2,
  author: 'C64 READY.',
  description: 'Hayes-compatible TCP/Telnet modem.',
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
  let speakerEnabled = storage ? storage.get('speaker') === true : false;
  let pendingSound = '';
  let activeSound = null;
  let connectionSound = null, connectionContext = null;

  // Sound is decorative and scheduled between emulated frames. Port callbacks
  // only select the next effect, so audio never delays a connection or byte.
  function stopSound() {
    const active = activeSound;
    activeSound = null;
    if (!active) return;
    for (const voice of active.voices) {
      voice.source.onended = null;
      try { voice.source.stop(); } catch { /* already ended */ }
      voice.source.disconnect();
      voice.gain.disconnect();
    }
    active.filter.disconnect();
    active.bus.disconnect();
  }

  function playSound(kind) {
    stopSound();
    if (kind === 'stop' || !speakerEnabled || !host || !host.audio) return;
    const audio = host.audio();
    if (!audio || audio.context.state !== 'running') return;
    const ctx = audio.context, now = ctx.currentTime;
    const bus = ctx.createGain();
    bus.gain.value = 0.08;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass'; filter.frequency.value = 1500; filter.Q.value = 0.5;
    filter.connect(bus).connect(audio.destination);
    const active = { bus, filter, voices: [], remaining: 0 };
    activeSound = active;
    function attach(source, duration) {
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      source.connect(gain).connect(filter);
      const v = { source, gain }; active.voices.push(v); active.remaining++;
      source.onended = () => {
        source.disconnect(); gain.disconnect();
        if (--active.remaining === 0) {
          filter.disconnect(); bus.disconnect();
          if (activeSound === active) activeSound = null;
        }
      };
      source.start(now); source.stop(now + duration);
      return v;
    }
    function voice(frequency, duration) {
      const source = ctx.createOscillator();
      source.type = 'sine'; source.frequency.value = frequency;
      return attach(source, duration);
    }
    function pulse(v, start, duration, volume = 0.6) {
      const g = v.gain.gain;
      g.setValueAtTime(0, now + start);
      g.linearRampToValueAtTime(volume, now + start + 0.008);
      g.setValueAtTime(volume, now + start + duration - 0.008);
      g.linearRampToValueAtTime(0, now + start + duration);
    }
    if (kind === 'dial' || kind === 'failure') {
      // North American ringing: 440 + 480 Hz, 2 s on / 4 s off.
      // A network failure uses reorder: 480 + 620 Hz, 0.25 s on / 0.25 s off.
      const ringing = kind === 'dial', length = ringing ? 18 : 1.5;
      const first = voice(ringing ? 440 : 480, length);
      const second = voice(ringing ? 480 : 620, length);
      const step = ringing ? 6 : 0.5, duration = ringing ? 2 : 0.25;
      for (let t = 0; t + duration <= length; t += step) {
        pulse(first, t, duration); pulse(second, t, duration);
      }
    } else if (kind === 'connect') {
      if (connectionContext !== ctx) {
        // Shortened 1670-inspired monitoring, not a simulated line negotiation.
        // The manual gives a 2225 Hz answer tone and Bell 212A's 1200/2400 Hz
        // carriers. The serial baud rate does not select an analogue line rate.
        const answer = 0.7, training = 0.775, duration = training + 1.2;
        connectionSound = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate);
        connectionContext = ctx;
        const samples = connectionSound.getChannelData(0);
        let symbol = -1, lowPhase = 0, highPhase = 0, seed = 0x1ffff;
        const nextPhase = () => {
          let pair = 0;
          for (let bit = 0; bit < 2; bit++) {
            const next = ((seed >> 16) ^ (seed >> 13)) & 1;
            seed = ((seed << 1) | next) & 0x1ffff; pair = (pair << 1) | next;
          }
          return pair * Math.PI / 2;
        };
        for (let i = 0; i < samples.length; i++) {
          const t = i / ctx.sampleRate;
          if (t < answer) {
            const fade = Math.min(1, t / 0.008, (answer - t) / 0.008);
            samples[i] = Math.sin(2 * Math.PI * 2225 * t) * 0.7 * fade;
          } else if (t >= training) {
            const time = t - training, next = Math.floor(time * 600);
            if (next !== symbol) { symbol = next; lowPhase += nextPhase(); highPhase += nextPhase(); }
            const fade = Math.min(1, time / 0.008, (duration - t) / 0.008);
            samples[i] = (Math.sin(2 * Math.PI * 1200 * time + lowPhase)
              + Math.sin(2 * Math.PI * 2400 * time + highPhase)) * 0.3 * fade;
          }
        }
      }
      const source = ctx.createBufferSource(); source.buffer = connectionSound;
      pulse(attach(source, connectionSound.duration), 0, connectionSound.duration, 1);
    }
  }

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
    return [`C64 READY. MODEM ${meta.version}`, 'ZIMODEM COMMAND SET, DIAL ATDT"HOST:PORT"'];
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
    pendingSound = 'dial';
    const s = host.openSocket(hp.host, hp.port);
    sock = s;
    s.onopen = () => {
      if (sock !== s) return;
      dialing = false;
      connected = true;
      online = true;
      pendingSound = 'connect';
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
      if (wasDialing) { pendingSound = 'failure'; result('NO ANSWER'); return; }
      lostCarrier();
    };
  }

  function abortDial() {
    pendingSound = 'stop';
    const s = sock;
    sock = null;
    dialing = false;
    if (s) s.close();
    result('NO CARRIER');
  }

  function lostCarrier() {
    pendingSound = 'stop';
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
    pendingSound = 'stop';
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
      .speaker { margin-left: auto; padding: 2px; min-width: 28px; min-height: 28px; display: inline-flex; align-items: center; justify-content: center; background: none; border: 1px solid transparent; border-radius: 5px; cursor: pointer; color: var(--accent); }
      .speaker:hover { border-color: var(--border); }
      .speaker:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .speaker .spk { display: block; width: 18px; height: auto; }
      .speaker .spk-mute, .speaker.is-silent .spk-on { display: none; }
      .speaker.is-silent .spk-mute { display: block; }
      .speaker.is-silent { color: var(--dim); }
      .relay { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
      .relay input { flex: 1; min-width: 0; padding: 4px 6px; font: inherit; color: var(--text);
        background: var(--control-bg); border: 1px solid var(--border); border-radius: 4px; }
      .relay-note { margin-top: 4px; overflow-wrap: anywhere; color: var(--dim); }
      .relay-note:empty { display: none; } .relay-note.error { color: var(--accent); }
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
    const speaker = document.createElement('button');
    speaker.type = 'button';
    speaker.className = 'speaker';
    speaker.setAttribute('aria-label', 'Modem speaker');
    speaker.innerHTML = host.icons ? host.icons.speakerOn + host.icons.speakerMute : 'SOUND';
    function syncSpeaker() {
      speaker.classList.toggle('is-silent', !speakerEnabled);
      speaker.setAttribute('aria-pressed', String(speakerEnabled));
      speaker.title = speakerEnabled ? 'Turn modem speaker off' : 'Turn modem speaker on';
    }
    syncSpeaker();
    speaker.addEventListener('click', () => {
      speakerEnabled = !speakerEnabled;
      if (storage) storage.set('speaker', speakerEnabled);
      if (!speakerEnabled) { pendingSound = ''; stopSound(); }
      else if (dialing || connected) pendingSound = dialing ? 'dial' : 'connect';
      syncSpeaker();
    });
    row.append(speaker);
    root.append(row);
    if (host.relay) {
      const label = document.createElement('label'); label.className = 'relay'; label.textContent = 'Relay';
      const input = document.createElement('input'); input.type = 'text'; input.id = 'userport-relay';
      input.spellcheck = false; input.autocomplete = 'off'; input.value = host.relay.get();
      input.placeholder = host.relay.defaultBase() || 'none: run c64rdy serve, or enter a relay';
      input.title = 'Relay for modem calls. Empty uses the local app relay.';
      const note = document.createElement('div'); note.id = 'userport-relay-note'; note.className = 'relay-note';
      note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
      const valid = value => {
        if (!value) return true;
        try { return /^wss?:$/.test(new URL(value).protocol); } catch { return false; }
      };
      input.addEventListener('input', () => {
        const value = input.value.trim();
        note.classList.remove('error'); note.textContent = '';
        if (!valid(value) || value === host.relay.get()) return;
        const saved = host.relay.set(value);
        const via = value || host.relay.defaultBase();
        note.textContent = saved ? via ? `Saved. New calls go through ${via}.` : 'Saved. No relay now: run c64rdy serve, or enter one.'
          : 'Using for this session. The browser could not save the relay address.';
      });
      input.addEventListener('change', () => {
        if (valid(input.value.trim())) return;
        note.classList.add('error'); note.textContent = 'Not saved: a relay address starts with ws:// or wss://.';
      });
      label.append(input); root.append(label, note);
    }
  }
  let lastWhat = '';
  if (host && host.onFrame) {
    host.onFrame(() => {
      if (pendingSound) { const sound = pendingSound; pendingSound = ''; playSound(sound); }
      if (rxActivity) rxActivity--;
      if (txActivity) txActivity--;
      let what;
      if (dialing) what = `Dialing ${conn.host}:${conn.port}…`;
      else if (connected) what = `${online ? 'Connected to' : 'Command mode, holding'} ${conn.host}:${conn.port} at serial ${baud} baud`;
      else what = `Ready, serial ${baud} baud. Dial with ATDT"host:port"`;
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
      pendingSound = ''; stopSound();
      if (sock) { const s = sock; sock = null; s.close(); }
    },
    serialize() {
      return { settings, baud, connected, online };
    },
    deserialize(state) {
      pendingSound = ''; stopSound();
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
