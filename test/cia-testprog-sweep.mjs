// Run the VICE CIA and interrupt testprogs and compare against a baseline.
//
//   node test/cia-testprog-sweep.mjs [--only=<substr>] [--out=<file>]
//                                    [--baseline=<file>] [--jobs=N]
//
// The program list, cycle budgets and expected outcomes come from VICE's own
// testbench/c64-testlist.in: every `exitcode` entry under CIA/ and interrupts/,
// plus Lorenz's CIA programs, that applies to an old 6526 on a PAL machine. Those programs report through
// the debug cartridge (a write to $D7FF: 0 = pass, anything else = fail).
//
// Each result also records the exact cycle the program reported on and a hash
// of the screen and colour RAM at that moment, so --baseline catches a change
// in timing or output even when the pass/fail verdict stays the same.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { C64Machine } from '../src/machine.js';
import { assetPath, readAsset, missingNote } from './external-assets.js';

const CYCLES_PER_FRAME = 19656;
const BOOT_FRAMES = 120;

function runOne(prgPath, budgetCycles) {
  const m = new C64Machine();
  m.loadROMs({ kernal: readAsset('kernal'), basic: readAsset('basic'), charRom: readAsset('chargen') });
  m.reset();
  let exit = null;
  const writeIO = m.mem._writeIO.bind(m.mem);
  m.mem._writeIO = (addr, val) => {
    if (addr === 0xD7FF && exit === null) exit = { code: val, cycle: m.sidCycleCounter };
    writeIO(addr, val);
  };
  for (let i = 0; i < BOOT_FRAMES; i++) m.runFrame();
  m.loadPRG(fs.readFileSync(prgPath));
  m.injectRun();
  const frames = Math.ceil(budgetCycles / CYCLES_PER_FRAME);
  for (let i = 0; i < frames && exit === null; i++) m.runFrame();

  const vicBank = (~m.cia2.peek(0x00) & 0x03) << 14;
  const screen = vicBank + (((m.vic2.regs[0x18] >> 4) & 0x0F) << 10);
  const hash = crypto.createHash('sha1')
    .update(m.mem.ram.subarray(screen, screen + 1000))
    .update(m.mem.colorRam.subarray(0, 1000))
    .digest('hex').slice(0, 12);
  return {
    exit: exit ? exit.code : null,
    cycle: exit ? exit.cycle : null,
    border: m.vic2.regs[0x20] & 0x0F,
    screen: hash,
  };
}

if (!isMainThread) {
  for (const job of workerData.jobs) {
    let r;
    try { r = runOne(job.prg, job.budget); } catch (err) { r = { error: err.message }; }
    parentPort.postMessage({ id: job.id, ...r });
  }
} else {
  await main();
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => {
    const hit = args.find(a => a.startsWith(`--${n}=`));
    return hit ? hit.slice(n.length + 3) : d;
  };
  const ROOT = assetPath('vice-testprogs-dir');
  if (!ROOT) {
    console.log(`# SKIP CIA testprog sweep — ${missingNote('vice-testprogs-dir')}`);
    process.exit(0);
  }

  // testlist line: <dir>,<prg>,<type>,<cycles>[,<option>...]
  const list = fs.readFileSync(path.join(ROOT, 'testbench/c64-testlist.in'), 'utf8');
  const tests = [];
  for (const line of list.split('\n')) {
    const [dir, prg, type, cycles, ...opts] = line.trim().split(',');
    const lorenzCia = dir === '../general/Lorenz-2.15/src/' && opts.includes('cia-old');
    if (!/^\.\.\/(CIA|interrupts)\//.test(dir) && !lorenzCia) continue;
    if (type !== 'exitcode' || !prg) continue;
    if (opts.some(o => o === 'cia-new' || o === 'vicii-ntsc' || o === 'vicii-ntscold')) continue;
    const id = path.join(dir.slice(3), prg);
    if (tests.some(t => t.id === id)) continue;
    tests.push({
      id,
      prg: path.join(ROOT, 'testbench', dir, prg),
      budget: +cycles,
      expectError: opts.includes('expect:error'),
    });
  }
  const ONLY = opt('only', null);
  const todo = tests.filter(t => !ONLY || t.id.includes(ONLY));

  const JOBS = Math.min(5, Math.max(1, +opt('jobs', String(Math.min(5, os.cpus().length - 1)))));
  const results = {};
  await new Promise((resolve, reject) => {
    const chunks = Array.from({ length: JOBS }, () => []);
    todo.slice().sort((a, b) => b.budget - a.budget).forEach((t, i) => chunks[i % JOBS].push(t));
    let live = 0;
    for (const jobs of chunks.filter(c => c.length)) {
      live++;
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: { jobs } });
      w.on('message', (r) => {
        const t = tests.find(x => x.id === r.id);
        let verdict;
        if (r.error) verdict = 'ERROR';
        else if (r.exit === null) verdict = 'TIMEOUT';
        else verdict = (r.exit === 0) !== t.expectError ? 'PASS' : 'FAIL';
        results[r.id] = { verdict, ...r, id: undefined };
        process.stderr.write(`${verdict.padEnd(7)} ${r.id}\n`);
      });
      w.on('error', reject);
      w.on('exit', () => { if (--live === 0) resolve(); });
    }
  });

  const ordered = Object.fromEntries(todo.map(t => [t.id, results[t.id]]));
  fs.writeFileSync(opt('out', 'investigation/cia-testprog-results.json'), JSON.stringify(ordered, null, 1) + '\n');

  const tally = {};
  for (const r of Object.values(ordered)) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
  console.log(Object.entries(tally).sort().map(([k, v]) => `${k} ${v}`).join(', ') + `, total ${todo.length}`);

  const BASE = opt('baseline', null);
  if (BASE) {
    const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
    let changed = 0;
    for (const [id, r] of Object.entries(ordered)) {
      const b = base[id];
      if (!b) continue;
      const diffs = ['verdict', 'exit', 'cycle', 'border', 'screen'].filter(k => b[k] !== r[k]);
      if (!diffs.length) continue;
      changed++;
      console.log(`CHANGED ${id}: ${diffs.map(k => `${k} ${b[k]} -> ${r[k]}`).join(', ')}`);
    }
    console.log(changed ? `${changed} changed against ${BASE}` : `no changes against ${BASE}`);
    process.exit(changed ? 1 : 0);
  }
}
