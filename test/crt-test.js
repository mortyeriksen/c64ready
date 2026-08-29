// Unit test for the .CRT parser.
// Builds a synthetic CRT buffer (header + 1 CHIP packet) and asserts parsed fields.
// Also verifies rejection of bad magic and truncated packets.
//
// Usage:  node test/crt-test.js

import { parseCRT } from '../src/crt.js';

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

function writeAscii(buf, offset, str, pad = 0) {
  for (let i = 0; i < str.length; i++) buf[offset + i] = str.charCodeAt(i);
  for (let i = str.length; i < pad; i++) buf[offset + i] = 0;
}
function writeU16BE(buf, o, v) { buf[o] = (v >> 8) & 0xFF; buf[o + 1] = v & 0xFF; }
function writeU32BE(buf, o, v) {
  buf[o] = (v >>> 24) & 0xFF; buf[o + 1] = (v >>> 16) & 0xFF;
  buf[o + 2] = (v >>> 8) & 0xFF; buf[o + 3] = v & 0xFF;
}

function buildCRT({ hwType, exrom, game, name, chips }) {
  const HEADER_LEN = 0x40;
  const payloadLen = chips.reduce((s, c) => s + 16 + c.data.length, 0);
  const buf = new Uint8Array(HEADER_LEN + payloadLen);

  writeAscii(buf, 0x00, 'C64 CARTRIDGE   ');
  writeU32BE(buf, 0x10, HEADER_LEN);
  writeU16BE(buf, 0x14, 0x0100); // version
  writeU16BE(buf, 0x16, hwType);
  buf[0x18] = exrom;
  buf[0x19] = game;
  writeAscii(buf, 0x20, name, 32);

  let off = HEADER_LEN;
  for (const c of chips) {
    const pktLen = 16 + c.data.length;
    writeAscii(buf, off, 'CHIP');
    writeU32BE(buf, off + 4, pktLen);
    writeU16BE(buf, off + 8, c.type ?? 0);
    writeU16BE(buf, off + 10, c.bank ?? 0);
    writeU16BE(buf, off + 12, c.loadAddr);
    writeU16BE(buf, off + 14, c.data.length);
    buf.set(c.data, off + 16);
    off += pktLen;
  }
  return buf;
}

// Test 1: 8K generic cart, single CHIP at $8000
{
  const rom = new Uint8Array(8192);
  rom[0] = 0xAA; rom[0x1FFF] = 0x55;
  const crt = buildCRT({
    hwType: 0, exrom: 0, game: 1, name: 'TEST 8K CART',
    chips: [{ loadAddr: 0x8000, data: rom }],
  });
  const parsed = parseCRT(crt);
  assert(parsed.hwType === 0,               'hwType 8k');
  assert(parsed.exrom === 0,                'exrom 8k');
  assert(parsed.game === 1,                 'game 8k');
  assert(parsed.name === 'TEST 8K CART',    'name trimmed');
  assert(parsed.chips.length === 1,         'one chip');
  assert(parsed.chips[0].loadAddr === 0x8000, 'chip loadAddr');
  assert(parsed.chips[0].size === 8192,     'chip size');
  assert(parsed.chips[0].data[0] === 0xAA,  'chip data start');
  assert(parsed.chips[0].data[0x1FFF] === 0x55, 'chip data end');
  console.log('ok  – 8K cart parsed');
}

// Test 2: 16K cart with two CHIP packets ($8000 + $A000)
{
  const low  = new Uint8Array(8192); low[0]  = 0x11;
  const high = new Uint8Array(8192); high[0] = 0x22;
  const crt = buildCRT({
    hwType: 0, exrom: 0, game: 0, name: '16K CART',
    chips: [
      { loadAddr: 0x8000, data: low },
      { loadAddr: 0xA000, data: high },
    ],
  });
  const parsed = parseCRT(crt);
  assert(parsed.chips.length === 2,           'two chips');
  assert(parsed.chips[0].loadAddr === 0x8000, '16k chip 0');
  assert(parsed.chips[1].loadAddr === 0xA000, '16k chip 1');
  assert(parsed.chips[1].data[0] === 0x22,    '16k high start byte');
  console.log('ok  – 16K cart parsed');
}

