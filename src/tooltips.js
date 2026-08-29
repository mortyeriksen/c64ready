// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/tooltips.js — the app's own tooltips, replacing the browser's `title`.
//
// A native tooltip cannot be called back. The browser is handed the string the
// moment the pointer arrives on a control, and from then on it decides when and
// where to draw it — including after a modal file dialog has closed, at wherever
// the pointer ended up, describing a control nowhere near it. Removing the
// attribute afterwards does not reach the browser; nor does forcing the hover
// node to change under a stationary pointer, which fires the boundary events but
// leaves the queued tooltip alone.
//
// So the browser never gets a `title` at all: every one is moved to `data-tip`
// as it appears, and the tooltip below is drawn from that. A MutationObserver
// catches the ones set later (Collapse/Expand, write-protect, directory rows),
// so `el.title = '…'` stays the way to write one.

const SHOW_MS = 2000;   // dwell before it appears — long enough to stay out of the way
const GAP_PX  = 8;      // between the control and the bubble
const EDGE_PX = 8;      // closest the bubble comes to the viewport edge

const tip = document.createElement('div');
tip.className = 'tip';
tip.setAttribute('role', 'tooltip');
tip.hidden = true;
document.body.appendChild(tip);

let anchor = null;      // the control the bubble belongs to, once shown
let pending = null;     // the one being waited on, so crossing its own children
let timer = 0;          //   does not restart the dwell

// `title` is also the accessible name of an element that has no other, so keep
// one for those (icon-only buttons, the LEDs) as we take the attribute away.
function adopt(el) {
  const text = el.getAttribute('title');
  if (text === null) return;
  el.removeAttribute('title');
  if (!text) return;
  el.dataset.tip = text;
  if (!el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') &&
      !el.textContent.trim()) {
    el.setAttribute('aria-label', text);
  }
}

function adoptTree(root) {
  if (root.nodeType !== 1) return;
  if (root.hasAttribute('title')) adopt(root);
  for (const el of root.querySelectorAll('[title]')) adopt(el);
}

adoptTree(document.body);
new MutationObserver(records => {
  for (const r of records) {
    if (r.type === 'attributes') adopt(r.target);
    else for (const node of r.addedNodes) adoptTree(node);
  }
}).observe(document.body, { subtree: true, childList: true,
                            attributes: true, attributeFilter: ['title'] });

function hide() {
  clearTimeout(timer);
  timer = 0;
  anchor = pending = null;
  tip.hidden = true;
}

function show(el) {
  const text = el.dataset.tip;
  if (!text || !el.isConnected) return;
  // Retro Vibes fullscreens its own overlay, and only that subtree is painted —
  // the bubble has to live inside whatever is fullscreen at the time.
  const host = document.fullscreenElement || document.body;
  if (tip.parentNode !== host) host.appendChild(tip);

  anchor = el;
  tip.textContent = text;
  tip.hidden = false;

  // Below the control by default, flipped above when the bubble would fall off
  // the bottom, and never past either side edge.
  const a = el.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  let top = a.bottom + GAP_PX;
  if (top + t.height > innerHeight - EDGE_PX) top = Math.max(EDGE_PX, a.top - GAP_PX - t.height);
  const left = Math.min(Math.max(EDGE_PX, a.left + (a.width - t.width) / 2),
                        innerWidth - EDGE_PX - t.width);
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

// A disabled control still gets pointer events in this UI (the panels do not
// wrap them), so its tip is offered like any other — that is where the reason
// it is disabled usually is.
const tipFor = node => (node instanceof Element ? node.closest('[data-tip]') : null);

// Entering a control starts the dwell; LEAVING it takes the tip away. Leaving
// is the rule rather than arriving somewhere else, because the pointer can go
// where nothing arrives at all — the tab bar, off the side of the window, a gap
// in a card that owns no tip. Boundary events always pair out-then-over, so a
// move between two controls hides the first before arming the second.
document.addEventListener('pointerover', e => {
  if (e.pointerType === 'touch') return;   // no hover to dwell on
  const el = tipFor(e.target);
  if (!el || el === pending) return;
  pending = el;
  timer = setTimeout(() => show(el), SHOW_MS);
}, true);

document.addEventListener('pointerout', e => {
  const el = anchor || pending;
  if (!el) return;
  if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;  // still within it
  hide();
}, true);

document.addEventListener('pointerdown', hide, true);
window.addEventListener('blur', hide);
window.addEventListener('scroll', hide, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); }, true);

// Keyboard users get the same text on focus, without the dwell.
document.addEventListener('focusin', e => {
  const el = tipFor(e.target);
  if (el && el.matches(':focus-visible')) { hide(); show(el); }
}, true);
document.addEventListener('focusout', hide, true);

// The anchor can go away or move under the bubble — a card collapsing, a dialog
// closing, the picture resizing. Drop it rather than leave it pointing at air.
new ResizeObserver(() => { if (anchor) hide(); }).observe(document.documentElement);
