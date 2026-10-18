// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/userport/card.js – the User Port card: choose a device, plug it in or
// out, install devices from a file or a web address, and manage the installed
// ones. Devices are plugins (see docs/USERPORT-DEVICES.md), built-ins included.

import { BUILTIN_DEVICES } from './builtins.js';
import { importDeviceSource, validateDeviceModule, inspectDeviceSource, sha256Hex } from './plugins.js';
import { listInstalled, getInstalled, putInstalled, removeInstalled } from './store.js';
import { createBrowserHost, defaultRelayBase } from './host.js';
import { scanDeviceSource } from './scan.js';
import { pushEscapeLayer, popEscapeLayer } from '../ui/escape-stack.js';
import { promptDialog } from '../ui/dialogs.js';

const KEY_POWER = 'c64emu.userport';
const KEY_DEVICE = 'c64emu.userport.device';
const KEY_RELAY = 'c64emu.userport.relay';
const DEFAULT_DEVICE = 'builtin.wifi-modem';

const WARNING_TITLE = 'Only install code you trust';
const WARNING = 'A user port device is a program. It runs inside C64 READY. in this browser, with '
  + 'everything the app can reach: your ROMs, saved states, settings and the network. There is no '
  + 'sandbox. Install it only if you trust its author, and check the SHA-256 below against the one '
  + 'they publish.';

const $ = (id) => document.getElementById(id);

function readPref(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function writePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked */ }
}