// Test 3: bad magic should throw
{
  const crt = buildCRT({
    hwType: 0, exrom: 0, game: 1, name: 'X',
    chips: [{ loadAddr: 0x8000, data: new Uint8Array(8192) }],
  });
  crt[0] = 0x00; // corrupt magic
  let threw = false;
  try { parseCRT(crt); } catch { threw = true; }
  assert(threw, 'bad magic should throw');
  console.log('ok  – bad magic rejected');
}

// Test 4: truncated CHIP packet should throw
{
  const crt = buildCRT({
    hwType: 0, exrom: 0, game: 1, name: 'X',
    chips: [{ loadAddr: 0x8000, data: new Uint8Array(8192) }],
  });
  const truncated = crt.subarray(0, crt.length - 100);
  let threw = false;
  try { parseCRT(truncated); } catch { threw = true; }
  assert(threw, 'truncated CHIP should throw');
  console.log('ok  – truncated packet rejected');
}

// Test 5: EasyFlash (hwType=32) with 3 banks × 2 chips — parser should return them verbatim
{
  const chips = [];
  for (let bank = 0; bank < 3; bank++) {
    const lo = new Uint8Array(8192); lo[0] = 0x10 + bank;
    const hi = new Uint8Array(8192); hi[0] = 0x20 + bank;
    chips.push({ bank, loadAddr: 0x8000, data: lo });
    chips.push({ bank, loadAddr: 0xA000, data: hi });
  }
  const crt = buildCRT({ hwType: 32, exrom: 1, game: 0, name: 'EF CART', chips });
  const parsed = parseCRT(crt);
  assert(parsed.hwType === 32,         'hwType 32');
  assert(parsed.chips.length === 6,    'EF chip count');
  assert(parsed.chips[2].bank === 1,   'EF chip bank');
  assert(parsed.chips[2].data[0] === 0x11, 'EF ROML bank 1 byte');
  assert(parsed.chips[3].data[0] === 0x21, 'EF ROMH bank 1 byte');
  console.log('ok  – EasyFlash CRT parsed');
}

// Test 6: shorter than the 64-byte header — refused before any field is read
{
  let msg = '';
  try { parseCRT(new Uint8Array(40)); } catch (e) { msg = e.message; }
  assert(/too small/i.test(msg), `undersized buffer rejected with the size in the message (${msg})`);
  console.log('ok  – undersized buffer rejected');
}

// Test 7: a packet whose magic is not CHIP is refused at its offset
{
  const crt = buildCRT({
    hwType: 0, exrom: 0, game: 1, name: 'X',
    chips: [{ loadAddr: 0x8000, data: new Uint8Array(8192) }],
  });
  crt[0x40] = 0x58; // 'X' over the 'C' of CHIP
  let msg = '';
  try { parseCRT(crt); } catch (e) { msg = e.message; }
  assert(/Bad CHIP magic at offset 0x40/.test(msg), `bad CHIP magic names the offset (${msg})`);
  console.log('ok  – bad CHIP magic rejected');
}

// Test 8: a packet header cut short (fewer than 16 bytes left) is truncated, not read
{
  const crt = buildCRT({
    hwType: 0, exrom: 0, game: 1, name: 'X',
    chips: [{ loadAddr: 0x8000, data: new Uint8Array(8192) }],
  });
  const cut = crt.subarray(0, 0x40 + 8);
  let msg = '';
  try { parseCRT(cut); } catch (e) { msg = e.message; }
  assert(/Truncated CHIP packet at offset 0x40/.test(msg), `short packet header is reported as truncated (${msg})`);
  console.log('ok  – short packet header rejected');
}

console.log('\nAll CRT parser tests passed.');
