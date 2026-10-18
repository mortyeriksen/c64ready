// The built-in WiFi modem (src/userport/devices/wifi-modem.js), driven through
// a stand-in port that plays the C64's side of the serial line. Expected values
// come from the references the modem follows: asynchronous serial framing
// (start bit low, data LSB first, stop bit high), the Hayes command set (echo,
// verbose and numeric results, S2/S12 escape with guard time, &C/&D), the
// Zimodem command set (ATD"host:port", T/P modifiers, ATP phonebook, S46),
// and Telnet (RFC 854: IAC doubling, CR NUL, refusing options it does not
// support; RFC 855: subnegotiation framing; RFC 857/858: ECHO = 1,
// SUPPRESS-GO-AHEAD = 3).

import fs from 'node:fs';
import { create, meta } from '../../src/userport/devices/wifi-modem.js';

let testNo = 0, failing = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (!current.length) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    failing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of current) console.log(`     - ${m}`);
    current = [];
  }
}

const CPS = 985248;
const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const RTS = 0x02, DTR = 0x04, DCD = 0x10;
const show = (s) => JSON.stringify(s);

function memStore() {
  const m = new Map();
  return { get: (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), set: (k, v) => m.set(k, JSON.stringify(v)) };
}

function harness({ storage = memStore(), noNet = false } = {}) {
  let clock = 0, wake = Infinity;
  let pb = 0xFF, devPB = 0xFF, pa2 = 1;
  const rxEdges = [];
  const flagEdges = [];
  const sockets = [];
  const port = {
    apiVersion: 1, cyclesPerSecond: CPS,
    now: () => clock,
    drivePB(mask, levels) {
      const nv = (~mask | levels) & 0xFF;
      if ((nv & 1) !== (devPB & 1)) rxEdges.push([clock, nv & 1]);
      devPB = nv;
    },
    setFlag(l) { flagEdges.push([clock, l]); },
    wakeAt(c) { wake = c > clock ? Math.floor(c) : clock + 1; },
    cancelWake() { wake = Infinity; },
    c64PB: () => pb,
    c64PA2: () => pa2,
  };
  const host = {
    storage,
    openSocket: noNet ? undefined : (h, p) => {
      const s = { host: h, port: p, sent: [], closed: false, onopen: null, ondata: null, onclose: null,
        send(b) { this.sent.push(...b); }, close() { this.closed = true; } };
      sockets.push(s);
      return s;
    },
  };
  const dev = create(port, host);
  const advanceTo = (t) => {
    while (wake <= t) { clock = wake; wake = Infinity; dev.onTimer(clock); }
    clock = t;
  };
  let decodedTo = 0;
  return {
    dev, sockets, rxEdges, flagEdges,
    get devPB() { return devPB; },
    setPB(v) { pb = v; dev.onPortB(v); },
    idle(seconds) { advanceTo(clock + Math.round(seconds * CPS)); },
    // One 8N1 frame from the C64 on PA2, at `baud`.
    sendByte(byte, baud = 1200) {
      const bit = CPS / baud, start = clock;
      const levels = [0];
      for (let i = 0; i < 8; i++) levels.push((byte >> i) & 1);
      levels.push(1);
      for (let k = 0; k < levels.length; k++) {
        advanceTo(Math.round(start + k * bit));
        if (levels[k] !== pa2) { pa2 = levels[k]; dev.onPA2(pa2); }
      }
      advanceTo(Math.round(start + 10 * bit) + 1);
    },
    send(text, baud = 1200) {
      for (const ch of text) this.sendByte(typeof ch === 'number' ? ch : ch.charCodeAt(0), baud);
    },
    // Decode what the modem put on RXD since the last call, as a UART would:
    // a falling edge starts a frame, bits are sampled mid-cell.
    received(baud = 1200, settle = 0.05) {
      // Run until the modem has nothing left to send (it schedules a timer per
      // bit), then a little longer for the last stop bit.
      const limit = clock + 30 * CPS;
      while (wake !== Infinity && wake <= limit) advanceTo(wake);
      this.idle(settle);
      const bit = CPS / baud;
      const levelAt = (t) => {
        let l = 1;
        for (const [c, v] of rxEdges) { if (c > t) break; l = v; }
        return l;
      };
      let out = '';
      let frameEnd = decodedTo;
      for (const [c, v] of rxEdges) {
        if (c < frameEnd || v !== 0) continue;
        if (levelAt(c + bit * 0.5) !== 0) continue;
        let byte = 0;
        for (let i = 0; i < 8; i++) byte |= levelAt(c + bit * (1.5 + i)) << i;
        if (levelAt(c + bit * 9.5) !== 1) out += '<framing>';
        out += String.fromCharCode(byte);
        frameEnd = c + bit * 9.5;
      }
      decodedTo = clock;
      return out;
    },
  };
}

