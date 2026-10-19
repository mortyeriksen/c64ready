// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/notify.mjs — a line to the admin's phone on every report: POSTed as
// plain text (an ntfy topic) or as a Discord webhook message. The line may
// carry a room name someone typed, so Discord is told to resolve no mentions
// (an "@everyone" room cannot ping the channel), and control characters and
// Discord's markdown are taken out.

/** A notifier for `url`, or null without one. */
export function createNotifier(url, { fetch: doFetch = globalThis.fetch, onError = () => {} } = {}) {
  if (!url) return null;
  const discord = /^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\//.test(url);
  return (text) => {
    const line = String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 500);
    const body = discord
      ? JSON.stringify({ content: line.replace(/[\\*_~`|>[\]()#@]/g, (c) => `\\${c}`), allowed_mentions: { parse: [] } })
      : line;
    doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': discord ? 'application/json' : 'text/plain; charset=utf-8' },
      body,
    }).catch((e) => onError(e));
  };
}
