// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { scanDeviceSource } from '../userport/scan.js';

function text(tag, value, className = '') {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function findingsList(findings) {
  const box = document.createElement('div');
  box.className = 'userport-findings';
  if (!findings.length) {
    box.append(text('p', 'Nothing risky found in the code. That is not a guarantee: code can hide what it does.'));
    return box;
  }
  const list = document.createElement('ul');
  for (const finding of findings) {
    const where = finding.lines.length ? ` (line ${finding.lines.slice(0, 5).join(', ')}${finding.lines.length > 5 ? ', …' : ''})` : '';
    const item = text('li', `${finding.title}${where}: ${finding.why}.`, finding.severity);
    if (finding.addresses) item.append(text('small', finding.addresses.slice(0, 5).join('  ')));
    list.append(item);
  }
  box.append(text('strong', 'Found in the code'), list);
  return box;
}

export function createDeviceInstallReview({ info, source, origin, existing, connector, trustId }) {
  const { meta, hash, size } = info;
  const warning = document.createElement('div');
  warning.className = 'userport-warning';
  warning.setAttribute('role', 'alert');
  warning.append(text('strong', '⚠ Only install code you trust'), text('p',
    `${connector === 'iec' ? 'An IEC' : 'A user port'} plugin can access your ROMs, saved states, settings and the network. `
    + 'It is not sandboxed. Compare the SHA-256 with the author’s published hash.'));
  const rows = [
    ['Name', meta.name], ['Version', meta.version], ['Author', meta.author], ['Id', meta.id],
    ['From', origin], ['Size', `${(size / 1024).toFixed(1)} KB`], ['SHA-256', hash],
  ];
  if (existing) rows.push(['Replaces', `version ${existing.meta.version}`]);
  const facts = document.createElement('dl');
  facts.className = 'userport-facts';
  for (const [key, value] of rows) {
    if (value) facts.append(text('dt', key), text('dd', value));
  }
  const consent = document.createElement('label');
  consent.className = 'userport-consent';
  const tick = document.createElement('input');
  tick.type = 'checkbox'; tick.id = trustId;
  consent.append(tick, document.createTextNode(' I trust this file and its author'));
  const body = [warning, findingsList(scanDeviceSource(source)), facts];
  if (meta.description) body.push(text('p', meta.description));
  body.push(consent);
  return { body, tick };
}