const CRLF = '\r\n';

// ── Framing and timing ─────────────────────────────────────────────────────
{
  const h = harness();
  h.send('AT\r');
  const got = h.received();
  expect(got === `AT\r${CRLF}OK${CRLF}`, `echo then verbose OK, got ${show(got)}`);
  // Every RXD edge of the reply lies on a bit boundary of its frame.
  const bit = CPS / 1200;
  let start = null, bad = 0;
  for (const [c, v] of h.rxEdges) {
    if (v === 0 && (start === null || c - start >= bit * 9.5)) start = c;
    const k = (c - start) / bit;
    if (Math.abs(k - Math.round(k)) * bit > 1) bad++;
  }
  expect(bad === 0, `${bad} RXD edges off the 1200 baud bit grid`);
  expect(show(h.flagEdges) === show(h.rxEdges), 'FLAG2 follows RXD (pins B and C are tied)');
  ok('1200 baud 8N1: start bit low, LSB first, stop high, edges on the bit grid, FLAG with RXD');
}

{
  const h = harness();
  h.send('AT\r', 300);
  const got = h.received(300, 1);
  expect(got === `AT\r${CRLF}OK${CRLF}`, `autobauded to 300 from the A, got ${show(got)}`);
  expect(h.dev.state.baud === 300, `line rate now 300, got ${h.dev.state.baud}`);
  ok('autobaud: the start bit of "A" sets the line rate (300 baud)');
}

{
  const h = harness();
  h.send('AT\r', 2400);
  const got = h.received(2400);
  expect(got === `AT\r${CRLF}OK${CRLF}`, `autobauded to 2400, got ${show(got)}`);
  h.send('ATB2400\r', 2400);
  h.received(2400);
  expect(h.dev.state.baud === 2400, 'ATB2400 sets 2400 as well');
  ok('2400 baud: autobaud and ATB2400');
}

{
  const h = harness();
  h.send('x', 300);                               // not an A: its start looks 4 bits long at 1200
  h.received(300);
  expect(h.dev.state.baud === 1200, `a character that is not an A leaves the rate alone, got ${h.dev.state.baud}`);
  h.send('AT\r');
  expect(h.received().endsWith(`OK${CRLF}`), 'and AT at the old rate still works');
  ok('autobaud only adopts a rate measured on an A');
}

{
  const h = harness();
  h.send([0xC1, 0xD4, 0x0D], 1200);              // shifted PETSCII "AT"
  const got = h.received();
  expect(got.endsWith(`OK${CRLF}`), `PETSCII AT accepted, got ${show(got)}`);
  ok('commands typed in either PETSCII case are understood');
}

