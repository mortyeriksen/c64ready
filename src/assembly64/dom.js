// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { pushEscapeLayer, popEscapeLayer } from '../escape-stack.js';

export function el(tag, text, attrs = {}) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  for (const [key, value] of Object.entries(attrs)) {
    if (value != null) node.setAttribute(key, String(value));
  }
  return node;
}
export function button(label, action, attrs = {}) {
  const node = el('button', label, { type: 'button', class: 'btn', ...attrs });
  if (action) node.addEventListener('click', action);
  return node;
}
export function renderField(definition, value, change) {
  const label = el('label', definition.hideLabel ? null : definition.label, { class: 'mb-field' });
  let input;
  if (definition.type === 'select') {
    input = el('select', null, { 'aria-label': definition.label });
    if (definition.allowEmpty !== false) input.append(el('option', definition.emptyLabel || 'Any', { value: '' }));
    for (const option of definition.options || []) input.append(el('option', option.label, { value: option.value }));
    input.value = value || '';
  } else if (['text', 'checkbox'].includes(definition.type)) {
    input = el('input', null, { type: definition.type, 'aria-label': definition.label, maxlength: 200 });
    if (definition.type === 'checkbox') input.checked = !!value;
    else input.value = value ?? '';
  } else throw new Error('Unsupported filter control.');
  input.addEventListener('change', () => change(input.type === 'checkbox' ? input.checked : input.value));
  if (definition.type === 'text') input.addEventListener('input', () => change(input.value));
  label.append(input);
  return label;
}
let dialogId = 0;
const dialogStack = [];
const dialogClosers = new Map();
export function closeAssembly64Dialogs() {
  for (const close of [...dialogClosers.values()].reverse()) close();
}
export function createDialog(title, onClose = () => {}) {
  const previous = document.activeElement;
  const parent = dialogStack.at(-1);
  if (parent) parent.inert = true;
  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  const overlay = el('div', null, { class: 'modal-overlay mb-overlay' });
  const card = el('div', null, { class: 'modal-card mb-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': `mb-title-${++dialogId}`, tabindex: -1 });
  const heading = el('h2', title, { id: `mb-title-${dialogId}` });
  const body = el('div', null, { class: 'mb-dialog-body' });
  const controller = new AbortController();
  let closed = false;
  const layer = { close, isOpen: () => !closed };
  function close() {
    if (closed) return;
    closed = true;
    controller.abort();
    popEscapeLayer(layer);
    dialogStack.splice(dialogStack.indexOf(overlay), 1);
    dialogClosers.delete(overlay);
    document.removeEventListener('keydown', keyboard, true);
    overlay.remove();
    if (parent) parent.inert = false;
    document.body.style.overflow = previousOverflow;
    onClose();
    if (previous?.isConnected) previous.focus();
  }
  function keyboard(event) {
    if (dialogStack.at(-1) !== overlay) return;
    if (document.querySelector('.modal-backdrop:not([hidden])')) return;
    if (event.key === 'Escape') return;
    const target = event.target;
    const editing = target.matches('input, textarea') || target.isContentEditable;
    if (event.code === 'Space' && !editing) {
      event.preventDefault();
      return;
    }
    event.stopImmediatePropagation();
    if (event.key === 'Tab') {
      const focusable = [...card.querySelectorAll('button, input, select, a[href], [tabindex="0"]')].filter(n => !n.disabled && !n.hidden && n.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (!first) { event.preventDefault(); card.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
  }
  const closeButton = button('✕', close, { class: 'btn mb-close', 'aria-label': `Close ${title}` });
  card.append(heading, closeButton, body);
  overlay.append(card); document.body.append(overlay);
  dialogStack.push(overlay); pushEscapeLayer(layer);
  dialogClosers.set(overlay, close);
  document.addEventListener('keydown', keyboard, true);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  card.focus();
  return {
    body, card, close, signal: controller.signal,
    setTitle(value) { heading.textContent = value; closeButton.setAttribute('aria-label', `Close ${value}`); },
    get closed() { return closed; },
  };
}
