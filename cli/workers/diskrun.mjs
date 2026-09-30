// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/workers/diskrun.mjs — one thread's share of `run --all`.
//
// Every program on a disk is a fresh machine already, so a thread takes one,
// boots it, and writes the PNG itself; the parent prints what came back, in
// the disk's own order.

import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { setQuiet } from '../report.mjs';
import { D64, G64, loadMachine } from '../core.mjs';
import { writePng, Apng } from '../png.mjs';
import { hostName } from '../disk.mjs';
import { runFrames, typeLoadAndRun, bootWithDisk } from '../run.mjs';

setQuiet(true);
const { bytes, kind, roms, frames, anim, fps, speed, press, outDir, stem } = workerData;
const { C64Machine, CANVAS_W, CANVAS_H } = await loadMachine();
const disk = kind === 'g64' ? new G64(bytes) : new D64(bytes);

parentPort.on('message', msg => {
  if (!msg) { parentPort.close(); return; }
  const name = msg.item;
  const m = bootWithDisk(C64Machine, roms, kind, disk);
  typeLoadAndRun(m, name);
  const film = anim ? new Apng(CANVAS_W, CANVAS_H, fps * speed) : null;
  runFrames(m, frames, film, fps, { press });
  const out = path.join(outDir, `${stem}-${hostName(name.trim())}.png`);
  if (film) film.write(out); else writePng(out, m.vic2.fb32, CANVAS_W, CANVAS_H);
  parentPort.postMessage({ index: msg.index, name: name.trim(), out });
});
