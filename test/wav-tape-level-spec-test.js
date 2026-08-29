// A recording whose level and centre line wander still reads.
//
// Both are taken locally rather than once for the whole recording, because a
// digitised cassette holds neither steady. Measured on a real transfer: the
// centre wandered by a twentieth of full scale inside a few milliseconds, and
// the level fell to a quarter across a weak passage. Either one alone loses
// crossings — the wave still oscillates, it just stops crossing the line the
// decoder is watching — and every lost crossing merges two pulses into one.
//
// That merge is fatal in a turbo format, where one pulse is one bit and no
// parity catches it, and it costs bytes in the KERNAL's own. So what is asserted
// here is the strict thing: one pulse out for every symbol in, with the level
// and the centre moving underneath.
import { wavToTap } from '../src/wav-tape.js';
import { repairTape } from '../src/tap-repair.js';
import { PAL_CPU_HZ } from '../src/tap-audio.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
}

const RATE = 44100;
const SAMPLES_PER_CYCLE = RATE / PAL_CPU_HZ;
const SYM = { S: 0x30 * 8, M: 0x42 * 8, L: 0x56 * 8 };

function encodeByte(sym, value) {
  sym.push('L', 'M');
  let parity = 1;
  for (let bit = 0; bit < 8; bit++) {
    const one = (value >> bit) & 1;
    parity ^= one;
    sym.push(one ? 'M' : 'S', one ? 'S' : 'M');
  }
  sym.push(parity ? 'M' : 'S', parity ? 'S' : 'M');
}

function encodeBlock(sym, payload, pilot, sync) {
  for (let i = 0; i < pilot; i++) sym.push('S');
  for (let v = sync; v >= sync - 8; v--) encodeByte(sym, v);
  let sum = 0;
  for (const b of payload) { sum ^= b; encodeByte(sym, b); }
  encodeByte(sym, sum);
  sym.push('L');
  for (let i = 0; i < 60; i++) sym.push('S');
}

function symbolsFor(name, start, body) {
  const header = new Uint8Array(192).fill(0x20);
  const end = start + body.length;
  header[0] = 0x03;
  header[1] = start & 0xFF; header[2] = start >> 8;
  header[3] = end & 0xFF;   header[4] = end >> 8;
  for (let i = 0; i < name.length; i++) header[5 + i] = name.charCodeAt(i);
  const sym = [];
  encodeBlock(sym, header, 600, 0x89);
  encodeBlock(sym, header, 200, 0x09);
  encodeBlock(sym, body, 200, 0x89);
  encodeBlock(sym, body, 200, 0x09);
  return sym;
}

/**
 * Render symbols as audio, with the tape misbehaving as an old one does.
 * @param opts.wander  how far the centre line drifts, as a share of full scale
 * @param opts.fade    how weak the quiet passage gets, as a share of full level
 */
function render(sym, { wander = 0, fade = 1 } = {}) {
  const out = [];
  for (const k of sym) {
    const total = Math.round(SYM[k] * SAMPLES_PER_CYCLE);
    const first = Math.max(1, Math.round(total / 2));
    for (let i = 0; i < total; i++) out.push(i < first ? 1 : -1);
  }
  const n = out.length;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // A dip in the middle third, and a slow drift of the centre under it all.
    const t = i / n;
    const level = (t > 0.4 && t < 0.5) ? fade : 1;
    const drift = wander * Math.sin(2 * Math.PI * 30 * i / RATE);
    samples[i] = out[i] * 0.5 * level + drift;
  }
  const b = new Uint8Array(44 + n * 2);
  const dv = new DataView(b.buffer);
  const put = (at, s) => { for (let i = 0; i < s.length; i++) b[at + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); put(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, RATE, true); dv.setUint32(28, RATE * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  put(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return b;
}

const BODY = new Uint8Array(400);
for (let i = 0; i < BODY.length; i++) BODY[i] = (i * 53 + 7) & 0xFF;
const SYMBOLS = symbolsFor('WANDER', 0x0801, BODY);

// ── A steady recording, for the count to be measured against ─────────────────
{
  const { tap, pulses } = wavToTap(render(SYMBOLS));
  assert(Math.abs(pulses - SYMBOLS.length) <= 2,
    `every symbol yields a pulse (${pulses} of ${SYMBOLS.length})`);
  assert(repairTape(tap).files[0]?.state === 'good', 'and the file reads');
}

// ── The centre wandering under a full-strength signal ────────────────────────
{
  const { tap, pulses } = wavToTap(render(SYMBOLS, { wander: 0.35 }));
  assert(Math.abs(pulses - SYMBOLS.length) <= 2,
    `a wandering centre loses no crossings (${pulses} of ${SYMBOLS.length})`);
  assert(repairTape(tap).files[0]?.state === 'good', 'and the file still reads');
}

// ── A weak passage, where a threshold set by the loud parts would not reach ──
{
  const { tap, pulses } = wavToTap(render(SYMBOLS, { fade: 0.18 }));
  assert(Math.abs(pulses - SYMBOLS.length) <= 2,
    `a quiet passage loses no crossings (${pulses} of ${SYMBOLS.length})`);
  assert(repairTape(tap).files[0]?.state === 'good', 'and the file still reads');
}

// ── Both at once, which is what the real transfers do ────────────────────────
{
  const { tap, pulses } = wavToTap(render(SYMBOLS, { wander: 0.22, fade: 0.25 }));
  assert(Math.abs(pulses - SYMBOLS.length) <= 2,
    `weak and wandering together (${pulses} of ${SYMBOLS.length})`);
  assert(repairTape(tap).files[0]?.state === 'good', 'and the file still reads');
}

if (failures) {
  console.error(`\n${failures} wav tape level assertion(s) failed`);
  process.exit(1);
}
console.log('wav tape level spec: PASS');
