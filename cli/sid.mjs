// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, inputFiles, countFlag, positiveFlag, UsageError } from './args.mjs';
import { parseSid, sidToPrg, loadMachine, loadSidEngine, pcmToWav, PAL_CPU_HZ } from './core.mjs';
import { resolveRoms } from './roms.mjs';
import { outFileFor, oneOutputOnly, writeOut } from './tape.mjs';
import { say, fail, progress, progressDone } from './report.mjs';

const outputFlags = { out: { value: true, alias: 'o' }, 'out-dir': { value: true }, song: { value: true } };

function songFor(tune, song) {
  if (song !== undefined && song > tune.songs) throw new Error(`song ${song} is out of range; this tune has ${tune.songs}`);
  return song ?? tune.startSong;
}

export function sid2prg(argv) {
  const { args, flags } = parseArgs(argv, outputFlags);
  if (!args.length) throw new UsageError('Usage: c64rdy sid2prg <in.sid…> [-o out.prg] [--song <n>]');
  const files = inputFiles(args), song = countFlag(flags, 'song');
  oneOutputOnly(flags, files.length);
  let failed = false;
  for (const file of files) {
    try {
      const bytes = fs.readFileSync(file), tune = parseSid(bytes);
      const selected = songFor(tune, song);
      const { data } = sidToPrg(bytes, { song: selected });
      const out = outFileFor(file, '.prg', flags, files.length);
      writeOut(out, data, flags);
      say(`${path.basename(file)} → ${out}  (player included, song ${selected}/${tune.songs})`);
    } catch (e) { fail(`${file}: ${e.message}`); failed = true; }
  }
  return failed ? 1 : 0;
}

function audioTune(bytes, song) {
  const tune = parseSid(bytes);
  songFor(tune, song);
  if (tune.format === 'RSID' && (tune.flags & 2)) throw new Error('BASIC RSID tunes are not supported by the music player');
  if (tune.flags & 1) throw new Error('MUS tunes are not supported by the music player');
  if ((tune.version >= 3 && bytes[0x7A]) || (tune.version >= 4 && bytes[0x7B])) {
    throw new Error('multi-SID tunes require more than the single SID this renderer models');
  }
  return tune;
}

/** Render cycle-stamped SID writes offline; each callback receives reusable LE PCM bytes. */
export async function renderSid(bytes, { song, seconds = 180, sampleRate = 44100, model, roms, onBlock, onProgress } = {}) {
  const tune = audioTune(bytes, song);
  const selected = songFor(tune, song);
  const chip = model ?? (tune.chip === 1 ? '6581' : '8580');
  const { data } = sidToPrg(bytes, { song: selected, safe: true });
  const { C64Machine } = await loadMachine();
  const machine = new C64Machine();
  machine.setSidModel(chip === '8580');
  machine.loadROMs(roms);
  for (let i = 0; i < 200; i++) machine.runFrame();

  const engine = await loadSidEngine();
  engine.sid_init(sampleRate, chip === '8580' ? 1 : 0);
  for (let r = 0; r < 25; r++) engine.sid_write(r, machine.mem.sid.regs[r]);
  const pcm = Buffer.from(engine.memory.buffer, engine.sid_out_ptr(), 512 * 2);
  const origin = machine.sidCycleCounter;
  let read = Atomics.load(machine.sidCtrl, 0);
  Atomics.store(machine.sidCtrl, 1, read);
  machine.loadPRG(data);
  machine.injectRun();

  const samples = Math.floor(seconds * sampleRate);
  // The engine's resampler uses a 16.16 cycle step. Keep the producer ahead
  // of precisely that clock, without real-time drift correction or dropped writes.
  const step = Math.round(PAL_CPU_HZ / sampleRate * 65536);
  const mask = machine.sidRing32.length / 2 - 1;
  let emulated = 0, done = 0, reported = -1;
  while (done < samples) {
    const n = Math.min(512, samples - done);
    const needed = Math.floor((done + n) * step / 65536);
    while (emulated < needed) {
      const before = machine.sidCycleCounter;
      machine.runFrame();
      emulated += (machine.sidCycleCounter - before) >>> 0;
      const written = Atomics.load(machine.sidCtrl, 0);
      if (((written - read) & 0x7FFFFFFF) > mask + 1) throw new Error('SID event buffer overflow');
      while (read !== written) {
        const offset = (read & mask) * 2, packed = machine.sidRing32[offset + 1];
        engine.sid_queue_write((machine.sidRing32[offset] - origin) >>> 0, packed & 31, (packed >>> 8) & 255);
        read = (read + 1) & 0x7FFFFFFF;
      }
      Atomics.store(machine.sidCtrl, 1, read);
    }
    if (engine.sid_render(n) !== n) throw new Error('SID engine returned an incomplete audio block');
    onBlock(pcm, n * 2);
    done += n;
    const elapsed = Math.floor(done / sampleRate);
    if (elapsed !== reported) { onProgress?.(done / samples); reported = elapsed; }
  }
  onProgress?.(1);
  return { tune, song: selected, model: chip, samples, sampleRate };
}

