// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/chat/start.js — the chat's ways in: the CHAT button in the header and its
// twin on the fullscreen toolbar. The window and its connection load on first
// use, so the app neither carries them nor contacts the chat server until
// someone opens the chat. A tab that was in a room before a reload reconnects
// by itself and keeps counting unread messages.

const RESUME_KEY = 'c64emu.chat.resume';

let chat = null;
let loading = null;
let buttons = [];

function setUnread(n) {
  for (const b of buttons) {
    const badge = b.querySelector('.chat-badge');
    if (badge) { badge.textContent = n > 99 ? '99+' : String(n); badge.hidden = !n; }
    b.setAttribute('aria-label', n ? `Chat, ${n} unread` : 'Chat');
  }
}

function setOpen(open) {
  for (const b of buttons) b.setAttribute('aria-expanded', String(open));
}

function ensure() {
  if (chat) return Promise.resolve(chat);
  loading ??= import('./window.js').then(({ createChatWindow }) => {
    chat = createChatWindow({
      onUnread: setUnread,
      onOpenChange: setOpen,
      onClose: () => document.getElementById('screen')?.focus(),
    });
    return chat;
  });
  return loading;
}

export function initChat() {
  buttons = [document.getElementById('btn-chat'), document.getElementById('btn-fs-chat')].filter(Boolean);
  for (const b of buttons) {
    b.addEventListener('click', () => { ensure().then((c) => c.toggle()); });
  }
  let resume = false;
  try { resume = sessionStorage.getItem(RESUME_KEY) === '1'; } catch { /* storage blocked */ }
  if (resume) ensure().then((c) => c.resume());
}
