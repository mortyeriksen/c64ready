// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import { pushEscapeLayer, popEscapeLayer } from '../ui/escape-stack.js';

// Existing view-owned content stays in its section so updates keep their targets.
export function createHelpDialogs(root) {
  const entries = [], rows = new Map();
  for (const detail of root.querySelectorAll('details.monitor-help')) {
    const summary = detail.querySelector(':scope > summary');
    if (!summary) continue;
    const trigger = document.createElement('button');
    trigger.type = 'button'; trigger.className = 'monitor-help-trigger';
    trigger.setAttribute('aria-haspopup', 'dialog');
    const modal = document.createElement('dialog');
    modal.className = `monitor-help-dialog${(detail.classList.contains('monitor-evidence') || detail.classList.contains('monitor-control-inspection')) ? ' is-wide' : ''}`;
    modal.id = `monitor-help-${entries.length}`;
    trigger.setAttribute('aria-controls', modal.id);
    const header = document.createElement('header'), title = document.createElement('h2'), close = document.createElement('button');
    title.id = `${modal.id}-title`; modal.setAttribute('aria-labelledby', title.id);
    close.type = 'button'; close.className = 'monitor-help-close'; close.textContent = '×'; close.setAttribute('aria-label', 'Close dialog');
    header.append(title, close); modal.append(header);
    const parent = detail.parentElement;
    let row = rows.get(parent);
    if (!row) {
      row = document.createElement('div'); row.className = 'monitor-section-links';
      detail.before(row); rows.set(parent, row);
    }
    row.append(trigger); detail.before(modal); modal.append(detail);
    const sync = () => { trigger.textContent = summary.textContent; title.textContent = summary.textContent; trigger.hidden = detail.hidden || detail.dataset.externalTrigger === 'true'; };
    sync();
    const observer = new MutationObserver(sync); observer.observe(summary, { subtree: true, childList: true, characterData: true }); observer.observe(detail, { attributes: true, attributeFilter: ['hidden'] });
    let opener;
    const layer = { isOpen: () => modal.open, close: () => { detail.open = false; modal.close(); } };
    const open = () => { detail.open = true; if (!modal.open) { opener = document.activeElement; modal.showModal(); pushEscapeLayer(layer); close.focus(); } };
    trigger.addEventListener('click', open);
    close.addEventListener('click', layer.close);
    detail.addEventListener('toggle', () => { if (detail.open) open(); else if (modal.open) modal.close(); });
    modal.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); layer.close(); });
    modal.addEventListener('close', () => { detail.open = false; popEscapeLayer(layer); if (root.open) { if (trigger.getClientRects().length) trigger.focus(); else if (opener?.isConnected) opener.focus(); } });
    modal.addEventListener('click', event => { if (event.target !== modal) return; const b = modal.getBoundingClientRect(); if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) layer.close(); });
    entries.push({ modal, detail, layer });
  }
  return { close() { for (const { modal, detail, layer } of entries) { detail.open = false; if (modal.open) modal.close(); popEscapeLayer(layer); } } };
}
