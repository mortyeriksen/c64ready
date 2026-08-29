// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Render a PRG to a PNG of the emulator framebuffer (raw dump): boots the KERNAL,
// injects + runs the PRG, grabs frame N. For a VICE RGB compare, switch the
// renderer to Pepto first (see AGENTS.md).
//   node tools/render-prg.mjs <prg> <out.png> [frames]
import fs from 'fs';
import { C64Machine } from '../src/machine.js';
import { CANVAS_W, CANVAS_H } from '../src/vic2.js';
import { PNG } from 'pngjs';
const prgPath = process.argv[2];
const out = process.argv[3];
const frames = +(process.argv[4] || 120);
const m = new C64Machine();
m.loadROMs({kernal:fs.readFileSync('roms/kernal.bin'),basic:fs.readFileSync('roms/basic.bin'),charRom:fs.readFileSync('roms/chargen.bin')});
m.reset(); for(let i=0;i<200;i++)m.runFrame();
m.loadPRG(fs.readFileSync(prgPath)); m.injectRun();
for(let i=0;i<frames;i++)m.runFrame();
const png=new PNG({width:CANVAS_W,height:CANVAS_H}); png.data.set(m.vic2.frameBuffer);
fs.writeFileSync(out,PNG.sync.write(png));
process.stderr.write(`wrote ${out}\n`);