export async function sid2wav(argv) {
  const { args, flags } = parseArgs(argv, {
    ...outputFlags, seconds: { value: true }, 'sample-rate': { value: true },
    model: { value: true }, roms: { value: true },
  });
  if (!args.length) throw new UsageError('Usage: c64rdy sid2wav <in.sid…> [-o out.wav] [--seconds <n>] [--song <n>]');
  const files = inputFiles(args), song = countFlag(flags, 'song');
  oneOutputOnly(flags, files.length);
  const seconds = positiveFlag(flags, 'seconds') ?? 180;
  const sampleRate = countFlag(flags, 'sample-rate') ?? 44100;
  if (sampleRate < 8000 || sampleRate > 96000) throw new UsageError('--sample-rate must be between 8000 and 96000 Hz');
  const samples = Math.floor(seconds * sampleRate);
  if (samples < 1 || samples * 2 > 0xFFFFFFFF - 36) throw new UsageError('--seconds must produce at least one sample and fit a RIFF WAV file');
  const model = flags.model;
  if (model !== undefined && model !== '6581' && model !== '8580') throw new UsageError('--model must be 6581 or 8580');
  let failed = false;
  for (const file of files) {
    let temporary, fd;
    try {
      const bytes = fs.readFileSync(file), tune = audioTune(bytes, song);
      // Validate that the shared player fits before booting or creating output.
      sidToPrg(bytes, { song, safe: true });
      const out = outFileFor(file, '.wav', flags, files.length);
      if (!flags.force && fs.existsSync(out)) throw new Error(`${path.basename(out)} is already there; --force writes over it`);
      const roms = resolveRoms({ dir: flags.roms });
      temporary = fs.mkdtempSync(path.join(path.dirname(out), '.c64rdy-sid-'));
      const tempFile = path.join(temporary, 'audio.wav');
      fd = fs.openSync(tempFile, 'wx');
      const header = Buffer.from(pcmToWav(new Float32Array(0), sampleRate));
      header.writeUInt32LE(36 + samples * 2, 4); header.writeUInt32LE(samples * 2, 40);
      fs.writeSync(fd, header);
      say(`${path.basename(file)}: rendering ${seconds}s of PAL audio${tune.clock === 2 ? ' (this tune requests NTSC)' : ''}`);
      const result = await renderSid(bytes, {
        song, seconds, sampleRate, model, roms,
        onBlock: (pcm, length) => {
          let at = 0;
          while (at < length) at += fs.writeSync(fd, pcm, at, length - at);
        },
        onProgress: value => progress('Rendering SID', value),
      });
      fs.closeSync(fd); fd = undefined;
      if (flags.force) fs.renameSync(tempFile, out);
      else fs.linkSync(tempFile, out);
      progressDone();
      say(`${path.basename(file)} → ${out}  (${sampleRate} Hz, 16-bit mono, ${result.model}, song ${result.song}/${tune.songs})`);
    } catch (e) { progressDone(); fail(`${file}: ${e.message}`); failed = true; }
    finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  return failed ? 1 : 0;
}
