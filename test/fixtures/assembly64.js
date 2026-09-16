// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { createPRGDisk } from '../../src/media/d64.js';

export function sampleMedia(type) {
  // 10 PRINT "MEDIA BROWSER":END
  const body = [0x19, 8, 10, 0, 0x99, 32, 34, ...new TextEncoder().encode('MEDIA BROWSER'), 34, 58, 0x80, 0, 0, 0];
  const prg = new Uint8Array([1, 8, ...body]);
  if (type === 'prg') return prg;
  if (type === 'reu') { const bytes = new Uint8Array(1024 * 1024); bytes.set([0x52, 0x45, 0x55]); return bytes; }
  if (type === 'd64') return createPRGDisk('BROWSER', prg).img;
  // An archive holding that one program: 64-byte header, one 32-byte directory
  // entry, then the program's bytes at the offset the entry names.
  if (type === 't64') {
    const bytes = new Uint8Array(96 + body.length);
    bytes.set(new TextEncoder().encode('C64 tape image file'));
    bytes[34] = 1;                                     // room for one entry
    bytes.set(new TextEncoder().encode('BROWSER SAMPLE'), 40);
    bytes[64] = 1;                                     // the entry is a file
    bytes[66] = 1; bytes[67] = 8;                      // loads at $0801
    const end = 0x0801 + body.length;
    bytes[68] = end & 0xFF; bytes[69] = end >> 8;
    bytes[72] = 96;                                    // its bytes start here
    bytes.set(new TextEncoder().encode('BROWSER PRG'), 80);
    bytes.set(Uint8Array.from(body), 96);
    return bytes;
  }
  if (type === 'tap') {
    const bytes = new Uint8Array(24);
    bytes.set(new TextEncoder().encode('C64-TAPE-RAW'));
    bytes[12] = 1; bytes[16] = 4; bytes.set([48, 66, 86, 48], 20);
    return bytes;
  }
  if (type === 'crt') {
    const bytes = new Uint8Array(64 + 16 + 8192);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode('C64 CARTRIDGE   '));
    view.setUint32(16, 64); view.setUint16(20, 0x100); bytes[24] = 0; bytes[25] = 1;
    bytes.set(new TextEncoder().encode('BROWSER SAMPLE'), 32);
    bytes.set(new TextEncoder().encode('CHIP'), 64); view.setUint32(68, 8208);
    view.setUint16(76, 0x8000); view.setUint16(78, 8192);
    bytes.set([9, 128, 9, 128, 0xc3, 0xc2, 0xcd, 0x38, 0x30, 0x4c, 9, 128], 80);
    return bytes;
  }
  return new Uint8Array([0x50, 0x53, 0x49, 0x44]);
}
export const fixturePresets = [
  { type: 'subcat', values: ['Demo', 'Game', 'Utility'] },
  { type: 'repo', values: ['Lab'] },
  { type: 'category', values: ['Samples', { aqlKey: 'demos', name: 'Demos' }] },
  { type: 'type', values: ['prg', 'd64', 'crt', 'tap', 'sid'] },
  { type: 'rating', values: ['5', '7', '9'] },
  { type: 'year', values: ['2024', '2025', '2026'] },
  { type: 'sort', values: ['name', 'date', 'rating'] },
  { type: 'order', values: ['asc', 'desc'] },
];
export const fixtureCategories = [{ id: 1, name: 'Samples', source: 'Lab' }];
export const fixtureItems = Array.from({ length: 27 }, (_, i) => ({
  id: `lab-${i}`, category: 1, name: i === 0 ? 'Media Browser — all formats' : `Sample ${String(i).padStart(2, '0')}`,
  kind: ['Demo', 'Game', 'Utility'][i % 3], source: 'Lab', year: 2024 + i % 3, rating: 5 + (i % 5),
  updated: `2026-09-${String(1 + i).padStart(2, '0')}`, group: 'C64 READY', handle: 'Lab',
  description: 'Generated lab fixture. No Assembly64 connection. The PRG prints a message; disk wraps that PRG; cartridge loops; tape contains four test pulses.',
  files: (i === 0 ? ['prg', 'd64', 'crt', 'tap', 'sid', 'reu'] : i === 1 ? ['d64', 'sid'] : i === 9 ? ['sid'] : i === 8 ? ['reu'] : [['prg', 'd64', 'crt', 'tap'][i % 4]])
    .map(type => ({ id: type, path: `browser-sample.${type}`, size: sampleMedia(type).length })),
}));

export function createFixtureTransport({ delayMs = 80 } = {}) {
  return async function transport(address, { signal } = {}) {
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delayMs);
      signal?.addEventListener('abort', abort, { once: true });
    });
    const url = new URL(address);
    const path = url.pathname;
    const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/presets')) return json(fixturePresets);
    if (path.endsWith('/categories')) return json(fixtureCategories);
    if (path.includes('/aql/')) {
      const [offset, limit] = path.split('/').slice(-2).map(Number);
      const clauses = [...(url.searchParams.get('query') || '').matchAll(/\(([a-z]+):("[^"]*"|[^)]+)\)/g)].map(([, key, value]) => [key, value.replace(/^"|"$/g, '')]);
      let items = fixtureItems.filter(item => clauses.every(([key, value]) => {
        if (key === 'sort' || key === 'order') return true;
        if (key === 'category') return value !== 'demos' || item.kind === 'Demo';
        if (key === 'rating') return item.rating >= Number(value.replace('>=', ''));
        if (key === 'type') return item.files.some(f => f.id === value);
        const field = { subcat: 'kind', repo: 'source', event: 'event' }[key] || key;
        return String(item[field] || '').toLowerCase().includes(value.toLowerCase());
      }));
      const sort = clauses.find(([key]) => key === 'sort')?.[1];
      const order = clauses.find(([key]) => key === 'order')?.[1] === 'desc' ? -1 : 1;
      if (sort) items = [...items].sort((a, b) => order * (sort === 'rating' ? a.rating - b.rating : String(a[sort === 'date' ? 'updated' : sort]).localeCompare(String(b[sort === 'date' ? 'updated' : sort]))));
      return json(items.slice(offset, offset + limit).map(item => {
        if (item.id !== 'lab-1') return item;
        const { files, ...summary } = item; return summary;
      }));
    }
    const parts = path.split('/');
    const operation = parts[3];
    const item = fixtureItems.find(item => item.id === decodeURIComponent(parts[4]));
    if (!item) return new Response('', { status: 404 });
    if (operation === 'meta') return json(item);
    if (operation === 'entries') return json({ contentEntry: item.files });
    if (operation === 'bin' && item.files.some(f => f.id === parts[6])) return new Response(sampleMedia(parts[6]));
    return new Response('', { status: 404 });
  };
}
