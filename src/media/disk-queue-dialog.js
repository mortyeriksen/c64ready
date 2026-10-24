// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { el, button, createDialog } from '../assembly64/dom.js';

export function createDiskQueueView(queue, { nextButton, queueButton, notify }) {
  let dialog = null, dragged = null;
  async function act(operation, focusId, action) {
    try { await operation(); }
    catch (error) { notify(error.message, 'error'); }
    if (dialog && focusId) {
      const row = [...dialog.body.querySelectorAll('[data-queue-id]')].find(n => n.dataset.queueId === focusId);
      (row?.querySelector(`[data-action="${action}"]:not(:disabled)`) || row?.querySelector('button:not(:disabled)') || dialog.card).focus();
    }
  }
  function render() {
    const state = queue.state;
    nextButton.disabled = state.busy || !state.next;
    nextButton.textContent = state.index < 0 ? 'INSERT FIRST' : 'NEXT DISK';
    nextButton.title = `${state.next ? `Insert ${state.next}` : 'No next disk'} (⌘ Shift 8 / Ctrl Shift 8)`;
    queueButton.textContent = `QUEUE (${state.entries.length})`;
    if (!dialog) return;
    const list = el('ol', null, { class: 'disk-queue-list' });
    for (const [index, entry] of state.entries.entries()) {
      const row = el('li', null, { class: `disk-queue-row${entry.current ? ' is-current' : ''}`, 'data-queue-id': entry.id });
      const handle = el('span', '⠿', { class: 'disk-queue-handle', title: 'Drag to reorder', draggable: !state.busy, 'aria-hidden': true });
      handle.addEventListener('dragstart', event => {
        if (queue.state.busy) { event.preventDefault(); return; }
        dragged = entry.id;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', entry.id);
        const rect = row.getBoundingClientRect();
        event.dataTransfer.setDragImage(row, event.clientX - rect.left, event.clientY - rect.top);
      });
      handle.addEventListener('dragend', () => { dragged = null; });
      row.addEventListener('dragover', event => {
        if (dragged && !queue.state.busy) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
      });
      row.addEventListener('drop', event => {
        if (!dragged || queue.state.busy) return;
        event.preventDefault(); event.stopPropagation();
        const id = dragged; dragged = null;
        void act(() => queue.move(id, index), id, 'up');
      });
      const name = el('span', `${index + 1}. ${entry.name}${entry.current ? ' (inserted)' : ''}`, { class: 'disk-queue-name' });
      const controls = el('div', null, { class: 'disk-queue-actions' });
      const add = (label, action, operation, disabled = false) => {
        const b = button(label, () => void act(operation, entry.id, action), { 'data-action': action, 'aria-label': `${{ up: 'Move up', down: 'Move down', insert: 'Insert', remove: 'Remove' }[action]} ${entry.name}` });
        b.disabled = state.busy || disabled;
        controls.append(b);
      };
      add('↑', 'up', () => queue.move(entry.id, index - 1), index === 0);
      add('↓', 'down', () => queue.move(entry.id, index + 1), index === state.entries.length - 1);
      add('INSERT', 'insert', () => queue.insert(entry.id), entry.current);
      add('REMOVE', 'remove', () => queue.remove(entry.id));
      row.append(handle, name, controls); list.append(row);
    }
    const note = el('p', state.error || 'Drag the grip or use ↑ / ↓ to reorder. Removing a disk from the queue does not eject it.', { class: 'disk-queue-note', role: 'status' });
    const repeat = el('input', null, { type: 'checkbox' });
    repeat.checked = state.loop; repeat.disabled = state.busy;
    repeat.addEventListener('change', () => void act(() => queue.setLoop(repeat.checked)));
    const label = el('label', ' Loop queue'); label.prepend(repeat);
    const clear = button('CLEAR QUEUE', () => void act(() => queue.clear()));
    clear.disabled = state.busy || !state.entries.length;
    const footer = el('div', null, { class: 'disk-queue-footer' }); footer.append(label, clear);
    dialog.body.replaceChildren(note);
    if (!state.entries.length) dialog.body.append(el('p', 'Click QUEUE beside a disk in Assembly64 or Library to add it here.'));
    dialog.body.append(list, footer);
  }
  queueButton.addEventListener('click', () => {
    if (dialog) { dialog.card.focus(); return; }
    dialog = createDialog('Drive 8 disk queue', () => { dialog = null; dragged = null; });
    dialog.card.classList.add('disk-queue-dialog');
    render();
  });
  nextButton.addEventListener('click', () => void act(() => queue.next()));
  render();
  return { render };
}
