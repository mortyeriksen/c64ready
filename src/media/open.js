// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { D64, d64Variant, prgOverflow } from './d64.js';
import { parseCRT } from './crt.js';
import { createCartridgeFromCRT } from '../cartridges/registry.js';
import { Datasette } from '../datasette.js';
import { REU_MODELS } from '../reu.js';
import { MAX_DOWNLOAD_BYTES, allowedActions, safeFilename } from './formats.js';
import { sourceMetadata } from './source-metadata.js';
import { isT64 } from './t64.js';

export function validateMedia(bytes, type) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('The media file is empty.');
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error('Media exceeds the 32 MiB limit.');
  if (type === 'prg') {
    if (bytes.length < 3 || prgOverflow(bytes)) throw new Error('Invalid PRG address or size.');
  } else if (type === 'd64') {
    if (!d64Variant(bytes.length)) throw new Error('Unsupported D64 size.');
    return new D64(bytes);
  } else if (type === 'crt') {
    if (bytes.length < 64) throw new Error('Truncated CRT header.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = view.getUint32(16);
    if (header < 64 || header >= bytes.length) throw new Error('Invalid CRT header length.');
    for (let at = header; at < bytes.length;) {
      if (at + 16 > bytes.length) throw new Error('Truncated CRT CHIP header.');
      const size = view.getUint32(at + 4);
      if (size < 16 || at + size > bytes.length || view.getUint16(at + 14) !== size - 16) throw new Error('Invalid CRT CHIP length.');
      at += size;
    }
    createCartridgeFromCRT(parseCRT(bytes));
  } else if (type === 'tap') {
    if (bytes.length < 20) throw new Error('Truncated TAP header.');
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16, true);
    if (size !== bytes.length - 20) throw new Error('TAP payload length does not match its header.');
    if (bytes[12] > 0) {
      for (let at = 20; at < bytes.length; at++) {
        if (bytes[at] === 0) {
          if (at + 3 >= bytes.length) throw new Error('Truncated TAP pulse.');
          at += 3;
        }
      }
    }
    new Datasette().loadTap(bytes);
  } else if (type === 'reu') {
    if (bytes.length > Math.max(...REU_MODELS.map(model => model.kb)) * 1024) throw new Error('REU image exceeds the supported RAM Expansion capacity.');
  } else if (type === 't64') {
    // The directory is read when a program is taken out of the archive; what is
    // checked here is that this is an archive at all, so a mislabelled file is
    // refused before it ever reaches the Library.
    if (!isT64(bytes)) throw new Error('This is not a .t64 archive.');
  } else throw new Error('This media format is not supported by the emulator.');
  return null;
}

export function createOpenMedia(port) {
  let busy = false;
  return async function openMedia(request) {
    if (busy) throw new Error('Another media operation is in progress.');
    busy = true;
    try {
      const { bytes, mediaType, action = 'run', targetDrive = 8, writeProtected = true, saveToLibrary = true, signal } = request;
      signal?.throwIfAborted();
      if (!allowedActions(mediaType).includes(action) || !['run', 'mount', 'save'].includes(action)) throw new Error('Unsupported media action.');
      if (![8, 9].includes(targetDrive)) throw new Error('Choose drive 8 or 9.');
      const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes).slice() : bytes?.slice();
      const name = safeFilename(request.name);
      // An archive is kept whole and opened on the way to the loader. The
      // Library holds the .t64 itself — it is the file the person picked and the
      // file Assembly64 lists, so a release's own entry still matches what was
      // saved, and a later replay may take a different program out of it. Only
      // running needs one program: saving asks nothing, because nothing is about
      // to run.
      let load = { data, type: mediaType, name };
      if (mediaType === 't64' && action !== 'save') {
        const program = await port.archive(data, name, { signal });
        if (!program) return { message: 'Archive selection cancelled.', saved: false, name, mediaType };
        load = { data: program.data, type: 'prg', name: safeFilename(program.name) };
      }
      signal?.throwIfAborted();
      const disk = validateMedia(load.data, load.type);
      const autorun = mediaType !== 'reu' && action !== 'mount' && (request.autorun ?? port.getAutorunEnabled());
      let message = 'Saved to Library';
      if (action !== 'save') {
        if (!port.isRunning() && !(await port.powerOn())) throw new Error('Load the required ROMs in Setup before opening media.');
        signal?.throwIfAborted();
        if (load.type === 'd64') {
          await port.prepareDisk?.({ targetDrive, signal });
          signal?.throwIfAborted();
          disk._libName = load.name;
          disk.writeProtected = !!writeProtected;
          await port.disk(disk, { targetDrive, autorun });
          message = `Mounted in drive ${targetDrive}${autorun ? ' — autorun queued' : ''}`;
        } else {
          await port[load.type](load.data, load.name, { autorun });
          message = { prg: 'PRG loaded', crt: 'Cartridge started', tap: 'Tape loaded', reu: 'Loaded into RAM Expansion' }[load.type];
        }
      }
      let saved = false;
      if (saveToLibrary || action === 'save') saved = await port.save(mediaType, name, data, sourceMetadata(request.metadata));
      if (action === 'save' && !saved) throw new Error('Could not save to Library. Check browser storage space.');
      if (saveToLibrary && !saved) message += ' — Library save failed; check browser storage space';
      return { message, saved, name, mediaType };
    } finally { busy = false; }
  };
}