// ── Hayes settings ─────────────────────────────────────────────────────────
{
  const h = harness();
  h.send('ATE0\r');
  h.received();
  h.send('AT\r');
  let got = h.received();
  expect(got === `${CRLF}OK${CRLF}`, `E0: no echo, got ${show(got)}`);
  h.send('ATV0\r');
  h.received();
  h.send('AT\r');
  got = h.received();
  expect(got === '0\r', `V0: numeric OK is "0" CR, got ${show(got)}`);
  h.send('ATQ1\r');
  h.received();
  h.send('AT\r');
  got = h.received();
  expect(got === '', `Q1: no result codes, got ${show(got)}`);
  ok('E0 stops echo, V0 gives numeric results, Q1 silences them');
}

{
  const h = harness();
  h.send('ATS12?\r');
  let got = h.received();
  expect(got.includes('050'), `S12 defaults to 50 (fiftieths of a second), got ${show(got)}`);
  h.send('ATS2?\r');
  got = h.received();
  expect(got.includes('043'), `S2 defaults to 43 ("+"), got ${show(got)}`);
  h.send('ATI\r');
  got = h.received();
  expect(got.includes('C64 READY. WIFI MODEM') && got.endsWith(`OK${CRLF}`), `ATI identifies the modem, got ${show(got)}`);
  h.send('ATJ\r');
  got = h.received();
  expect(got.endsWith(`ERROR${CRLF}`), `an unknown command answers ERROR, got ${show(got)}`);
  ok('S-register queries, ATI, ERROR for an unknown command');
}

// ── Dialing ────────────────────────────────────────────────────────────────
function connected(h, cmd = 'ATD"bbs.example:6400"\r') {
  h.send(cmd);
  h.received();
  const s = h.sockets[h.sockets.length - 1];
  s.onopen();
  h.received();
  return s;
}

{
  const h = harness();
  h.send('ATD"BBS.EXAMPLE:6400"\r');
  let got = h.received();
  const s = h.sockets[0];
  expect(s && s.host === 'bbs.example' && s.port === 6400, `dials bbs.example:6400, got ${s && `${s.host}:${s.port}`}`);
  expect(!got.includes('CONNECT'), 'no CONNECT before the connection opens');
  expect((h.devPB & DCD) === 0, 'DCD low while dialing (&C1, S46=0)');
  s.onopen();
  got = h.received();
  expect(got === `${CRLF}CONNECT 1200${CRLF}`, `CONNECT with the line rate, got ${show(got)}`);
  expect((h.devPB & DCD) !== 0, 'DCD high once connected');
  s.ondata(Uint8Array.from([0x48, 0x49]));
  got = h.received();
  expect(got === 'HI', `connection data reaches the C64, got ${show(got)}`);
  h.send('x');
  expect(show(s.sent) === show([0x78]), `C64 data goes out unchanged, sent ${show(s.sent)}`);
  ok('ATD"host:port" connects, says CONNECT 1200, raises DCD, passes data both ways');
}

{
  const h = harness();
  const s = connected(h);
  h.idle(1.2);
  h.send('+++');
  h.idle(1.2);
  let got = h.received();
  expect(got === `${CRLF}OK${CRLF}`, `+++ with a second either side gives OK, got ${show(got)}`);
  expect(!h.dev.state.online && h.dev.state.connected, 'command mode, call still up');
  expect((h.devPB & DCD) !== 0, 'DCD stays high in command mode');
  h.send('ATO\r');
  got = h.received();
  expect(got.includes('CONNECT 1200') && h.dev.state.online, `ATO goes back online, got ${show(got)}`);
  h.idle(1.2);
  h.send('+++');
  h.idle(1.2);
  h.received();
  h.send('ATH\r');
  got = h.received();
  expect(got.endsWith(`OK${CRLF}`) && s.closed, 'ATH hangs up');
  expect((h.devPB & DCD) === 0, 'DCD drops after ATH');
  ok('the +++ escape with guard times, ATO back online, ATH hangs up');
}