function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function initUserportCard({ getMachine, safeMode = false }) {
  const ui = {
    card: $('userport-card'),
    power: $('userport-power'),
    powerEl: $('userport-power-switch'),
    select: $('userport-device'),
    panel: $('userport-panel'),
    status: $('userport-status'),
    relay: $('userport-relay'),
    install: $('btn-userport-install'),
    file: $('userport-file'),
    url: $('btn-userport-url'),
    manage: $('btn-userport-manage'),
    modal: $('userport-modal'),
    modalTitle: $('userport-modal-title'),
    modalBody: $('userport-modal-body'),
    modalActions: $('userport-modal-actions'),
    modalX: $('btn-userport-modal-x'),
  };
  if (!ui.card) return { attach() {}, detach() {}, frame() {} };

  let powered = readPref(KEY_POWER, 'off') === 'on';
  let selected = readPref(KEY_DEVICE, DEFAULT_DEVICE);
  let installed = [];                    // records from IndexedDB
  let loaded = null;                     // { id, source, mod, meta } of the selection
  let hostCtl = null;                    // host of the plugged-in device
  let pluggedInto = null;                // the machine it is plugged into
  const builtinMeta = new Map();         // built-in id -> meta, imported once
  let deviceStatus = '';
  let generation = 0;

  // ── Status line ──────────────────────────────────────────────────────────
  function showStatus(text, isError = false) {
    ui.status.textContent = text;
    ui.status.classList.toggle('error', isError);
  }

  function idleStatus() {
    if (safeMode) return showStatus('Safe mode: no device code is loaded.');
    if (!powered) return showStatus('Nothing plugged in.');
    if (!hostCtl) return showStatus('Plugged in. Waiting for the C64 to be switched on.');
    showStatus(deviceStatus || 'Plugged in.');
  }

  // ── Device list ──────────────────────────────────────────────────────────
  function sourceRecord(id) {
    const b = BUILTIN_DEVICES.find((d) => d.id === id);
    if (b) return { id, source: b.source, file: b.file, builtin: true };
    const r = installed.find((d) => d.id === id);
    return r ? { id, source: r.source, file: `${id}.js`, builtin: false, meta: r.meta } : null;
  }

  async function refreshList() {
    try { installed = await listInstalled(); } catch { installed = []; }
    const builtinNames = [];
    for (const b of BUILTIN_DEVICES) {
      const meta = await builtinMetaOf(b);
      builtinNames.push([b.id, meta ? meta.name : b.id]);
    }
    ui.select.replaceChildren();
    const group = (label, items) => {
      if (!items.length) return;
      const g = document.createElement('optgroup');
      g.label = label;
      for (const [id, name] of items) {
        const o = document.createElement('option');
        o.value = id;
        o.textContent = name;
        g.append(o);
      }
      ui.select.append(g);
    };
    group('Built in', builtinNames);
    group('Installed', installed.map((r) => [r.id, `${r.meta.name} ${r.meta.version}`]));
    if (!sourceRecord(selected)) selected = DEFAULT_DEVICE;
    ui.select.value = selected;
  }

  async function builtinMetaOf(b) {
    if (!builtinMeta.has(b.id)) {
      try { builtinMeta.set(b.id, (await importDeviceSource(b.source)).meta); } catch { builtinMeta.set(b.id, null); }
    }
    return builtinMeta.get(b.id);
  }

  // ── Plugging ─────────────────────────────────────────────────────────────
  async function load(id) {
    if (loaded && loaded.id === id) return loaded;
    const rec = sourceRecord(id);
    if (!rec) throw new Error(`No device "${id}" is installed.`);
    const mod = await importDeviceSource(rec.source);
    const meta = validateDeviceModule(mod, { allowBuiltin: rec.builtin });
    loaded = { id, source: rec.source, mod, meta };
    return loaded;
  }

  // Pull the device out of the machine it is in (so its detach() runs and it
  // can close what it opened), then drop its host and connections.
  function unplug() {
    if (pluggedInto) { try { pluggedInto.detachUserport?.(); } catch { /* machine already gone */ } }
    pluggedInto = null;
    if (hostCtl) { hostCtl.dispose(); hostCtl = null; }
    deviceStatus = '';
  }

  // A device that threw stays out, including on the next page load, so a broken
  // one cannot stop the app at every start. The card stays open on the error.
  function onDeviceError(id, err) {
    console.error(`User port device ${id} stopped:`, err);
    pluggedInto = null;
    if (hostCtl) { hostCtl.dispose(); hostCtl = null; }
    powered = false;
    ui.power.checked = false;
    writePref(KEY_POWER, 'off');
    showStatus(`${loaded?.meta.name ?? id} stopped: ${err?.message ?? err}`, true);
  }

  // Plug the loaded device into machine `m` now, synchronously.
  function plugInto(m) {
    const { meta, mod } = loaded;
    unplug();
    hostCtl = createBrowserHost({
      meta,
      panelHost: ui.panel,
      setStatus: (t) => { deviceStatus = t; if (powered) showStatus(t); },
      relayBase: currentRelay,
    });
    try {
      m.attachUserport(meta.id, (port) => mod.create(port, hostCtl.host), meta.version, onDeviceError);
      pluggedInto = m;
    } catch (err) {
      onDeviceError(meta.id, err);
      return;
    }
    idleStatus();
  }

  // Bring the machine's port in line with the switch and the selection.
  async function apply() {
    const gen = ++generation;
    const m = getMachine();
    if (!powered || safeMode || !m?.ready) {
      unplug();
      idleStatus();
      return;
    }
    if (m.userportDeviceId === selected && hostCtl) return;
    try {
      await load(selected);
    } catch (err) {
      if (gen !== generation) return;
      powered = false;
      ui.power.checked = false;
      showStatus(`Could not load the device: ${err.message}`, true);
      return;
    }
    if (gen !== generation || getMachine() !== m) return;
    plugInto(m);
  }

  // ── Card controls ────────────────────────────────────────────────────────
  // As with disk drive 9 and the RAM Expansion, the card opens when the port is
  // switched on and closes when it is switched off, and its header is the switch.
  function setExpanded(open) {
    ui.card.classList.toggle('expanded', open);
    const btn = ui.card.querySelector('.expand-btn');
    if (btn) {
      btn.setAttribute('aria-expanded', String(open));
      btn.title = open ? 'Collapse' : 'Expand';
    }
  }
  ui.power.checked = powered && !safeMode;
  ui.power.disabled = safeMode;
  setExpanded(powered && !safeMode);
  ui.powerEl?.addEventListener('click', (e) => e.stopPropagation());
  ui.power.addEventListener('change', () => {
    powered = ui.power.checked;
    writePref(KEY_POWER, powered ? 'on' : 'off');
    setExpanded(powered);
    apply();
  });
  const header = ui.card.querySelector('.panel-card-header');
  if (header && !safeMode) {
    header.classList.add('header-clickable');
    header.addEventListener('click', () => {
      ui.power.checked = !ui.power.checked;
      ui.power.dispatchEvent(new Event('change'));
    });
  }
  ui.select.addEventListener('change', () => {
    selected = ui.select.value;
    writePref(KEY_DEVICE, selected);
    loaded = null;
    unplug();
    apply();
  });

  function currentRelay() {
    const v = ui.relay.value.trim();
    return v || defaultRelayBase();
  }
  ui.relay.value = readPref(KEY_RELAY, '');
  ui.relay.placeholder = defaultRelayBase() || 'none: run c64rdy serve, or enter a relay';
  ui.relay.addEventListener('change', () => writePref(KEY_RELAY, ui.relay.value.trim()));

  // ── Modal ────────────────────────────────────────────────────────────────
  const layer = { close: () => closeModal(), isOpen: () => !ui.modal.hidden };
  function openModal(title, body, actions) {
    ui.modalTitle.textContent = title;
    ui.modalBody.replaceChildren(...body);
    ui.modalActions.replaceChildren(...actions);
    ui.modal.hidden = false;
    pushEscapeLayer(layer);
    (actions[actions.length - 1] || ui.modalX).focus();
  }
  function closeModal() {
    ui.modal.hidden = true;
    popEscapeLayer(layer);
  }
  ui.modalX.addEventListener('click', closeModal);
  ui.modal.addEventListener('click', (e) => { if (e.target === ui.modal) closeModal(); });

  function button(label, onClick, cls = '') {
    const b = document.createElement('button');
    b.className = `btn ${cls}`.trim();
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }
  function facts(rows) {
    const dl = document.createElement('dl');
    dl.className = 'userport-facts';
    for (const [k, v] of rows) {
      if (!v) continue;
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
    return dl;
  }
  function para(text, cls = '') {
    const p = document.createElement('p');
    if (cls) p.className = cls;
    p.textContent = text;
    return p;
  }

  // What the scan found, or that it found nothing (which proves nothing).
  function findingsList(findings) {
    const box = document.createElement('div');
    box.className = 'userport-findings';
    if (!findings.length) {
      box.append(para('Nothing risky found in the code. That is not a guarantee: code can hide what it does.'));
      return box;
    }
    const title = document.createElement('strong');
    title.textContent = 'Found in the code';
    const list = document.createElement('ul');
    for (const f of findings) {
      const li = document.createElement('li');
      li.className = f.severity;
      const where = f.lines.length ? ` (line ${f.lines.slice(0, 5).join(', ')}${f.lines.length > 5 ? ', …' : ''})` : '';
      li.textContent = `${f.title}${where}: ${f.why}.`;
      if (f.addresses) {
        const small = document.createElement('small');
        small.textContent = f.addresses.slice(0, 5).join('  ');
        li.append(small);
      }
      list.append(li);
    }
    box.append(title, list);
    return box;
  }

  // ── Installing ───────────────────────────────────────────────────────────
  async function offerInstall(source, origin) {
    let info;
    try {
      info = await inspectDeviceSource(source);
    } catch (err) {
      openModal('Not a user port device', [para(err.message)], [button('OK', closeModal)]);
      return;
    }
    const { meta, hash, size } = info;
    const existing = await getInstalled(meta.id).catch(() => null);
    const rows = [
      ['Name', meta.name], ['Version', meta.version], ['Author', meta.author],
      ['Id', meta.id], ['From', origin], ['Size', `${(size / 1024).toFixed(1)} KB`], ['SHA-256', hash],
    ];
    if (existing) rows.push(['Replaces', `version ${existing.meta.version}`]);
    // The warning leads, and installing waits for an explicit "I trust this".
    const warning = document.createElement('div');
    warning.className = 'userport-warning';
    warning.setAttribute('role', 'alert');
    const heading = document.createElement('strong');
    heading.textContent = `⚠ ${WARNING_TITLE}`;
    warning.append(heading, para(WARNING));
    const consent = document.createElement('label');
    consent.className = 'userport-consent';
    const tick = document.createElement('input');
    tick.type = 'checkbox';
    tick.id = 'userport-install-trust';
    consent.append(tick, document.createTextNode(' I trust this file and its author'));
    const body = [warning, findingsList(scanDeviceSource(source)), facts(rows)];
    if (meta.description) body.push(para(meta.description));
    body.push(consent);
    const go = button(existing ? 'REPLACE' : 'INSTALL', async () => {
      if (!tick.checked) return;
      closeModal();
      await install(source, meta, hash, origin);
    }, 'btn-danger');
    go.disabled = true;
    tick.addEventListener('change', () => { go.disabled = !tick.checked; });
    openModal(existing ? 'Replace device' : 'Install device', body, [button('CANCEL', closeModal), go]);
    tick.focus();
  }

  async function install(source, meta, hash, origin, { select = true } = {}) {
    await putInstalled({ id: meta.id, source, meta, hash, origin, installedAt: Date.now() });
    if (loaded && loaded.id === meta.id) loaded = null;
    await refreshList();
    if (select) {
      selected = meta.id;
      ui.select.value = selected;
      writePref(KEY_DEVICE, selected);
    }
    if (getMachine()?.userportDeviceId === meta.id || select) { unplug(); await apply(); }
    if (!powered) showStatus(`Installed ${meta.name} ${meta.version}. Switch the port on to plug it in.`);
  }

  async function installFile(file) {
    if (!/\.(m?js)$/i.test(file.name)) {
      showStatus('A user port device is a .js file.', true);
      return;
    }
    await offerInstall(await file.text(), file.name);
  }

  ui.install.addEventListener('click', () => ui.file.click());
  ui.file.addEventListener('change', async () => {
    const f = ui.file.files[0];
    ui.file.value = '';
    if (f) await installFile(f);
  });

  ui.url.addEventListener('click', async () => {
    const url = await promptDialog('Web address of the device (.js). The server must allow cross-origin requests.', {
      title: 'Install from URL', okLabel: 'FETCH', placeholder: 'https://…/device.js',
    });
    if (!url) return;
    let text;
    try {
      const res = await fetch(url.trim(), { mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      text = await res.text();
    } catch (err) {
      openModal('Could not fetch the device', [
        para(`${err.message}. The server may not allow cross-origin requests; download the file and use INSTALL… instead.`),
      ], [button('OK', closeModal)]);
      return;
    }
    await offerInstall(text, url.trim());
  });

  // Dropping a .js file on the card installs it.
  ui.card.addEventListener('dragover', (e) => {
    const item = e.dataTransfer?.items?.[0];
    if (!item || item.kind !== 'file') return;
    e.preventDefault();
    e.stopPropagation();
    ui.card.classList.add('drop-target');
  });
  ui.card.addEventListener('dragleave', () => ui.card.classList.remove('drop-target'));
  ui.card.addEventListener('drop', async (e) => {
    ui.card.classList.remove('drop-target');
    const f = e.dataTransfer?.files?.[0];
    if (!f || !/\.(m?js)$/i.test(f.name)) return;
    e.preventDefault();
    e.stopPropagation();
    await installFile(f);
  });

  // ── Managing ─────────────────────────────────────────────────────────────
  async function showManage() {
    await refreshList();
    const list = document.createElement('ul');
    list.className = 'userport-list';
    const row = (title, sub, actions) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = title;
      const small = document.createElement('small');
      small.textContent = sub;
      name.append(small);
      li.append(name, ...actions);
      list.append(li);
    };
    for (const b of BUILTIN_DEVICES) {
      const meta = await builtinMetaOf(b);
      const label = meta ? `${meta.name} ${meta.version}` : b.id;
      row(label, `Built in. Export it to start your own device.`, [
        button('EXPORT', () => download(b.file, b.source)),
      ]);
    }
    for (const r of installed) {
      const hash = r.hash || await sha256Hex(r.source);
      row(`${r.meta.name} ${r.meta.version}`, `${r.meta.id} · ${r.origin || ''} · SHA-256 ${hash.slice(0, 16)}…`, [
        button('EXPORT', () => download(`${r.meta.id}.js`, r.source)),
        button('REMOVE', async () => {
          await removeInstalled(r.id);
          if (selected === r.id) {
            selected = DEFAULT_DEVICE;
            writePref(KEY_DEVICE, selected);
            loaded = null;
            unplug();
            await apply();
          }
          showManage();
        }, 'btn-danger'),
      ]);
    }
    const body = [list];
    if (!installed.length) body.push(para('No devices installed in this browser yet. Use INSTALL… or drop a .js file on the card.'));
    openModal('User port devices', body, [button('CLOSE', closeModal)]);
  }
  ui.manage.addEventListener('click', showManage);

  // ── Served by c64rdy serve: install its --device, reload it on change ────
  async function syncDevServer() {
    if (!defaultRelayBase() || safeMode) return;     // only when served on this machine
    let info;
    try {
      const res = await fetch('/__c64rdy/info', { cache: 'no-store' });
      if (!res.ok) return;
      info = await res.json();
    } catch { return; }
    if (!info.device) return;
    const pull = async () => {
      try {
        const src = await (await fetch(info.device, { cache: 'no-store' })).text();
        const { meta, hash } = await inspectDeviceSource(src);
        const had = installed.find((r) => r.id === meta.id);
        if (had && had.hash === hash) return;
        await install(src, meta, hash, 'c64rdy serve --device');
        if (!powered) { powered = true; ui.power.checked = true; writePref(KEY_POWER, 'on'); setExpanded(true); await apply(); }
        showStatus(`${meta.name} ${meta.version} loaded from c64rdy serve.`);
      } catch (err) {
        showStatus(`c64rdy serve --device: ${err.message}`, true);
      }
    };
    await pull();
    if (info.events && typeof EventSource !== 'undefined') {
      const es = new EventSource(info.events);
      es.addEventListener('device', pull);
    }
  }

  refreshList().then(() => { idleStatus(); syncDevServer(); });

  return {
    // A new machine was built (power on, reset, state load). Plugs the device in
    // synchronously when it is already loaded, so a restored snapshot finds it.
    attach(m) {
      if (!powered || safeMode || !m) { unplug(); idleStatus(); return; }
      if (loaded && loaded.id === selected) plugInto(m);
      else { unplug(); apply(); }
    },
    // The machine is going away (POWER OFF): the device comes out with it.
    detach() {
      unplug();
      idleStatus();
    },
    // Once per displayed frame: the device's DOM work, and snapshot notes.
    frame() {
      const m = getMachine();
      const mismatch = m?.takeUserportRestoreMismatch?.();
      if (mismatch) showStatus(`This snapshot was saved with the device "${mismatch}" on the user port. Its state was not restored.`, true);
      if (!hostCtl) return;
      try {
        hostCtl.frame();
      } catch (err) {
        unplug();
        onDeviceError(loaded?.id ?? selected, err);
      }
    },
  };
}
