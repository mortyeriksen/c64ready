// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import path from 'node:path';
import fs from 'node:fs';
import { validIecAddress } from '../src/iec.js';
import { UsageError } from './args.mjs';
import { loadDeviceFile } from './devices.mjs';
import { createNodeHost } from './userport.mjs';
import { writeOut } from './tape.mjs';

export function parseIecSpecs(values = [], flag = 'iec') {
  const used = new Set();
  return values.map(value => {
    const match = /^(\d+):(.+)$/.exec(value);
    const address = match ? Number(match[1]) : NaN;
    if (!validIecAddress(address)) throw new UsageError(`--${flag} needs ADDRESS:FILE, with address 4 to 30 excluding drives 8 and 9`);
    if (flag === 'iec' && used.has(address)) throw new UsageError(`--${flag}: IEC address ${address} is repeated`);
    used.add(address);
    return { address, file: match[2] };
  });
}

export async function plugIecDevices(machine, specs) {
  const records = [];
  function dispose() {
    for (const record of records) { machine.detachIecDevice(record.address); record.host.dispose(); }
  }
  function failed(address, id, error) {
    const record = records.find(r => r.address === address);
    if (record) { record.failure = error; record.host.dispose(); }
  }
  try {
    for (const spec of specs) {
      const { mod, meta } = await loadDeviceFile(spec.file, { bus: 'iec' });
      const host = createNodeHost(meta);
      const record = { ...spec, meta, host, failure: null, device: null };
      records.push(record);
      record.device = machine.attachIecDevice(spec.address, meta.id, port => mod.create(port, host.host), meta.version);
      machine.iec.onError = failed;
    }
  } catch (error) { dispose(); throw error; }
  return {
    records, dispose,
    frame() {
      for (const record of records) if (!record.failure) {
        try { record.host.frame(); }
        catch (error) { failed(record.address, record.meta.id, error); machine.detachIecDevice(record.address); }
      }
    },
    check() {
      const failed = records.find(record => record.failure);
      if (failed) throw new Error(`IEC ${failed.address} (${failed.meta.name}) stopped: ${failed.failure.message}`);
    },
    writeOutputs(outputs, flags) {
      this.check();
      for (const output of outputs) {
        const record = records.find(r => r.address === output.address);
        const format = path.extname(output.file).slice(1).toLowerCase();
        const data = record.device.exportOutput(format);
        if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw new Error(`IEC ${output.address} exportOutput must return text or bytes`);
        writeOut(output.file, typeof data === 'string' ? Buffer.from(data) : data, flags);
      }
    },
    validateOutputs(outputs, flags = {}, screenshot = null) {
      const taken = new Set();
      for (const output of outputs) {
        const record = records.find(r => r.address === output.address);
        if (!record) throw new UsageError(`--iec-output: no IEC device at ${output.address}`);
        if (typeof record.device.exportOutput !== 'function') throw new UsageError(`IEC ${output.address} (${record.meta.name}) does not export output`);
        if (!/\.(svg|html)$/i.test(output.file)) throw new UsageError('--iec-output needs an .svg or .html file');
        const target = path.resolve(output.file);
        if (screenshot && target === path.resolve(screenshot)) throw new UsageError('--iec-output must differ from the screenshot file');
        if (taken.has(target)) throw new UsageError('--iec-output files must be distinct');
        taken.add(target);
        if (!flags.force && fs.existsSync(target)) throw new Error(`${output.file} already exists, use --force to overwrite it`);
      }
    },
  };
}