{
  const h = harness();
  const s = connected(h);
  h.send('ab+++');
  h.idle(1.2);
  const got = h.received();
  expect(!got.includes('OK') && h.dev.state.online, `+++ right after data is data, got ${show(got)}`);
  expect(String.fromCharCode(...s.sent) === 'ab+++', 'the plus signs went to the connection');
  ok('+++ without the guard time before it stays data');
}

{
  const h = harness();
  const s = connected(h);
  s.ondata(Uint8Array.from([0x42, 0x59, 0x45]));
  s.onclose('closed');
  const got = h.received();
  expect(got === `BYE${CRLF}NO CARRIER${CRLF}`, `data first, then NO CARRIER, got ${show(got)}`);
  expect((h.devPB & DCD) === 0, 'DCD low after the far end hangs up');
  ok('the far end hanging up: data delivered, then NO CARRIER and DCD low');
}

{
  const h = harness();
  h.send('ATD"nowhere.example:23"\r');
  h.received();
  h.sockets[0].onclose('failed');
  let got = h.received();
  expect(got === `${CRLF}NO ANSWER${CRLF}`, `a failed connection is NO ANSWER, got ${show(got)}`);
  h.send('ATD"slow.example:23"\r');
  h.received();
  h.send('x');
  got = h.received();
  expect(got.includes('NO CARRIER') && h.sockets[1].closed, `a key while dialing aborts, got ${show(got)}`);
  ok('a failed dial says NO ANSWER, a key press aborts dialing');
}

{
  const h = harness();
  const s = connected(h);
  s.ondata(Uint8Array.from(new Array(40).fill(0x41)));
  s.onclose('closed');                            // carrier lost with data still going out
  h.dev.deserialize({ settings: {}, baud: 1200, connected: true, online: true });
  let got = h.received();
  expect(got === `${CRLF}NO CARRIER${CRLF}`, `a restored call says NO CARRIER once, got ${show(got)}`);
  h.send('AT\r');
  got = h.received();
  expect(got === `AT\r${CRLF}OK${CRLF}`, `nothing from before the restore follows, got ${show(got)}`);
  ok('restoring a snapshot drops everything the modem had in flight');
}

// ── Telnet ─────────────────────────────────────────────────────────────────
{
  const h = harness();
  const s = connected(h, 'ATDT"bbs.example:23"\r');
  s.ondata(Uint8Array.from([IAC, DO, 24, 0x41, IAC, IAC, IAC, WILL, 1, IAC, WILL, 5, IAC, SB, 24, 1, IAC, SE, 0x42]));
  const got = h.received();
  expect(got === 'AÿB', `negotiation stripped, IAC IAC is one 0xFF, got ${show(got)}`);
  const sent = s.sent;
  const has = (seq) => sent.join(',').includes(seq.join(','));
  expect(has([IAC, WONT, 24]), 'DO for an unsupported option answered WONT');
  expect(has([IAC, DO, 1]), 'the server\'s WILL ECHO accepted with DO');
  expect(has([IAC, DONT, 5]), 'WILL for an unsupported option answered DONT');
  s.sent.length = 0;
  h.send([0x0D, 0xFF]);
  expect(show(s.sent) === show([13, 0, IAC, IAC]), `CR goes as CR NUL, 0xFF as IAC IAC, sent ${show(s.sent)}`);
  ok('ATDT: Telnet negotiation answered, subnegotiation skipped, IAC and CR escaped');
}

{
  const h = harness();
  const s = connected(h);
  s.ondata(Uint8Array.from([IAC, DO, 24]));
  const got = h.received();
  expect(got === 'ÿý\u0018', `without T the bytes pass untouched, got ${show(got)}`);
  ok('ATD without T is a raw connection');
}

{
  const h = harness();
  const s = connected(h, 'ATDP"bbs.example:23"\r');
  s.ondata(Uint8Array.from([0x68, 0x49]));        // ASCII "hI"
  const got = h.received();
  expect(got === 'HÉ', `P: ASCII to PETSCII ("h" → $48, "I" → $C9), got ${show(got)}`);
  ok('ATDP translates the connection to PETSCII');
}

// ── Phonebook, lines, settings ─────────────────────────────────────────────
{
  const store = memStore();
  const h = harness({ storage: store });
  h.send('ATP"5551212=bbs.example:6400,Test BBS"\r');
  let got = h.received();
  expect(got.endsWith(`OK${CRLF}`), `phonebook entry added, got ${show(got)}`);
  h.send('ATDT5551212\r');
  h.received();
  const s = h.sockets[0];
  expect(s && s.host === 'bbs.example' && s.port === 6400, 'ATDT with digits dials the phonebook entry');
  expect(store.get('phonebook')?.['5551212']?.host === 'bbs.example', 'the phonebook is kept in device storage');
  ok('ATP stores a phonebook entry, ATDT<number> dials it');
}

{
  const h = harness();
  h.send('ATS46=1\r');
  h.received();
  expect((h.devPB & DCD) !== 0, 'S46=1: DCD is active low, so high while offline');
  h.send('AT&C0S46=0\r');
  h.received();
  expect((h.devPB & DCD) !== 0, '&C0: DCD always on');
  ok('S46 inverts DCD, &C0 holds it on');
}

{
  const h = harness();
  h.send('AT&K3\r');
  h.received();
  h.setPB(0xFF & ~RTS);                           // the C64 says stop
  h.send('AT\r');
  let got = h.received();
  expect(got === '', `nothing sent while RTS is low, got ${show(got)}`);
  h.setPB(0xFF);
  got = h.received();
  expect(got === `AT\r${CRLF}OK${CRLF}`, `held bytes follow once RTS is back, got ${show(got)}`);
  ok('&K3: RTS low holds the modem\'s output');
}

{
  const h = harness();
  h.send('AT&D2\r');
  h.received();
  h.setPB(0xFF);
  const s = connected(h);
  h.setPB(0xFF & ~DTR);
  const got = h.received();
  expect(got.includes('NO CARRIER') && s.closed, `&D2: dropping DTR hangs up, got ${show(got)}`);
  const h2 = harness();
  h2.setPB(0xFF);
  const s2 = connected(h2);
  h2.setPB(0xFF & ~DTR);
  expect(!s2.closed, '&D0 (default): DTR is ignored');
  ok('&D2 hangs up when DTR drops, &D0 ignores it');
}

{
  const store = memStore();
  const h = harness({ storage: store });
  h.send('ATE0&W\r');
  h.received();
  const h2 = harness({ storage: store });
  h2.send('AT\r');
  const got = h2.received();
  expect(got === `${CRLF}OK${CRLF}`, `&W kept E0 for the next power-up, got ${show(got)}`);
  h2.send('AT&F\r');
  h2.received();
  h2.send('AT\r');
  expect(h2.received().startsWith('AT\r'), '&F restores the factory echo');
  ok('&W saves the settings, &F restores the factory ones');
}

{
  const h = harness({ noNet: true });
  h.send('ATD"bbs.example:23"\r');
  const got = h.received();
  expect(got.endsWith(`NO CARRIER${CRLF}`), `no network in the host: NO CARRIER, got ${show(got)}`);
  ok('a host without openSocket cannot dial');
}

// ── The plugin is self-contained ───────────────────────────────────────────
{
  const src = fs.readFileSync(new URL('../../src/userport/devices/wifi-modem.js', import.meta.url), 'utf8');
  expect(!/^\s*import\s/m.test(src) && !/\bimport\s*\(/.test(src), 'no imports: one file, like any installed device');
  expect(meta.apiVersion === 1 && meta.id === 'builtin.wifi-modem', 'meta names API version 1');
  ok('the modem is a single self-contained plugin file');
}

console.log(failing ? `\n${failing} of ${testNo} FAILED` : `\nall ${testNo} passed`);
process.exit(failing ? 1 : 0);
